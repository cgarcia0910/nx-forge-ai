/**
 * scan-entities.ts
 *
 * DETERMINISTA. No toma decisiones de negocio ni "adivina" relaciones
 * finales. Solo extrae hechos objetivos del AST de las entities TypeORM
 * existentes y calcula señales superficiales por convención de nombre.
 *
 * Mismo directorio de entities + misma descripción de texto de entrada
 * => mismo analysis-report.json, siempre (salvo timestamp de generatedAt).
 *
 * Uso:
 *   npx ts-node scan-entities.ts \
 *     --entities-dir=src/**\/*.entity.ts \
 *     --new-entity-desc="Order: id uuid, total number, status string, userId relacionado a User" \
 *     --output=/tmp/analysis-report.json
 */

import { Project, ClassDeclaration, Decorator, SyntaxKind } from "ts-morph";
import * as fs from "fs";
import * as path from "path";

interface Column {
  name: string;
  tsType: string;
  decorators: string[];
  isPrimary?: boolean;
  isUnique?: boolean;
  isNullable?: boolean;
}

interface ExistingRelation {
  type: "OneToOne" | "OneToMany" | "ManyToOne" | "ManyToMany";
  target: string;
  propertyName: string;
}

interface EntityInfo {
  name: string;
  filePath: string;
  tableName: string;
  columns: Column[];
  existingRelations: ExistingRelation[];
  detectedAuthGuards: string[];
}

interface RelationshipSignal {
  fromEntity: string;
  toEntity: string;
  signalType:
    | "fk-naming-convention"
    | "unique-fk-column"
    | "pivot-table-detected"
    | "entity-name-in-field";
  evidence: string;
  confidence: number;
  suggestedType: ExistingRelation["type"] | null;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const out: Record<string, string> = {};
  for (const a of args) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  if (!out["entities-dir"] || !out["output"]) {
    console.error(
      "Uso: scan-entities.ts --entities-dir=<glob> --output=<file> [--new-entity-desc=<texto>]"
    );
    process.exit(1);
  }
  return out;
}

function getRelationDecoratorType(dec: Decorator): ExistingRelation["type"] | null {
  const name = dec.getName();
  if (["OneToOne", "OneToMany", "ManyToOne", "ManyToMany"].includes(name)) {
    return name as ExistingRelation["type"];
  }
  return null;
}

function getDecoratorFirstStringArg(dec: Decorator): string | null {
  const args = dec.getArguments();
  for (const arg of args) {
    // target suele venir como arrow function: () => Target
    if (arg.getKind() === SyntaxKind.ArrowFunction) {
      const text = arg.getText().replace(/^\(\)\s*=>\s*/, "").trim();
      return text;
    }
  }
  return null;
}

function extractEntity(cls: ClassDeclaration, filePath: string): EntityInfo | null {
  const entityDecorator = cls.getDecorator("Entity");
  if (!entityDecorator) return null;

  const name = cls.getName() ?? "UnknownEntity";
  let tableName = toSnakePlural(name);
  const args = entityDecorator.getArguments();
  if (args.length > 0 && args[0].getKind() === SyntaxKind.StringLiteral) {
    tableName = args[0].getText().replace(/['"]/g, "");
  }

  const columns: Column[] = [];
  const existingRelations: ExistingRelation[] = [];

  for (const prop of cls.getProperties()) {
    const decorators: Decorator[] = prop.getDecorators();
    const decoratorNames = decorators.map((d: Decorator) => d.getName());
    const propName = prop.getName();
    const tsType = prop.getType().getText(prop);

    const relationDecorator = decorators.find((d: Decorator) => getRelationDecoratorType(d) !== null);
    if (relationDecorator) {
      const relType = getRelationDecoratorType(relationDecorator)!;
      const target = getDecoratorFirstStringArg(relationDecorator) ?? "Unknown";
      existingRelations.push({ type: relType, target, propertyName: propName });
      continue;
    }

    if (decoratorNames.includes("Column") || decoratorNames.includes("PrimaryGeneratedColumn") || decoratorNames.includes("PrimaryColumn")) {
      const columnDecorator =
        decorators.find((d: Decorator) => d.getName() === "Column") ??
        decorators.find((d: Decorator) => d.getName() === "PrimaryGeneratedColumn") ??
        decorators.find((d: Decorator) => d.getName() === "PrimaryColumn");

      let isUnique = false;
      let isNullable = false;
      if (columnDecorator) {
        const argText = columnDecorator.getArguments().map((a) => a.getText()).join(",");
        isUnique = /unique\s*:\s*true/.test(argText);
        isNullable = /nullable\s*:\s*true/.test(argText);
      }

      columns.push({
        name: propName,
        tsType,
        decorators: decoratorNames,
        isPrimary: decoratorNames.some((d: string) => d.startsWith("Primary")),
        isUnique,
        isNullable,
      });
    }
  }

  return {
    name,
    filePath,
    tableName,
    columns,
    existingRelations,
    detectedAuthGuards: [], // se completa opcionalmente cruzando con controllers, ver detectAuthGuards()
  };
}

function toSnakePlural(pascalName: string): string {
  const snake = pascalName.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  return snake.endsWith("s") ? snake : `${snake}s`;
}

/**
 * Señales superficiales por convención de nombre. Deliberadamente simple:
 * no intenta ser "inteligente", solo reporta coincidencias literales para
 * que Claude las evalúe con contexto real más adelante.
 */
function computeRelationshipSignals(
  entities: EntityInfo[],
  newEntityName: string,
  newEntityFields: { name: string; tsType: string }[]
): RelationshipSignal[] {
  const signals: RelationshipSignal[] = [];
  const allEntityNames = [...entities.map((e) => e.name), newEntityName];

  const candidates: { name: string; fields: { name: string; tsType: string; isUnique?: boolean }[] }[] = [
    { name: newEntityName, fields: newEntityFields },
    ...entities.map((e) => ({ name: e.name, fields: e.columns })),
  ];

  for (const candidate of candidates) {
    for (const field of candidate.fields) {
      const fkMatch = field.name.match(/^(.*)Id$/);
      if (!fkMatch) continue;
      const rawRef = fkMatch[1]; // ej. "user" de "userId"
      const targetEntity = allEntityNames.find(
        (n) => n.toLowerCase() === rawRef.toLowerCase()
      );
      if (!targetEntity || targetEntity === candidate.name) continue;

      const isUnique = "isUnique" in field ? !!(field as Column).isUnique : false;

      signals.push({
        fromEntity: candidate.name,
        toEntity: targetEntity,
        signalType: isUnique ? "unique-fk-column" : "fk-naming-convention",
        evidence: `Campo '${field.name}' en ${candidate.name} coincide con convención de FK hacia ${targetEntity}`,
        confidence: isUnique ? 0.9 : 0.75,
        suggestedType: isUnique ? "OneToOne" : "ManyToOne",
      });
    }
  }

  // Detección simple de tablas pivote: entity con exactamente 2 relaciones
  // ManyToOne/columnas FK y sin más columnas relevantes que un id.
  for (const entity of entities) {
    const fkFields = entity.columns.filter((c) => /Id$/.test(c.name));
    const nonFkNonPk = entity.columns.filter(
      (c) => !/Id$/.test(c.name) && !c.isPrimary
    );
    if (fkFields.length === 2 && nonFkNonPk.length === 0) {
      const [a, b] = fkFields;
      signals.push({
        fromEntity: a.name.replace(/Id$/, ""),
        toEntity: b.name.replace(/Id$/, ""),
        signalType: "pivot-table-detected",
        evidence: `Entity '${entity.name}' parece tabla pivote entre ${a.name} y ${b.name} (solo 2 FKs, sin columnas propias)`,
        confidence: 0.85,
        suggestedType: "ManyToMany",
      });
    }
  }

  return signals;
}

/**
 * Parseo muy simple de la descripción de texto de la nueva entidad.
 * Deliberadamente conservador: extrae "nombre: campo tipo, campo tipo"
 * si sigue ese patrón; si no, deja proposedFields vacío y deja que
 * Claude lo complete en la fase 2 (no es su responsabilidad adivinar
 * lenguaje natural libre).
 */
function parseNewEntityDescription(desc: string) {
  const nameMatch = desc.match(/^\s*([A-Z][A-Za-z0-9]*)\s*:/);
  const proposedName = nameMatch ? nameMatch[1] : "NewEntity";
  const fieldsPart = desc.includes(":") ? desc.split(":").slice(1).join(":") : desc;

  const fieldRegex = /([a-zA-Z0-9_]+)\s+(uuid|string|number|boolean|Date)/g;
  const proposedFields: { name: string; tsType: string; isUnique?: boolean; isNullable?: boolean }[] = [];
  let m: RegExpExecArray | null;
  while ((m = fieldRegex.exec(fieldsPart)) !== null) {
    proposedFields.push({ name: m[1], tsType: m[2] });
  }

  return { proposedName, proposedFields };
}

function main() {
  const args = parseArgs();
  const project = new Project();
  project.addSourceFilesAtPaths(args["entities-dir"]);

  const entities: EntityInfo[] = [];
  for (const sourceFile of project.getSourceFiles()) {
    for (const cls of sourceFile.getClasses()) {
      const info = extractEntity(cls, sourceFile.getFilePath());
      if (info) entities.push(info);
    }
  }

  const newEntityDesc = args["new-entity-desc"] ?? "";
  const { proposedName, proposedFields } = parseNewEntityDescription(newEntityDesc);

  const relationshipSignals = computeRelationshipSignals(entities, proposedName, proposedFields);

  const report = {
    generatedAt: new Date().toISOString(),
    entities,
    newEntity: {
      rawDescription: newEntityDesc,
      proposedName,
      proposedFields,
    },
    relationshipSignals,
  };

  fs.mkdirSync(path.dirname(args["output"]), { recursive: true });
  fs.writeFileSync(args["output"], JSON.stringify(report, null, 2), "utf-8");
  console.log(`Análisis escrito en ${args["output"]}`);
  console.log(
    `Entities detectadas: ${entities.length}. Señales de relación: ${relationshipSignals.length}.`
  );
  console.log(
    "NOTA: estas señales son heurísticas de nombre, no relaciones confirmadas. " +
      "La fase 2 (Claude + usuario) debe evaluarlas y confirmarlas explícitamente."
  );
}

main();

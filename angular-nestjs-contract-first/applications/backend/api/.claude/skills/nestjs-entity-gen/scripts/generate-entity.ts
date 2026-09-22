/**
 * generate-entity.ts
 * DETERMINISTA. Traduce entity-config.json a un archivo *.entity.ts.
 * No decide nada: cascade/eager/onDelete ya vienen resueltos en el config.
 *
 * Uso:
 *   npx ts-node generate-entity.ts --config=/tmp/entity-config.json --out=src/entities [--force]
 */

import * as path from "path";
import {
  parseArgs,
  loadConfig,
  writeFileSafe,
  tsTypeToTs,
  pascalToCamel,
  pascalToKebab,
  RelationshipConfig,
} from "./_shared";

function columnDecoratorFor(field: ReturnType<typeof loadConfig>["fields"][number]): string {
  if (field.isPrimary) {
    return field.tsType === "uuid"
      ? `@PrimaryGeneratedColumn('uuid')`
      : `@PrimaryGeneratedColumn()`;
  }
  const opts: string[] = [`type: '${field.columnType}'`];
  if (field.isUnique) opts.push("unique: true");
  if (field.isNullable) opts.push("nullable: true");
  if (field.default !== undefined) opts.push(`default: ${JSON.stringify(field.default)}`);
  return `@Column({ ${opts.join(", ")} })`;
}

function relationDecoratorFor(rel: RelationshipConfig): string[] {
  const lines: string[] = [];
  const cascadeStr = rel.cascade.length
    ? `cascade: [${rel.cascade.map((c) => `'${c}'`).join(", ")}]`
    : "cascade: false";
  const opts = [cascadeStr, `eager: ${rel.eager}`, `onDelete: '${rel.onDelete}'`];

  const inverseArrow = rel.inverseSidePropertyName
    ? `, (inverse) => inverse.${rel.inverseSidePropertyName}`
    : "";

  lines.push(
    `@${rel.type}(() => ${rel.targetEntity}${inverseArrow}, { ${opts.join(", ")} })`
  );

  if (rel.type === "ManyToOne" || (rel.type === "OneToOne" && rel.joinColumn)) {
    lines.push(`@JoinColumn({ name: '${rel.joinColumn ?? `${pascalToCamel(rel.targetEntity)}Id`}' })`);
  }
  if (rel.type === "ManyToMany" && rel.joinColumn) {
    lines.push(`@JoinTable()`);
  }

  return lines;
}

function propertyTypeFor(rel: RelationshipConfig): string {
  const isCollection = rel.type === "OneToMany" || rel.type === "ManyToMany";
  return isCollection ? `${rel.targetEntity}[]` : rel.targetEntity;
}

function main() {
  const args = parseArgs(["config", "out"]);
  const config = loadConfig(args["config"]);
  const force = !!args["force"];

  const imports = new Set<string>(["Entity", "Column"]);
  const hasPrimary = config.fields.some((f) => f.isPrimary);
  if (hasPrimary) imports.add("PrimaryGeneratedColumn");

  const relatedTargets = new Set<string>();
  for (const rel of config.relationships) {
    imports.add(rel.type);
    if (rel.type === "ManyToOne" || (rel.type === "OneToOne" && rel.joinColumn)) {
      imports.add("JoinColumn");
    }
    if (rel.type === "ManyToMany" && rel.joinColumn) {
      imports.add("JoinTable");
    }
    relatedTargets.add(rel.targetEntity);
  }

  const columnLines = config.fields
    .map((f) => {
      const decorator = columnDecoratorFor(f);
      return `  ${decorator}\n  ${f.name}: ${tsTypeToTs(f)};`;
    })
    .join("\n\n");

  const relationLines = config.relationships
    .map((rel) => {
      const decoratorLines = relationDecoratorFor(rel)
        .map((l) => `  ${l}`)
        .join("\n");
      return `${decoratorLines}\n  ${rel.propertyName}: ${propertyTypeFor(rel)};`;
    })
    .join("\n\n");

  const relatedImportLines = [...relatedTargets]
    .map((t) => `import { ${t} } from './${pascalToKebab(t)}.entity';`)
    .join("\n");

  const content = `import { ${[...imports].join(", ")} } from 'typeorm';
${relatedImportLines ? relatedImportLines + "\n" : ""}
@Entity('${config.tableName}')
export class ${config.entityName} {
${columnLines}
${relationLines ? "\n" + relationLines + "\n" : ""}}
`;

  const outPath = path.join(args["out"], `${pascalToKebab(config.entityName)}.entity.ts`);
  writeFileSafe(outPath, content, force);
}

main();

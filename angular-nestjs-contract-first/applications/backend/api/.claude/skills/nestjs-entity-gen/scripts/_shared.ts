/**
 * _shared.ts
 * Utilidades comunes a los generate-*.ts. Sin lógica de decisión:
 * solo carga de config, validación de esquema y helpers de escritura
 * segura (nunca sobrescribe sin --force).
 */

import * as fs from "fs";
import * as path from "path";

export interface FieldConfig {
  name: string;
  tsType: "string" | "number" | "boolean" | "Date" | "uuid";
  columnType: string;
  isPrimary?: boolean;
  isUnique?: boolean;
  isNullable?: boolean;
  default?: unknown;
}

export interface RelationshipConfig {
  targetEntity: string;
  type: "OneToOne" | "OneToMany" | "ManyToOne" | "ManyToMany";
  propertyName: string;
  inverseSidePropertyName?: string;
  joinColumn?: string;
  cascade: ("insert" | "update" | "remove")[];
  eager: boolean;
  onDelete: "CASCADE" | "SET NULL" | "RESTRICT";
  confirmedBy: "user";
  sourceSignal?: string | null;
}

export interface EndpointsConfig {
  expose: ("GET_LIST" | "GET_ONE" | "POST" | "PATCH" | "DELETE")[];
  pagination: "none" | "offset" | "cursor";
  auth: { required: boolean; guard?: string };
  basePath?: string;
}

export interface CustomMethodConfig {
  name: string;
  description: string;
  params: string[];
  returns: string;
}

export interface EntityConfig {
  entityName: string;
  tableName: string;
  fields: FieldConfig[];
  relationships: RelationshipConfig[];
  endpoints: EndpointsConfig;
  customMethods?: CustomMethodConfig[];
  meta?: { confirmedAt?: string; generatorVersion?: string };
}

export function parseArgs(required: string[]): Record<string, string> {
  const args = process.argv.slice(2);
  const out: Record<string, string> = {};
  for (const a of args) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
    else if (a === "--force") out["force"] = "true";
  }
  const missing = required.filter((r) => !out[r]);
  if (missing.length) {
    console.error(`Faltan argumentos requeridos: ${missing.join(", ")}`);
    process.exit(1);
  }
  return out;
}

export function loadConfig(configPath: string): EntityConfig {
  const raw = fs.readFileSync(configPath, "utf-8");
  const config = JSON.parse(raw) as EntityConfig;
  validateConfig(config);
  return config;
}

/**
 * Validación mínima de invariantes duras. No sustituye al JSON Schema
 * completo (schema/entity-config.schema.json), pero evita generar código
 * con relaciones a medio confirmar por error humano al editar el JSON.
 */
function validateConfig(config: EntityConfig) {
  if (!config.entityName || !config.tableName) {
    throw new Error("entity-config.json inválido: falta entityName o tableName");
  }
  if (!config.fields?.length) {
    throw new Error("entity-config.json inválido: fields vacío");
  }
  for (const rel of config.relationships ?? []) {
    if (rel.confirmedBy !== "user") {
      throw new Error(
        `Relación hacia ${rel.targetEntity} no tiene confirmedBy: "user". ` +
          `Ninguna relación debe generarse sin confirmación explícita.`
      );
    }
    if (!rel.onDelete) {
      throw new Error(`Relación hacia ${rel.targetEntity} no especifica onDelete explícito.`);
    }
  }
}

export function writeFileSafe(filePath: string, content: string, force: boolean) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  let finalPath = filePath;
  if (fs.existsSync(filePath) && !force) {
    const ext = path.extname(filePath);
    const base = filePath.slice(0, -ext.length);
    finalPath = `${base}.generated${ext}`;
    console.warn(
      `⚠ ${filePath} ya existe. Escribiendo en ${finalPath} en su lugar. ` +
        `Usa --force para sobrescribir directamente.`
    );
  }

  fs.writeFileSync(finalPath, content, "utf-8");
  console.log(`Generado: ${finalPath}`);
  return finalPath;
}

export function tsTypeToTs(field: FieldConfig): string {
  return field.tsType === "uuid" ? "string" : field.tsType;
}

export function pascalToCamel(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

export function pascalToKebab(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

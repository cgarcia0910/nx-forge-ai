/**
 * _shared.ts
 * Utilidades comunes a create-library.ts / generate-openapi.ts / generate-library-files.ts.
 * Sin lógica de decisión: solo carga y validación de config/spec, y helpers
 * de nombrado y escritura segura (nunca sobrescribe sin --force).
 */

import * as fs from 'fs';
import * as path from 'path';

export interface PropertyConfig {
  name: string;
  tsType: 'string' | 'number' | 'boolean' | 'Date' | 'uuid';
  columnType: string;
  isPrimary: boolean;
  isUnique: boolean;
  isNullable: boolean;
  default?: unknown;
}

export type StandardEndpoint = 'GET_LIST' | 'GET_ONE' | 'POST' | 'PATCH' | 'DELETE';

export interface CustomEndpoint {
  name: string;
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  description: string;
  params?: string[];
  returns?: string;
}

export interface EntitySpec {
  entityName: string;
  tableName: string;
  properties: PropertyConfig[];
  endpoints: {
    standard: StandardEndpoint[];
    custom: CustomEndpoint[];
  };
  meta?: { confirmedAt?: string; generatorVersion?: string };
}

export interface GeneratorConfig {
  librariesRoot: string;
  npmScope: string;
  nxGenerator: string;
  nxGeneratorOptions?: Record<string, unknown>;
}

export function parseArgs(required: string[]): Record<string, string> {
  const args = process.argv.slice(2);
  const out: Record<string, string> = {};
  for (const a of args) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
    else if (a === '--force') out['force'] = 'true';
  }
  const missing = required.filter((r) => !out[r]);
  if (missing.length) {
    console.error(`Faltan argumentos requeridos: ${missing.join(', ')}`);
    process.exit(1);
  }
  return out;
}

export function loadGeneratorConfig(repoRoot: string): GeneratorConfig {
  const configPath = path.join(repoRoot, 'entity-generator.config.json');
  if (!fs.existsSync(configPath)) {
    throw new Error(`No se encuentra ${configPath}. Este fichero es obligatorio y determinista.`);
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as GeneratorConfig;
  if (!config.librariesRoot || !config.npmScope || !config.nxGenerator) {
    throw new Error(
      'entity-generator.config.json inválido: requiere librariesRoot, npmScope y nxGenerator.'
    );
  }
  return config;
}

export function loadEntitySpec(specPath: string): EntitySpec {
  const raw = fs.readFileSync(specPath, 'utf-8');
  const spec = JSON.parse(raw) as EntitySpec;
  validateEntitySpec(spec);
  return spec;
}

/**
 * Validación mínima de invariantes duras. No sustituye al JSON Schema
 * completo (schema/entity-spec.schema.json), pero evita generar código
 * a partir de un spec a medio confirmar por error humano al editar el JSON.
 */
function validateEntitySpec(spec: EntitySpec) {
  if (!spec.entityName || !spec.tableName) {
    throw new Error('entity-spec.json inválido: falta entityName o tableName');
  }
  if (!spec.properties?.length) {
    throw new Error('entity-spec.json inválido: properties vacío');
  }
  if (!spec.properties.some((p) => p.isPrimary)) {
    throw new Error('entity-spec.json inválido: ninguna property marcada como isPrimary');
  }
  if (!spec.endpoints) {
    throw new Error('entity-spec.json inválido: falta endpoints');
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

  fs.writeFileSync(finalPath, content, 'utf-8');
  console.log(`Generado: ${finalPath}`);
  return finalPath;
}

export function tsTypeOf(property: PropertyConfig): string {
  return property.tsType === 'uuid' ? 'string' : property.tsType;
}

export function pascalToCamel(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

export function pascalToKebab(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

/**
 * Nombre de librería/paquete (kebab, plural): se deriva de tableName
 * (snake_case plural, ya decidido por el usuario en la fase 1) en vez de
 * pluralizar entityName heurísticamente, para no reinventar reglas de
 * pluralización — tableName ya es la fuente de verdad del plural.
 */
export function libraryNameFrom(tableName: string): string {
  return tableName.replace(/_/g, '-');
}

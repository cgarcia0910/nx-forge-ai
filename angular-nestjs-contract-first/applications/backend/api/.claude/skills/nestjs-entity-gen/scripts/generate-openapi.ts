/**
 * generate-openapi.ts
 * DETERMINISTA. Traduce entity-config.json a una spec OpenAPI 3.0 yaml.
 * Qué endpoints exponer, auth y paginación ya vienen decididos en el config.
 *
 * Uso:
 *   npx ts-node generate-openapi.ts --config=/tmp/entity-config.json --out=openapi [--force]
 */

import * as path from "path";
import * as yaml from "js-yaml";
import { parseArgs, loadConfig, writeFileSafe, pascalToCamel, pascalToKebab, FieldConfig } from "./_shared";

function openApiTypeFor(field: FieldConfig): Record<string, string> {
  switch (field.tsType) {
    case "uuid":
      return { type: "string", format: "uuid" };
    case "Date":
      return { type: "string", format: "date-time" };
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    default:
      return { type: "string" };
  }
}

function buildSchema(config: ReturnType<typeof loadConfig>) {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const f of config.fields) {
    properties[f.name] = openApiTypeFor(f);
    if (!f.isNullable && !f.isPrimary) required.push(f.name);
  }
  for (const rel of config.relationships) {
    const isCollection = rel.type === "OneToMany" || rel.type === "ManyToMany";
    properties[rel.propertyName] = isCollection
      ? { type: "array", items: { $ref: `#/components/schemas/${rel.targetEntity}` } }
      : { $ref: `#/components/schemas/${rel.targetEntity}` };
  }
  return { type: "object", properties, required };
}

function buildCreateSchema(config: ReturnType<typeof loadConfig>) {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const f of config.fields) {
    if (f.isPrimary) continue; // el id no se envía al crear
    properties[f.name] = openApiTypeFor(f);
    if (!f.isNullable) required.push(f.name);
  }
  return { type: "object", properties, required };
}

function buildPaths(config: ReturnType<typeof loadConfig>) {
  const base = config.endpoints.basePath ?? `/${pascalToKebab(config.entityName)}s`;
  const entityRef = { $ref: `#/components/schemas/${config.entityName}` };
  const security = config.endpoints.auth.required
    ? [{ [config.endpoints.auth.guard ?? "bearerAuth"]: [] }]
    : [];

  const paths: Record<string, unknown> = {};
  const listOps: Record<string, unknown> = {};
  const itemOps: Record<string, unknown> = {};

  if (config.endpoints.expose.includes("GET_LIST")) {
    const params: unknown[] = [];
    if (config.endpoints.pagination === "offset") {
      params.push(
        { name: "limit", in: "query", schema: { type: "integer", default: 20 } },
        { name: "offset", in: "query", schema: { type: "integer", default: 0 } }
      );
    } else if (config.endpoints.pagination === "cursor") {
      params.push(
        { name: "cursor", in: "query", schema: { type: "string" } },
        { name: "limit", in: "query", schema: { type: "integer", default: 20 } }
      );
    }
    listOps["get"] = {
      operationId: `list${config.entityName}s`,
      summary: `Lista ${config.entityName}`,
      parameters: params,
      security,
      responses: {
        "200": {
          description: "OK",
          content: { "application/json": { schema: { type: "array", items: entityRef } } },
        },
      },
    };
  }

  if (config.endpoints.expose.includes("POST")) {
    listOps["post"] = {
      operationId: `create${config.entityName}`,
      summary: `Crea ${config.entityName}`,
      security,
      requestBody: {
        required: true,
        content: { "application/json": { schema: buildCreateSchema(config) } },
      },
      responses: { "201": { description: "Creado", content: { "application/json": { schema: entityRef } } } },
    };
  }

  if (Object.keys(listOps).length) paths[base] = listOps;

  const idParam = { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } };

  if (config.endpoints.expose.includes("GET_ONE")) {
    itemOps["get"] = {
      operationId: `get${config.entityName}ById`,
      summary: `Obtiene ${config.entityName} por id`,
      parameters: [idParam],
      security,
      responses: {
        "200": { description: "OK", content: { "application/json": { schema: entityRef } } },
        "404": { description: "No encontrado" },
      },
    };
  }

  if (config.endpoints.expose.includes("PATCH")) {
    itemOps["patch"] = {
      operationId: `update${config.entityName}`,
      summary: `Actualiza ${config.entityName}`,
      parameters: [idParam],
      security,
      requestBody: {
        content: { "application/json": { schema: buildCreateSchema(config) } },
      },
      responses: {
        "200": { description: "Actualizado", content: { "application/json": { schema: entityRef } } },
        "404": { description: "No encontrado" },
      },
    };
  }

  if (config.endpoints.expose.includes("DELETE")) {
    itemOps["delete"] = {
      operationId: `delete${config.entityName}`,
      summary: `Elimina ${config.entityName}`,
      parameters: [idParam],
      security,
      responses: { "204": { description: "Eliminado" }, "404": { description: "No encontrado" } },
    };
  }

  if (Object.keys(itemOps).length) paths[`${base}/{id}`] = itemOps;

  return paths;
}

function main() {
  const args = parseArgs(["config", "out"]);
  const config = loadConfig(args["config"]);
  const force = !!args["force"];

  const spec = {
    openapi: "3.0.3",
    info: {
      title: `${config.entityName} API`,
      version: "1.0.0",
      description: `API generada automáticamente para ${config.entityName}. Fuente: entity-config.json confirmado.`,
    },
    paths: buildPaths(config),
    components: {
      schemas: {
        [config.entityName]: buildSchema(config),
      },
      securitySchemes: config.endpoints.auth.required
        ? {
            [config.endpoints.auth.guard ?? "bearerAuth"]: {
              type: "http",
              scheme: "bearer",
              bearerFormat: "JWT",
            },
          }
        : undefined,
    },
  };

  const yamlContent = yaml.dump(spec, { noRefs: true, lineWidth: 100 });
  const outPath = path.join(args["out"], `${pascalToKebab(config.entityName)}.openapi.yaml`);
  writeFileSafe(outPath, yamlContent, force);
}

main();

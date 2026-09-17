/**
 * generate-openapi.ts (paso 3 — determinista)
 *
 * Lee entity-spec.json (ya copiado dentro de la librería por create-library.ts)
 * y escribe <libreria>/openapi/<entidad-kebab>.openapi.yaml. Solo traduce
 * el spec a OpenAPI 3.0.3; no toma ninguna decisión de negocio.
 *
 * Uso:
 *   npx ts-node scripts/generate-openapi.ts --library-dir=<ruta a libs/backend/<entidad>> [--force]
 */

import * as path from 'path';
import { stringify } from 'yaml';
import {
  CustomEndpoint,
  EntitySpec,
  PropertyConfig,
  loadEntitySpec,
  parseArgs,
  pascalToKebab,
  writeFileSafe,
} from './_shared';

function openApiType(property: PropertyConfig): Record<string, string> {
  switch (property.tsType) {
    case 'string':
      return { type: 'string' };
    case 'number':
      return { type: 'number' };
    case 'boolean':
      return { type: 'boolean' };
    case 'Date':
      return { type: 'string', format: 'date-time' };
    case 'uuid':
      return { type: 'string', format: 'uuid' };
  }
}

function entitySchema(spec: EntitySpec) {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const p of spec.properties) {
    properties[p.name] = openApiType(p);
    if (!p.isNullable) required.push(p.name);
  }
  return { type: 'object', required, properties };
}

function dtoSchema(spec: EntitySpec, mode: 'create' | 'update') {
  const writable = spec.properties.filter((p) => !p.isPrimary);
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const p of writable) {
    properties[p.name] = openApiType(p);
    if (mode === 'create' && !p.isNullable && p.default === undefined) required.push(p.name);
  }
  return { type: 'object', required, properties };
}

function toOpenApiPath(rawPath: string): string {
  return rawPath.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function pathParamsOf(rawPath: string): string[] {
  return [...rawPath.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]);
}

function customOperation(entityName: string, endpoint: CustomEndpoint) {
  const pathParams = pathParamsOf(endpoint.path);
  const queryParams = (endpoint.params ?? []).filter((p) => !pathParams.includes(p));
  const parameters = [
    ...pathParams.map((name) => ({
      name,
      in: 'path',
      required: true,
      schema: { type: 'string' },
    })),
    ...queryParams.map((name) => ({
      name,
      in: 'query',
      required: false,
      schema: { type: 'string' },
    })),
  ];

  const returnsArray = (endpoint.returns ?? '').includes('[]');
  const responseSchema = returnsArray
    ? { type: 'array', items: { $ref: `#/components/schemas/${entityName}` } }
    : { $ref: `#/components/schemas/${entityName}` };

  const operation: Record<string, unknown> = {
    operationId: endpoint.name,
    tags: [entityName],
    summary: endpoint.description,
    responses: {
      '200': {
        description: endpoint.description,
        content: { 'application/json': { schema: responseSchema } },
      },
    },
  };
  if (parameters.length) operation.parameters = parameters;
  return operation;
}

function buildDocument(spec: EntitySpec) {
  const { entityName, tableName } = spec;
  const basePath = `/${tableName}`;
  const itemPath = `${basePath}/{id}`;
  const paths: Record<string, Record<string, unknown>> = {};

  const ensurePath = (p: string) => (paths[p] ??= {});

  if (spec.endpoints.standard.includes('GET_LIST')) {
    ensurePath(basePath).get = {
      operationId: `findAll${entityName}`,
      tags: [entityName],
      summary: `Listar ${tableName}`,
      responses: {
        '200': {
          description: `Lista de ${tableName}`,
          content: {
            'application/json': {
              schema: { type: 'array', items: { $ref: `#/components/schemas/${entityName}` } },
            },
          },
        },
      },
    };
  }

  if (spec.endpoints.standard.includes('POST')) {
    ensurePath(basePath).post = {
      operationId: `create${entityName}`,
      tags: [entityName],
      summary: `Crear ${entityName}`,
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: { $ref: `#/components/schemas/Create${entityName}Dto` } },
        },
      },
      responses: {
        '201': {
          description: `${entityName} creado`,
          content: { 'application/json': { schema: { $ref: `#/components/schemas/${entityName}` } } },
        },
      },
    };
  }

  if (spec.endpoints.standard.includes('GET_ONE')) {
    ensurePath(itemPath).get = {
      operationId: `findOne${entityName}`,
      tags: [entityName],
      summary: `Obtener ${entityName} por id`,
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        '200': {
          description: entityName,
          content: { 'application/json': { schema: { $ref: `#/components/schemas/${entityName}` } } },
        },
      },
    };
  }

  if (spec.endpoints.standard.includes('PATCH')) {
    ensurePath(itemPath).patch = {
      operationId: `update${entityName}`,
      tags: [entityName],
      summary: `Actualizar ${entityName}`,
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: { $ref: `#/components/schemas/Update${entityName}Dto` } },
        },
      },
      responses: {
        '200': {
          description: `${entityName} actualizado`,
          content: { 'application/json': { schema: { $ref: `#/components/schemas/${entityName}` } } },
        },
      },
    };
  }

  if (spec.endpoints.standard.includes('DELETE')) {
    ensurePath(itemPath).delete = {
      operationId: `remove${entityName}`,
      tags: [entityName],
      summary: `Eliminar ${entityName}`,
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '204': { description: 'Eliminado' } },
    };
  }

  for (const custom of spec.endpoints.custom) {
    const fullPath = `${basePath}${toOpenApiPath(custom.path)}`;
    const method = custom.method.toLowerCase();
    ensurePath(fullPath)[method] = customOperation(entityName, custom);
  }

  return {
    openapi: '3.0.3',
    info: { title: `${entityName} API`, version: '1.0.0' },
    tags: [{ name: entityName }],
    paths,
    components: {
      schemas: {
        [entityName]: entitySchema(spec),
        [`Create${entityName}Dto`]: dtoSchema(spec, 'create'),
        [`Update${entityName}Dto`]: dtoSchema(spec, 'update'),
      },
    },
  };
}

function main() {
  const { 'library-dir': libraryDirArg, force } = parseArgs(['library-dir']);
  const libraryDir = path.resolve(libraryDirArg);
  const specPath = path.join(libraryDir, 'entity-spec.json');
  const spec = loadEntitySpec(specPath);

  const document = buildDocument(spec);
  const yamlContent =
    `# Generado desde ${path.basename(specPath)} por generate-openapi.ts.\n` +
    `# No editar a mano - regenerar con el skill nestjs-entity-lib-gen.\n` +
    stringify(document);

  const outPath = path.join(
    libraryDir,
    'openapi',
    `${pascalToKebab(spec.entityName)}.openapi.yaml`
  );
  writeFileSafe(outPath, yamlContent, force === 'true');
}

main();

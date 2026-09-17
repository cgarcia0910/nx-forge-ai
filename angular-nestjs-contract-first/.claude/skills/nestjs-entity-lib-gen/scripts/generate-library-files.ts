/**
 * generate-library-files.ts (paso 4 — determinista)
 *
 * Renderiza, con Handlebars, los ficheros de código de la librería a
 * partir de entity-spec.json, replicando el patrón plano de
 * courses/src/user.*.ts: un fichero por responsabilidad bajo src/,
 * sin subcarpeta src/lib.
 *
 * Uso:
 *   npx ts-node scripts/generate-library-files.ts --library-dir=<ruta a libs/backend/<entidad>> [--force]
 */

import Handlebars from 'handlebars';
import * as fs from 'fs';
import * as path from 'path';
import {
  CustomEndpoint,
  EntitySpec,
  PropertyConfig,
  loadEntitySpec,
  parseArgs,
  pascalToCamel,
  pascalToKebab,
  libraryNameFrom,
  tsTypeOf,
  writeFileSafe,
} from './_shared';

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');

function snakeToPascal(s: string): string {
  return s
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function formatDefault(value: unknown): string {
  return typeof value === 'string' ? `'${value}'` : JSON.stringify(value);
}

function columnDecorator(p: PropertyConfig): string {
  if (p.isPrimary) {
    if (p.tsType === 'uuid') return "@PrimaryGeneratedColumn('uuid')";
    if (p.tsType === 'number') return '@PrimaryGeneratedColumn()';
    return `@PrimaryColumn({ type: '${p.columnType}' })`;
  }
  const options = [`type: '${p.columnType}'`];
  if (p.isUnique) options.push('unique: true');
  if (p.isNullable) options.push('nullable: true');
  if (p.default !== undefined) options.push(`default: ${formatDefault(p.default)}`);
  return `@Column({ ${options.join(', ')} })`;
}

function propertyTsType(p: PropertyConfig): string {
  const base = tsTypeOf(p);
  return p.isNullable ? `${base} | null` : base;
}

function typeormImportsFor(properties: PropertyConfig[]): string[] {
  const imports = new Set<string>(['Entity']);
  if (properties.some((p) => p.isPrimary && (p.tsType === 'uuid' || p.tsType === 'number'))) {
    imports.add('PrimaryGeneratedColumn');
  }
  if (properties.some((p) => p.isPrimary && p.tsType !== 'uuid' && p.tsType !== 'number')) {
    imports.add('PrimaryColumn');
  }
  if (properties.some((p) => !p.isPrimary)) {
    imports.add('Column');
  }
  return [...imports];
}

interface CustomMethodView {
  name: string;
  description: string;
  paramsSignature: string;
  paramNames: string[];
  controllerParamsSignature: string;
  callArgs: string;
  returnType: string;
  httpDecorator: string;
  routePath: string;
}

function pathParamsOf(rawPath: string): string[] {
  return [...rawPath.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]);
}

function customMethodViewsOf(customEndpoints: CustomEndpoint[], entityName: string): CustomMethodView[] {
  return customEndpoints.map((endpoint) => {
    const pathParams = pathParamsOf(endpoint.path);
    const queryParams = (endpoint.params ?? []).filter((p) => !pathParams.includes(p));
    const allParams = [...pathParams, ...queryParams];
    return {
      name: endpoint.name,
      description: endpoint.description,
      paramsSignature: allParams.map((n) => `${n}: string`).join(', '),
      paramNames: allParams,
      controllerParamsSignature: [
        ...pathParams.map((n) => `@Param('${n}') ${n}: string`),
        ...queryParams.map((n) => `@Query('${n}') ${n}: string`),
      ].join(', '),
      callArgs: allParams.join(', '),
      returnType: endpoint.returns ?? entityName,
      httpDecorator: endpoint.method.charAt(0) + endpoint.method.slice(1).toLowerCase(),
      routePath: endpoint.path.replace(/^\//, ''),
    };
  });
}

function nestImportsFor(opts: {
  hasFindAll: boolean;
  exposeGetOne: boolean;
  hasCreate: boolean;
  hasUpdate: boolean;
  hasRemove: boolean;
  customEndpoints: CustomEndpoint[];
}): string[] {
  const imports = new Set<string>(['Controller']);
  const methods = new Set<string>();
  if (opts.hasFindAll || opts.exposeGetOne) methods.add('Get');
  if (opts.hasCreate) methods.add('Post');
  if (opts.hasUpdate) methods.add('Patch');
  if (opts.hasRemove) methods.add('Delete');
  for (const c of opts.customEndpoints) {
    methods.add(c.method.charAt(0) + c.method.slice(1).toLowerCase());
  }
  for (const m of methods) imports.add(m);

  if (opts.exposeGetOne || opts.hasUpdate || opts.hasRemove) imports.add('Param');
  if (opts.hasCreate || opts.hasUpdate) imports.add('Body');
  if (opts.hasRemove) imports.add('HttpCode');
  const hasPathParam = opts.customEndpoints.some((c) => pathParamsOf(c.path).length > 0);
  const hasQueryParam = opts.customEndpoints.some(
    (c) => (c.params ?? []).length > pathParamsOf(c.path).length
  );
  if (hasPathParam) imports.add('Param');
  if (hasQueryParam) imports.add('Query');

  // Orden estable: Controller primero, luego verbos HTTP, luego el resto.
  const order = ['Controller', 'Get', 'Post', 'Patch', 'Delete', 'Param', 'Body', 'Query', 'HttpCode'];
  return order.filter((name) => imports.has(name));
}

function renderTemplate(name: string, context: unknown): string {
  const source = fs.readFileSync(path.join(TEMPLATES_DIR, name), 'utf-8');
  const template = Handlebars.compile(source, { noEscape: true });
  return template(context);
}

function buildContext(spec: EntitySpec) {
  const entityName = spec.entityName;
  const camelEntityName = pascalToCamel(entityName);
  const entityFileBase = pascalToKebab(entityName);
  const moduleFileBase = libraryNameFrom(spec.tableName);
  const moduleClassName = `${snakeToPascal(spec.tableName)}Module`;

  const standard = spec.endpoints.standard;
  const hasFindAll = standard.includes('GET_LIST');
  const exposeGetOne = standard.includes('GET_ONE');
  const hasCreate = standard.includes('POST');
  const hasUpdate = standard.includes('PATCH');
  const hasRemove = standard.includes('DELETE');
  const needsFindOneMethod = exposeGetOne || hasUpdate || hasRemove;

  const customMethods = customMethodViewsOf(spec.endpoints.custom, entityName);

  const properties = spec.properties.map((p) => ({
    name: p.name,
    tsType: propertyTsType(p),
    decorator: columnDecorator(p),
  }));

  const writableProperties = spec.properties.filter((p) => !p.isPrimary);
  const createProperties = writableProperties.map((p) => ({
    name: p.name,
    tsType: propertyTsType(p),
    optional: p.isNullable || p.default !== undefined,
  }));
  const updateProperties = writableProperties.map((p) => ({
    name: p.name,
    tsType: propertyTsType(p),
  }));
  const constructorParams = createProperties
    .map((p) => `${p.name}${p.optional ? '?' : ''}: ${p.tsType}`)
    .join(', ');

  return {
    entity: {
      entityName,
      tableName: spec.tableName,
      typeormImports: typeormImportsFor(spec.properties),
      properties,
    },
    dto: { entityName, createProperties, updateProperties, constructorParams },
    service: {
      entityName,
      camelEntityName,
      entityFileBase,
      hasFindAll,
      hasFindOne: needsFindOneMethod,
      hasCreate,
      hasUpdate,
      hasRemove,
      customMethods,
    },
    controller: {
      entityName,
      camelEntityName,
      tableName: spec.tableName,
      entityFileBase,
      hasFindAll,
      hasFindOne: exposeGetOne,
      hasCreate,
      hasUpdate,
      hasRemove,
      customMethods,
      nestImports: nestImportsFor({
        hasFindAll,
        exposeGetOne,
        hasCreate,
        hasUpdate,
        hasRemove,
        customEndpoints: spec.endpoints.custom,
      }),
    },
    module: { entityName, entityFileBase, moduleClassName },
    index: { entityName, entityFileBase, moduleClassName, moduleFileBase },
    entityFileBase,
    moduleFileBase,
  };
}

function main() {
  const { 'library-dir': libraryDirArg, force } = parseArgs(['library-dir']);
  const libraryDir = path.resolve(libraryDirArg);
  const forceWrite = force === 'true';

  const spec = loadEntitySpec(path.join(libraryDir, 'entity-spec.json'));
  const ctx = buildContext(spec);
  const srcDir = path.join(libraryDir, 'src');

  // El generador Nx crea src/lib/<name>.module.ts + src/index.ts de forma
  // anidada; este sistema usa el patrón plano de courses/src, así que se
  // sustituye el andamiaje recién creado (sin uso real todavía) por los
  // ficheros generados a partir del spec.
  const libStubDir = path.join(srcDir, 'lib');
  if (fs.existsSync(libStubDir)) {
    fs.rmSync(libStubDir, { recursive: true, force: true });
  }

  writeFileSafe(
    path.join(srcDir, `${ctx.entityFileBase}.entity.ts`),
    renderTemplate('entity.ts.hbs', ctx.entity),
    forceWrite
  );
  writeFileSafe(
    path.join(srcDir, `${ctx.entityFileBase}.dto.ts`),
    renderTemplate('dto.ts.hbs', ctx.dto),
    forceWrite
  );
  writeFileSafe(
    path.join(srcDir, `${ctx.entityFileBase}.service.ts`),
    renderTemplate('service.ts.hbs', ctx.service),
    forceWrite
  );
  writeFileSafe(
    path.join(srcDir, `${ctx.entityFileBase}.controller.ts`),
    renderTemplate('controller.ts.hbs', ctx.controller),
    forceWrite
  );
  writeFileSafe(
    path.join(srcDir, `${ctx.moduleFileBase}.module.ts`),
    renderTemplate('module.ts.hbs', ctx.module),
    forceWrite
  );

  // index.ts es el barrel puramente derivado del spec (igual que en
  // courses/src/index.ts): se regenera siempre, recién creada la librería
  // en el paso 2 no puede tener ediciones manuales todavía.
  fs.writeFileSync(path.join(srcDir, 'index.ts'), renderTemplate('index.ts.hbs', ctx.index), 'utf-8');
  console.log(`Generado: ${path.join(srcDir, 'index.ts')}`);
}

main();

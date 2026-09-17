---
name: nestjs-entity-lib-gen
description: >
  Da de alta una nueva entidad de dominio del backend como una librería Nx
  independiente (libs/backend/<entidad>), con entity TypeORM, DTOs,
  service, controller, module y contrato OpenAPI, a partir de una
  conversación en lenguaje natural con el usuario. Se activa cuando el
  usuario pide crear una nueva entidad/recurso/módulo de dominio como
  librería NestJS ("crea la librería de Product", "necesito una entidad
  Category como librería Nx", "da de alta el dominio Invoice").
---

# NestJS Entity Library Generator

Genera, de forma consistente y auditable, una librería Nx completa para
una entidad de dominio nueva: entity TypeORM, DTOs, service, controller,
module y especificación OpenAPI. El resultado sigue exactamente el patrón
de ficheros planos de `courses/src/user.*.ts` (un fichero por
responsabilidad, directamente bajo `src/`, sin subcarpeta `src/lib`).

## Principio de diseño: determinista vs. asistido

- **Asistido (Claude, con el usuario)**: acordar propiedades, tipos,
  columnas, endpoints estándar a exponer y endpoints custom. Cualquier
  ambigüedad se pregunta; nunca se asume en silencio. El resultado es
  `entity-spec.json`, validado contra `schema/entity-spec.schema.json`.
- **Determinista (scripts, sin Claude)**: una vez existe `entity-spec.json`
  confirmado, la creación de la librería Nx, el YAML OpenAPI y los
  ficheros de código son 100% mecánicos — mismo spec, mismo resultado.

`entity-spec.json` es el contrato entre ambas partes. Ningún script de
generación interpreta ni decide: solo traduce ese JSON a código.

v1: propiedades planas + CRUD estándar + endpoints custom. Sin relaciones
entre entidades (se deja para una iteración futura).

## Flujo paso a paso

### Paso 1 — Definición conversacional (asistido)

Conversa con el usuario para acordar:

- `entityName` (PascalCase singular, ej. `Product`) y `tableName`
  (snake_case plural, ej. `products`).
- `properties`: `name`, `tsType` (`string`/`number`/`boolean`/`Date`/
  `uuid`), `columnType` (tipo de columna Postgres, ej. `varchar`,
  `numeric`, `timestamp`), `isPrimary`, `isUnique`, `isNullable`,
  `default` opcional. Debe existir exactamente una property con
  `isPrimary: true`.
- `endpoints.standard`: subconjunto de `GET_LIST`, `GET_ONE`, `POST`,
  `PATCH`, `DELETE` — por defecto los 5, salvo que el usuario indique lo
  contrario.
- `endpoints.custom`: métodos más allá del CRUD (`name`, `method`,
  `path` con parámetros estilo `:param`, `description`, `params`,
  `returns`), solo si el usuario los pide explícitamente.

Escribe el resultado en un fichero de staging propio del skill, p. ej.
`.claude/skills/nestjs-entity-lib-gen/.specs/<tabla-kebab>.json`, siguiendo
`schema/entity-spec.schema.json`. **Regla dura**: no pasar al paso 2 sin
un `entity-spec.json` completo y válido.

### Paso 2 — Creación de la librería Nx (determinista)

```bash
cd .claude/skills/nestjs-entity-lib-gen
npx ts-node scripts/create-library.ts --spec=.specs/<tabla-kebab>.json --repo-root=<ruta a la raíz del repo>
```

Lee `/entity-generator.config.json` (raíz del repo) para saber dónde y
con qué generador crear la librería (por defecto `@nx/nest:library` en
`libs/backend/<tabla-kebab>`, `importPath` `<npmScope>/<tabla-kebab>`).
Verifica con `nx show project` que se ha creado correctamente, añade el
glob de `workspaces` en el `package.json` raíz si hiciera falta, y copia
`entity-spec.json` a la raíz de la librería para trazabilidad. Si la
librería ya existe, aborta sin tocar nada (no regenera proyectos
existentes).

Tras este paso hay que ejecutar `npm install` en la raíz del repo para
que el import path de la nueva librería resuelva vía `node_modules`.

### Paso 3 — OpenAPI (determinista)

```bash
npx ts-node scripts/generate-openapi.ts --library-dir=<ruta a libs/backend/<tabla-kebab>>
```

Escribe `<librería>/openapi/<entidad-kebab>.openapi.yaml` (OpenAPI 3.0.3)
a partir de `entity-spec.json`, con `paths` para cada endpoint estándar
expuesto y cada endpoint custom, y `components.schemas` para la entidad,
`Create<Entidad>Dto` y `Update<Entidad>Dto`.

### Paso 4 — Ficheros de código vía Handlebars (determinista)

```bash
npx ts-node scripts/generate-library-files.ts --library-dir=<ruta a libs/backend/<tabla-kebab>>
```

Sustituye el andamiaje `src/lib/<nombre>.module.ts` que crea el generador
Nx (recién creado, sin uso real todavía) por el patrón plano de
`courses/src/user.*.ts`, renderizando las plantillas de `templates/*.hbs`:

- `<entidad-kebab>.entity.ts`
- `<entidad-kebab>.dto.ts`
- `<entidad-kebab>.service.ts`
- `<entidad-kebab>.controller.ts`
- `<tabla-kebab>.module.ts`
- `index.ts` (barrel, siempre regenerado)

Los ficheros de negocio (entity/dto/service/controller/module) nunca se
sobrescriben si ya existen, salvo `--force`: por defecto se escribe
`*.generated.ts` junto al original para que el usuario haga el merge a
mano.

### Paso 5 — Resumen para el usuario (asistido)

Presenta la lista de ficheros generados y recuerda el paso manual
pendiente, fuera del alcance de esta skill: importar el módulo
(`<Tabla>Module`, exportado desde `<npmScope>/<tabla-kebab>`) en el
`AppModule` de la aplicación NestJS que vaya a consumirlo.

## Archivos de esta skill

```
nestjs-entity-lib-gen/
├── SKILL.md
├── package.json
├── tsconfig.json
├── schema/
│   ├── generator-config.schema.json   # contrato de /entity-generator.config.json
│   └── entity-spec.schema.json        # contrato paso 1 → pasos 2-4
├── scripts/
│   ├── _shared.ts                     # tipos, naming, carga/validación, escritura segura
│   ├── create-library.ts              # paso 2
│   ├── generate-openapi.ts            # paso 3
│   └── generate-library-files.ts      # paso 4
├── templates/
│   ├── entity.ts.hbs
│   ├── dto.ts.hbs
│   ├── service.ts.hbs
│   ├── controller.ts.hbs
│   ├── module.ts.hbs
│   └── index.ts.hbs
└── .specs/                            # staging de entity-spec.json del paso 1
```

## Notas de implementación

- El nombre de librería (kebab, plural) se deriva de `tableName`, ya
  decidido por el usuario en el paso 1 — no se reinventa una heurística
  de pluralización.
- Las flags del generador Nx (`nxGenerator`/`nxGeneratorOptions` en
  `entity-generator.config.json`) deben confirmarse con `nx g <generador>
  --help` antes de cambiarlas; los scripts nunca las adivinan.
- Cada script de generación es independiente e idempotente: ejecutarlo
  dos veces con el mismo `entity-spec.json` produce el mismo resultado
  (o, para los ficheros de negocio, un `*.generated.ts` para mergear a
  mano si ya existían).

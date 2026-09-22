---
name: nestjs-entity-gen
description: >
  Genera una entidad TypeORM completa (entity, OpenAPI yaml, controller,
  API abstracta e implementación) a partir de una descripción en texto,
  detectando y confirmando relaciones con el modelo de datos existente
  en un proyecto NestJS + TypeORM + PostgreSQL. Se activa cuando el usuario
  pide crear una nueva entidad, un nuevo recurso/modelo, o un CRUD para
  NestJS con TypeORM ("crea la entidad Order", "necesito un nuevo modelo
  Invoice con estos campos", "genera el CRUD de Product").
---

# NestJS Entity Generator

Esta skill orquesta scripts deterministas y decisiones asistidas por Claude
para generar, de forma consistente y auditable, todos los artefactos que
requiere una nueva entidad en un proyecto NestJS + TypeORM + PostgreSQL:

1. Entity TypeORM (`*.entity.ts`)
2. Especificación OpenAPI (`*.openapi.yaml`)
3. Controller NestJS (`*.controller.ts`)
4. Interfaz de API abstracta (`*.api.interface.ts`)
5. Implementación de la API (`*.api.ts`) que llama al repositorio TypeORM

## Principio de diseño: determinista vs. asistido

No todo el proceso es mecánico. Esta skill separa explícitamente:

- **Determinista (scripts, sin Claude)**: parseo AST del modelo existente,
  extracción de campos/decoradores/FKs, y generación de código final a
  partir de una configuración YA confirmada. Mismo input → mismo output,
  siempre. Estos pasos NUNCA "adivinan" relaciones ni reglas de negocio.
- **Asistido (Claude, con el usuario)**: interpretar qué relaciones tienen
  sentido, decidir cascade/eager/onDelete, qué endpoints exponer, auth,
  paginación, métodos custom. Cualquier decisión de negocio o performance
  pasa por aquí y queda registrada en un JSON de configuración versionable.

El JSON de configuración confirmado es el contrato entre ambas partes:
una vez existe, toda la generación de código es 100% determinista.

## Flujo paso a paso

### Paso 1 — Extracción de hechos (determinista)

Ejecutar el script de escaneo sobre el proyecto del usuario:

```bash
npx ts-node scripts/scan-entities.ts \
  --entities-dir=<ruta a src/**/*.entity.ts del proyecto> \
  --output=/tmp/analysis-report.json
```

Esto NO decide nada. Solo produce un inventario objetivo:
- Todas las entities existentes, sus columnas, tipos, decoradores TypeORM.
- Relaciones YA existentes en el modelo (para no duplicarlas).
- Candidatos superficiales por convención de nombre de FK (ej. `userId`
  en `Post` cuando existe `User`), marcados solo como `signal`, nunca
  como una relación confirmada.

Ver `schema/analysis-report.schema.json` para el formato exacto.

### Paso 2 — Interpretación y confirmación (Claude, con el usuario)

Claude lee `analysis-report.json` y la descripción de la entidad nueva
dada por el usuario, y:

1. Propone qué relaciones tienen sentido semántico (no solo por nombre
   de campo), citando en qué señal del reporte se basa.
2. Pregunta al usuario para cada relación propuesta con confianza media
   o ambigua — usando el tool de opciones interactivas cuando esté
   disponible, o preguntas directas en texto si no.
3. Para cada relación confirmada, pregunta o decide con criterio explícito:
   - `cascade` (insert/update/remove)
   - `eager` (carga automática) — por defecto `false` salvo que el
     usuario indique que siempre necesita los datos relacionados
   - `onDelete` (`CASCADE` / `SET NULL` / `RESTRICT`) — por defecto
     `RESTRICT` si no hay indicación explícita, nunca asumir CASCADE
4. Decide (o pregunta) sobre la superficie de la API:
   - Qué endpoints exponer (`GET/POST/PATCH/DELETE`) — por defecto los
     4, salvo que el usuario indique lo contrario
   - Paginación (`offset` por defecto si el proyecto no tiene convención
     detectada en otras entidades)
   - Requisitos de auth (hereda el patrón dominante detectado en el
     análisis; si no hay patrón claro, pregunta)
   - Métodos custom más allá del CRUD básico

5. Escribe el resultado en `/tmp/entity-config.json` siguiendo
   `schema/entity-config.schema.json`. Este archivo es la única fuente
   de verdad para el paso 3.

**Regla dura**: Claude nunca debe pasar directamente a generar código sin
que exista `entity-config.json` completo. Si algo es ambiguo, se pregunta;
no se asume silenciosamente.

### Paso 3 — Generación de código (determinista)

Con `entity-config.json` confirmado, ejecutar en orden:

```bash
npx ts-node scripts/generate-entity.ts      --config=/tmp/entity-config.json --out=<src/entities>
npx ts-node scripts/generate-openapi.ts     --config=/tmp/entity-config.json --out=<openapi/>
npx ts-node scripts/generate-controller.ts  --config=/tmp/entity-config.json --out=<src/modules>
npx ts-node scripts/generate-service.ts     --config=/tmp/entity-config.json --out=<src/modules>
```

Cada script es independiente, idempotente, y solo lee ese JSON — no hace
preguntas, no infiere nada nuevo. Ejecutarlos dos veces con el mismo
`entity-config.json` produce exactamente el mismo código.

### Paso 4 — Resumen para el usuario

Claude presenta un resumen de los archivos generados y de las decisiones
tomadas (relaciones, cascade/eager/onDelete, endpoints expuestos), para
que el usuario pueda auditarlas antes de hacer commit.

## Archivos de esta skill

```
nestjs-entity-gen/
├── SKILL.md
├── schema/
│   ├── analysis-report.schema.json   # output del paso 1
│   └── entity-config.schema.json     # contrato paso 2 → paso 3
├── scripts/
│   ├── scan-entities.ts              # paso 1
│   ├── generate-entity.ts            # paso 3a
│   ├── generate-openapi.ts           # paso 3b
│   ├── generate-controller.ts        # paso 3c
│   └── generate-service.ts           # paso 3d
└── templates/
    └── (plantillas string usadas por los generate-*.ts)
```

## Notas de implementación

- El escaneo usa `ts-morph` (AST real de TypeScript), no regex, para no
  romperse con formateo distinto o decoradores en varias líneas.
- Todos los scripts son CLI con `--config`/`--output` explícitos, sin
  estado oculto, para que sean ejecutables también fuera de esta skill
  (ej. en CI) si el equipo quiere reusarlos.
- Los scripts de generación nunca sobrescriben un archivo existente sin
  el flag `--force`; por defecto generan `*.generated.ts` si detectan
  conflicto, para que el usuario haga el merge manualmente.

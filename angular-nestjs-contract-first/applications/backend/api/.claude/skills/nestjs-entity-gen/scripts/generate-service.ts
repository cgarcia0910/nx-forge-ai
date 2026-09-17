/**
 * generate-service.ts
 * DETERMINISTA. Genera:
 *  - <entity>.api.interface.ts  (contrato abstracto)
 *  - <entity>.api.ts            (implementación con @InjectRepository)
 *  - <entity>.dto.ts            (Create/Update DTOs con class-validator)
 *
 * Qué relaciones cargar (`relations: [...]`) sale directo de config.relationships
 * marcadas como eager=false pero necesarias para findOne, según lo ya decidido.
 *
 * Uso:
 *   npx ts-node generate-service.ts --config=/tmp/entity-config.json --out=src/modules [--force]
 */

import * as path from "path";
import { parseArgs, loadConfig, writeFileSafe, tsTypeToTs, pascalToCamel, pascalToKebab } from "./_shared";

function main() {
  const args = parseArgs(["config", "out"]);
  const config = loadConfig(args["config"]);
  const force = !!args["force"];

  const entity = config.entityName;
  const camel = pascalToCamel(entity);
  const kebab = pascalToKebab(entity);

  const relationNames = config.relationships.map((r) => r.propertyName);
  const relationsArrayLiteral =
    relationNames.length > 0 ? `[${relationNames.map((r) => `'${r}'`).join(", ")}]` : "[]";

  // ---- interfaz abstracta ----
  const interfaceMethods: string[] = [
    `  findAll(params?: FindAll${entity}Params): Promise<${entity}[]>;`,
    `  findOne(id: string): Promise<${entity} | null>;`,
    `  create(dto: Create${entity}Dto): Promise<${entity}>;`,
    `  update(id: string, dto: Update${entity}Dto): Promise<${entity}>;`,
    `  remove(id: string): Promise<void>;`,
  ];
  for (const custom of config.customMethods ?? []) {
    interfaceMethods.push(`  /** ${custom.description} */`);
    interfaceMethods.push(`  ${custom.name}(${custom.params.join(", ")}): Promise<${custom.returns}>;`);
  }

  const paginationParamsType =
    config.endpoints.pagination === "offset"
      ? `{ limit?: number; offset?: number }`
      : config.endpoints.pagination === "cursor"
      ? `{ cursor?: string; limit?: number }`
      : `Record<string, never>`;

  const interfaceContent = `import { ${entity} } from '../../entities/${kebab}.entity';
import { Create${entity}Dto, Update${entity}Dto } from './${kebab}.dto';

export type FindAll${entity}Params = ${paginationParamsType};

export interface ${entity}Api {
${interfaceMethods.join("\n")}
}
`;

  writeFileSafe(
    path.join(args["out"], kebab, `${kebab}.api.interface.ts`),
    interfaceContent,
    force
  );

  // ---- implementación TypeORM ----
  const paginationLogic =
    config.endpoints.pagination === "offset"
      ? `take: params?.limit ?? 20, skip: params?.offset ?? 0,`
      : config.endpoints.pagination === "cursor"
      ? `take: params?.limit ?? 20, /* cursor pagination: aplicar lógica de cursor sobre 'id' o campo ordenable */`
      : "";

  const customImplMethods = (config.customMethods ?? [])
    .map(
      (c) => `  // TODO: implementar lógica de negocio real para ${c.name}.
  // Generado como stub porque requiere decisión de negocio no capturable
  // automáticamente. Descripción: ${c.description}
  async ${c.name}(${c.params.join(", ")}): Promise<${c.returns}> {
    throw new Error('Not implemented: ${c.name}');
  }`
    )
    .join("\n\n");

  const implContent = `import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ${entity} } from '../../entities/${kebab}.entity';
import { ${entity}Api, FindAll${entity}Params } from './${kebab}.api.interface';
import { Create${entity}Dto, Update${entity}Dto } from './${kebab}.dto';

@Injectable()
export class ${entity}ApiImpl implements ${entity}Api {
  constructor(
    @InjectRepository(${entity})
    private readonly repository: Repository<${entity}>,
  ) {}

  findAll(params?: FindAll${entity}Params): Promise<${entity}[]> {
    return this.repository.find({
      relations: ${relationsArrayLiteral},
      ${paginationLogic}
    });
  }

  findOne(id: string): Promise<${entity} | null> {
    return this.repository.findOne({
      where: { id } as any,
      relations: ${relationsArrayLiteral},
    });
  }

  async create(dto: Create${entity}Dto): Promise<${entity}> {
    const entityInstance = this.repository.create(dto as Partial<${entity}>);
    return this.repository.save(entityInstance);
  }

  async update(id: string, dto: Update${entity}Dto): Promise<${entity}> {
    await this.repository.update(id, dto as Partial<${entity}>);
    const updated = await this.findOne(id);
    if (!updated) {
      throw new Error('${entity} no encontrado tras actualizar: ' + id);
    }
    return updated;
  }

  async remove(id: string): Promise<void> {
    await this.repository.delete(id);
  }

${customImplMethods || "  // Sin métodos custom definidos en entity-config.json"}
}
`;

  writeFileSafe(path.join(args["out"], kebab, `${kebab}.api.ts`), implContent, force);

  // ---- DTOs ----
  const validatorFor = (tsType: string, isNullable?: boolean) => {
    const optional = isNullable ? "@IsOptional()\n  " : "";
    switch (tsType) {
      case "uuid":
        return `${optional}@IsUUID()`;
      case "number":
        return `${optional}@IsNumber()`;
      case "boolean":
        return `${optional}@IsBoolean()`;
      case "Date":
        return `${optional}@IsDateString()`;
      default:
        return `${optional}@IsString()`;
    }
  };

  const createFields = config.fields
    .filter((f) => !f.isPrimary)
    .map((f) => {
      return `  ${validatorFor(f.tsType, f.isNullable)}\n  ${f.name}${f.isNullable ? "?" : ""}: ${tsTypeToTs(f)};`;
    })
    .join("\n\n");

  const dtoContent = `import { IsString, IsNumber, IsBoolean, IsUUID, IsDateString, IsOptional } from 'class-validator';
import { PartialType } from '@nestjs/mapped-types';

export class Create${entity}Dto {
${createFields}
}

export class Update${entity}Dto extends PartialType(Create${entity}Dto) {}
`;

  writeFileSafe(path.join(args["out"], kebab, `${kebab}.dto.ts`), dtoContent, force);
}

main();

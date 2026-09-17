/**
 * generate-controller.ts
 * DETERMINISTA. Traduce entity-config.json a un controller NestJS que
 * delega en la interfaz abstracta de API (ver generate-service.ts).
 * Guards y decisiones de auth ya vienen resueltos en el config.
 *
 * Uso:
 *   npx ts-node generate-controller.ts --config=/tmp/entity-config.json --out=src/modules [--force]
 */

import * as path from "path";
import { parseArgs, loadConfig, writeFileSafe, pascalToCamel, pascalToKebab } from "./_shared";

function main() {
  const args = parseArgs(["config", "out"]);
  const config = loadConfig(args["config"]);
  const force = !!args["force"];

  const entity = config.entityName;
  const camel = pascalToCamel(entity);
  const kebab = pascalToKebab(entity);
  const base = config.endpoints.basePath ?? `${kebab}s`;
  const apiToken = `${entity}Api`;

  const guardImport = config.endpoints.auth.required
    ? `import { ${config.endpoints.auth.guard ?? "JwtAuthGuard"} } from '../../auth/${pascalToKebab(
        config.endpoints.auth.guard ?? "JwtAuthGuard"
      )}';\n`
    : "";
  const guardDecorator = config.endpoints.auth.required
    ? `@UseGuards(${config.endpoints.auth.guard ?? "JwtAuthGuard"})\n`
    : "";

  const paginationParams =
    config.endpoints.pagination === "offset"
      ? `@Query('limit') limit?: number, @Query('offset') offset?: number`
      : config.endpoints.pagination === "cursor"
      ? `@Query('cursor') cursor?: string, @Query('limit') limit?: number`
      : "";

  const paginationArgs =
    config.endpoints.pagination === "offset"
      ? "{ limit, offset }"
      : config.endpoints.pagination === "cursor"
      ? "{ cursor, limit }"
      : "";

  const methods: string[] = [];

  if (config.endpoints.expose.includes("GET_LIST")) {
    methods.push(`  @Get()
  findAll(${paginationParams}) {
    return this.${camel}Api.findAll(${paginationArgs});
  }`);
  }

  if (config.endpoints.expose.includes("GET_ONE")) {
    methods.push(`  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.${camel}Api.findOne(id);
  }`);
  }

  if (config.endpoints.expose.includes("POST")) {
    methods.push(`  @Post()
  create(@Body() dto: Create${entity}Dto) {
    return this.${camel}Api.create(dto);
  }`);
  }

  if (config.endpoints.expose.includes("PATCH")) {
    methods.push(`  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: Update${entity}Dto) {
    return this.${camel}Api.update(id, dto);
  }`);
  }

  if (config.endpoints.expose.includes("DELETE")) {
    methods.push(`  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.${camel}Api.remove(id);
  }`);
  }

  for (const custom of config.customMethods ?? []) {
    methods.push(`  // ${custom.description}
  @Get('${pascalToKebab(custom.name)}')
  ${custom.name}(${custom.params.join(", ")}) {
    return this.${camel}Api.${custom.name}(${custom.params.map((p) => p.split(":")[0].trim()).join(", ")});
  }`);
  }

  const content = `import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  Inject${config.endpoints.auth.required ? ",\n  UseGuards" : ""}
} from '@nestjs/common';
${guardImport}import { ${entity}Api } from './${kebab}.api.interface';
import { Create${entity}Dto, Update${entity}Dto } from './${kebab}.dto';

@Controller('${base}')
${guardDecorator}export class ${entity}Controller {
  constructor(
    @Inject('${apiToken}') private readonly ${camel}Api: ${entity}Api,
  ) {}

${methods.join("\n\n")}
}
`;

  const outPath = path.join(args["out"], kebab, `${kebab}.controller.ts`);
  writeFileSafe(outPath, content, force);
}

main();

/**
 * create-library.ts (paso 2 — determinista)
 *
 * Lee entity-generator.config.json (raíz del repo) + entity-spec.json
 * (paso 1, ya confirmado) y crea la librería Nx correspondiente invocando
 * el generador configurado. No decide nada: mismo spec + misma config,
 * mismo resultado.
 *
 * Uso:
 *   npx ts-node scripts/create-library.ts --spec=<ruta a entity-spec.json> --repo-root=<ruta raíz del repo>
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { loadEntitySpec, loadGeneratorConfig, libraryNameFrom, parseArgs } from './_shared';

function optionsToArgs(options: Record<string, unknown> | undefined): string[] {
  if (!options) return [];
  const args: string[] = [];
  for (const [key, value] of Object.entries(options)) {
    if (typeof value === 'boolean') {
      args.push(value ? `--${key}` : `--${key}=false`);
    } else {
      args.push(`--${key}=${String(value)}`);
    }
  }
  return args;
}

/**
 * Los imports @npmScope/<lib> solo resuelven vía node_modules si el
 * directorio de librerías está cubierto por "workspaces" del package.json
 * raíz. Se añade el glob una única vez, de forma idempotente.
 */
function ensureWorkspacesGlob(repoRoot: string, librariesRoot: string) {
  const pkgPath = path.join(repoRoot, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  const glob = `${librariesRoot}/*`;
  const workspaces: string[] = pkg.workspaces ?? [];
  if (workspaces.includes(glob)) return;

  pkg.workspaces = [...workspaces, glob];
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
  console.log(`Añadido "${glob}" a workspaces en ${pkgPath}`);
}

/**
 * Todas las librerías generadas por este skill usan siempre TypeORM +
 * @nestjs/typeorm + decoradores de @nestjs/common (paso 4, plantillas
 * entity/service/module). Cuando el generador crea un package.json propio
 * para la librería (modo "buildable"/"publishable"), se declaran ahí como
 * dependencies para que @nx/dependency-checks no falle, tomando las
 * versiones ya fijadas en el package.json raíz.
 *
 * Con la config actual (sin "buildable") el generador NO crea package.json:
 * la librería se resuelve vía tsconfig paths y comparte el mismo programa
 * de compilación que la app consumidora, por lo que las dependencies del
 * package.json raíz ya cubren la resolución en node_modules. No hay nada
 * que declarar en ese caso.
 */
function ensureLibraryDependencies(absoluteLibraryDir: string, repoRoot: string) {
  const libPkgPath = path.join(absoluteLibraryDir, 'package.json');
  if (!fs.existsSync(libPkgPath)) {
    console.log(
      `${libPkgPath} no existe (librería no buildable/publishable): las dependencies se resuelven ` +
        `desde el package.json raíz, no hace falta declararlas por librería.`
    );
    return;
  }

  const requiredDeps = ['@nestjs/common', '@nestjs/typeorm', 'typeorm'];
  const rootPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8'));
  const libPkg = JSON.parse(fs.readFileSync(libPkgPath, 'utf-8'));

  libPkg.dependencies ??= {};
  for (const dep of requiredDeps) {
    const version = rootPkg.dependencies?.[dep];
    if (!version) {
      throw new Error(`${dep} no está declarado en las dependencies del package.json raíz.`);
    }
    libPkg.dependencies[dep] = version;
  }

  fs.writeFileSync(libPkgPath, JSON.stringify(libPkg, null, 2) + '\n', 'utf-8');
  console.log(`Añadidas dependencies (${requiredDeps.join(', ')}) a ${libPkgPath}`);
}

function main() {
  const { spec: specPath, 'repo-root': repoRootArg } = parseArgs(['spec']);
  const repoRoot = path.resolve(repoRootArg ?? process.cwd());

  const config = loadGeneratorConfig(repoRoot);
  const spec = loadEntitySpec(path.resolve(specPath));

  const libraryName = libraryNameFrom(spec.tableName);
  const libraryDir = path.join(config.librariesRoot, libraryName);
  const absoluteLibraryDir = path.join(repoRoot, libraryDir);
  const importPath = `${config.npmScope}/${libraryName}`;

  if (fs.existsSync(absoluteLibraryDir)) {
    console.error(
      `${libraryDir} ya existe. create-library.ts no regenera proyectos existentes ` +
        `(evita romper una librería ya en uso). Elimínala primero si quieres recrearla.`
    );
    process.exit(1);
  }

  const generatorArgs = [
    'g',
    config.nxGenerator,
    `--name=${libraryName}`,
    `--directory=${libraryDir}`,
    `--importPath=${importPath}`,
    ...optionsToArgs(config.nxGeneratorOptions),
  ];

  console.log(`Ejecutando: npx nx ${generatorArgs.join(' ')}`);
  execFileSync('npx', ['nx', ...generatorArgs], { cwd: repoRoot, stdio: 'inherit' });

  ensureWorkspacesGlob(repoRoot, config.librariesRoot);

  const verifyOutput = execFileSync('npx', ['nx', 'show', 'project', libraryName, '--json'], {
    cwd: repoRoot,
    encoding: 'utf-8',
  });
  const project = JSON.parse(verifyOutput);
  if (!project?.root || project.root !== libraryDir) {
    throw new Error(
      `El generador no creó el proyecto esperado en ${libraryDir}. ` +
        `nx show project devolvió root="${project?.root}".`
    );
  }

  ensureLibraryDependencies(absoluteLibraryDir, repoRoot);

  const specDestination = path.join(absoluteLibraryDir, 'entity-spec.json');
  fs.copyFileSync(path.resolve(specPath), specDestination);
  console.log(`Copiado entity-spec.json a ${specDestination}`);

  console.log(`Librería creada: ${libraryDir} (importPath: ${importPath})`);
}

main();

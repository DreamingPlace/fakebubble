import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { buildSync } from 'esbuild';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const compiler = join(repoRoot, 'node_modules/typescript/bin/tsc');
const buildConfig = JSON.parse(
  readFileSync(new URL('../apps/player-web/tsconfig.build.json', import.meta.url), 'utf8'),
) as { compilerOptions: Record<string, unknown> };
const allowedAsset = /\.(?:css|svg|png|jpe?g|webp|woff2)$/i;
const safeName = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assertSourcePath(root: string, path: string) {
  const rel = relative(root, path);
  if (!rel || rel.startsWith('..') || rel.split(sep).some((part) => !safeName.test(part)))
    throw new Error('PLAYER_ASSET_UNSAFE');
  let current = root;
  for (const part of rel.split(sep)) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error('PLAYER_ASSET_UNSAFE');
  }
}

export interface PlayerBuildOptions {
  root: string;
  output: string;
}

/** Only an E-owned entry and its TS import graph are emitted. No repository-wide copy. */
export function buildWebPlayer({ root, output }: PlayerBuildOptions) {
  const source = join(root, 'apps/player-web');
  const main = join(source, 'src/app/main.ts');
  const html = join(source, 'src/app/index.html');
  if (!existsSync(main) || !existsSync(html)) throw new Error('PLAYER_ENTRY_MISSING');
  for (const path of [main, html]) {
    assertSourcePath(root, path);
    if (!lstatSync(path).isFile()) throw new Error('PLAYER_ENTRY_INVALID');
  }
  if (lstatSync(html).size > 2_000_000) throw new Error('PLAYER_ASSET_UNSAFE');
  const stage = mkdtempSync(join(root, '.web-player-build-'));
  try {
    const config = join(stage, 'tsconfig.json');
    writeFileSync(
      config,
      JSON.stringify({
        compilerOptions: { ...buildConfig.compilerOptions, rootDir: root, outDir: join(stage, 'output') },
        files: [main],
      }),
    );
    const result = spawnSync(process.execPath, [compiler, '-p', config], {
      cwd: root,
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 2_000_000,
    });
    if (result.status !== 0) throw new Error(`PLAYER_EMIT_FAILED\n${result.stdout || ''}${result.stderr || ''}`);
    const emitted = join(stage, 'output');
    if (!existsSync(join(emitted, 'apps/player-web/src/app/main.js'))) throw new Error('PLAYER_EMIT_MISSING');
    const files: string[] = [];
    const walk = (base: string, path: string, asset: boolean) => {
      if (!existsSync(path)) return;
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        if (!safeName.test(entry.name) || entry.isSymbolicLink()) throw new Error('PLAYER_ASSET_UNSAFE');
        const next = join(path, entry.name);
        if (entry.isDirectory()) walk(base, next, asset);
        else if (
          !entry.isFile() ||
          (asset ? !allowedAsset.test(entry.name) : !entry.name.endsWith('.js')) ||
          lstatSync(next).size > 2_000_000
        )
          throw new Error('PLAYER_ASSET_UNSAFE');
        else files.push(relative(base, next).split(sep).join('/'));
      }
    };
    walk(emitted, emitted, false);
    if (files.some((path) => !path.startsWith('apps/player-web/src/') && !path.startsWith('packages/contracts/')))
      throw new Error('PLAYER_EMIT_SCOPE');
    for (const name of files) {
      const source = ts.createSourceFile(
        name,
        readFileSync(join(emitted, name), 'utf8'),
        ts.ScriptTarget.ES2023,
        true,
        ts.ScriptKind.JS,
      );
      const checkImport = (specifier: ts.Expression | undefined) => {
        if (
          !specifier ||
          !ts.isStringLiteral(specifier) ||
          !specifier.text.startsWith('.') ||
          !specifier.text.endsWith('.js') ||
          !existsSync(resolve(join(emitted, name), '..', specifier.text))
        )
          throw new Error('PLAYER_BROWSER_IMPORT_UNSUPPORTED');
      };
      const visit = (node: ts.Node) => {
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
          if (node.moduleSpecifier) checkImport(node.moduleSpecifier);
        } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          checkImport(node.arguments[0]);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    // Bundle only the already typechecked, scope/import-validated browser graph.
    const bundled = join(stage, 'bundled');
    const bundle = buildSync({
      entryPoints: [join(emitted, 'apps/player-web/src/app/main.js')],
      outdir: bundled,
      bundle: true,
      splitting: true,
      format: 'esm',
      platform: 'browser',
      target: ['safari16', 'chrome110'],
      entryNames: 'assets/[name]-[hash]',
      chunkNames: 'assets/[name]-[hash]',
      minify: true,
      legalComments: 'none',
      metafile: true,
      write: true,
    });
    const entry = Object.entries(bundle.metafile.outputs).find(([, value]) =>
      value.entryPoint?.endsWith('/apps/player-web/src/app/main.js'),
    )?.[0];
    if (!entry) throw new Error('PLAYER_EMIT_MISSING');
    const entryName = relative(bundled, resolve(entry)).split(sep).join('/');
    files.length = 0;
    walk(bundled, bundled, false);
    let page = readFileSync(html, 'utf8').replace('/apps/player-web/src/app/main.js', '/' + entryName);
    const replacements: [string, string][] = [];
    const addAsset = (path: string, dest: string) => {
      if (!existsSync(path)) throw new Error('PLAYER_ASSET_MISSING');
      assertSourcePath(root, path);
      if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink() || lstatSync(path).size > 2_000_000)
        throw new Error('PLAYER_ASSET_UNSAFE');
      const bytes = readFileSync(path);
      const digest = createHash('sha256').update(bytes).digest('hex');
      const extension = dest.slice(dest.lastIndexOf('.'));
      const name = `assets/static-${digest}${extension}`;
      mkdirSync(join(bundled, 'assets'), { recursive: true });
      copyFileSync(path, join(bundled, name));
      page = page.replaceAll('/' + dest, '/' + name);
      replacements.push([dest, name]);
      if (!files.includes(name)) files.push(name);
    };
    // Explicit source allowlist remains the only way non-JS assets enter the build.
    const assetList = join(source, 'player-assets.json');
    const assets: unknown = existsSync(assetList) ? JSON.parse(readFileSync(assetList, 'utf8')) : [];
    if (
      !Array.isArray(assets) ||
      assets.length > 128 ||
      !assets.every(
        (value) =>
          typeof value === 'string' &&
          value.split('/').every((part) => safeName.test(part) && part !== '..') &&
          allowedAsset.test(value),
      )
    )
      throw new Error('PLAYER_ASSET_LIST_INVALID');
    for (const name of assets as string[]) addAsset(join(source, name), `apps/player-web/${name}`);
    writeFileSync(join(bundled, 'index.html'), page);
    files.push('index.html');
    // Part 17: two static legal pages. Plain HTML with no script; only the stylesheet reference is rewritten to the hashed
    // asset. They are always built; the edge serves them only while LEGAL_PAGES_ENABLED is on.
    for (const name of ['privacy.html', 'terms.html']) {
      const path = join(source, 'src/legal', name);
      // Optional: a source tree without them (the build unit-test fixtures) simply has no legal pages.
      if (!existsSync(path)) continue;
      assertSourcePath(root, path);
      if (!lstatSync(path).isFile() || lstatSync(path).size > 200_000) throw new Error('PLAYER_ASSET_UNSAFE');
      let legal = readFileSync(path, 'utf8');
      if (/<script/i.test(legal)) throw new Error('PLAYER_ASSET_UNSAFE');
      for (const [dest, hashed] of replacements) legal = legal.replaceAll('/' + dest, '/' + hashed);
      writeFileSync(join(bundled, name), legal);
      files.push(name);
    }
    if (files.length > 256 || new Set(files).size !== files.length) throw new Error('PLAYER_ASSET_LIST_INVALID');
    if (existsSync(output) && (!lstatSync(output).isDirectory() || lstatSync(output).isSymbolicLink()))
      throw new Error('PLAYER_OUTPUT_UNSAFE');
    mkdirSync(output, { recursive: true });
    const safeDestination = (name: string) => {
      let parent = output;
      for (const part of name.split('/').slice(0, -1)) {
        parent = join(parent, part);
        if (!existsSync(parent)) mkdirSync(parent);
        if (!lstatSync(parent).isDirectory() || lstatSync(parent).isSymbolicLink())
          throw new Error('PLAYER_OUTPUT_UNSAFE');
      }
      const dest = join(output, name);
      if (existsSync(dest) && (!lstatSync(dest).isFile() || lstatSync(dest).isSymbolicLink()))
        throw new Error('PLAYER_OUTPUT_UNSAFE');
      return dest;
    };
    const manifest: Record<string, string> = {};
    for (const name of files.sort()) {
      const src = join(bundled, name),
        dest = safeDestination(name);
      copyFileSync(src, dest);
      manifest[name] = createHash('sha256').update(readFileSync(dest)).digest('hex');
    }
    const manifestPath = join(output, 'player-manifest.json');
    const pending = join(output, `player-manifest-${process.pid}.tmp`);
    writeFileSync(pending, JSON.stringify({ version: 1, files: manifest }), { flag: 'wx' });
    renameSync(pending, manifestPath);
    return { output, files: files.length };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = join(repoRoot, 'apps/player-web/dist');
  try {
    process.stdout.write(JSON.stringify(buildWebPlayer({ root: repoRoot, output })) + '\n');
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

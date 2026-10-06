import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { testModules } from '../tests/cloudflare/modules.ts';
import { ensure } from '../packages/domain/errors.ts';

const workers = ['edge', 'business', 'budget', 'generation'] as const;
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const joseRoot = resolve(dirname(createRequire(import.meta.url).resolve('jose')), '../..');
const sourceName = (path: string) =>
  path.startsWith(joseRoot + '/') ? 'vendor/jose/' + relative(joseRoot, path) : relative(resolve('.'), path);
const safePath = (path: string) => path.split('/').every((part) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part));
function assetBytes(root: string, path: string) {
  ensure(safePath(path), 'WEB_PACKAGE_ASSET_INVALID');
  let current = resolve(root);
  ensure(lstatSync(current).isDirectory() && !lstatSync(current).isSymbolicLink(), 'WEB_PACKAGE_ASSET_INVALID');
  for (const part of path.split('/')) {
    current = join(current, part);
    ensure(!lstatSync(current).isSymbolicLink(), 'WEB_PACKAGE_ASSET_INVALID');
  }
  const stat = lstatSync(current);
  ensure(stat.isFile() && stat.size <= 2_000_000, 'WEB_PACKAGE_ASSET_INVALID');
  return readFileSync(current);
}

/** Fresh offline package only: AST-reachable production modules + exact player build manifest.
 * No runtime scan, dotenv discovery, provider materials, fixture entrypoints or cloud writes. */
export function stageWebCloudflarePackage(output: string, assets: string) {
  const graphs = workers.map((name) => ({ name, modules: testModules(`workers/web-cloudflare/${name}.ts`) }));
  const definitions = new Map(graphs.flatMap((graph) => graph.modules.map((module) => [module.path, module] as const)));
  const files = new Map<string, string>();
  for (const [path, module] of definitions) {
    const source = sourceName(path);
    ensure(
      !source.startsWith('../') &&
        (/^(apps\/server\/|packages\/|workers\/web-cloudflare\/|workers\/audio\/|config\/|vendor\/jose\/)/.test(
          source,
        ) ||
          source === 'workers/cloudflare/migrations.ts') &&
        !/(^|\/)(?:\.env[^/]*|\.secrets|runtime|work|tests)(\/|$)/.test(source) &&
        ['ESModule', 'Text'].includes(module.type),
      'WEB_PACKAGE_SOURCE_FORBIDDEN',
    );
    files.set(path, 'modules/' + hash(source) + (module.type === 'Text' ? '.sql' : '.mjs'));
  }
  const manifestBytes = assetBytes(assets, 'player-manifest.json');
  ensure(manifestBytes.length <= 65_536, 'WEB_PACKAGE_ASSET_INVALID');
  const assetManifest = JSON.parse(manifestBytes.toString('utf8')) as {
    version: number;
    files: Record<string, string>;
  };
  ensure(
    Object.keys(assetManifest).sort().join(',') === 'files,version' &&
      assetManifest.version === 1 &&
      assetManifest.files &&
      typeof assetManifest.files === 'object' &&
      !Array.isArray(assetManifest.files),
    'WEB_PACKAGE_ASSET_INVALID',
  );
  const entries = Object.entries(assetManifest.files);
  ensure(
    entries.length > 0 && entries.length <= 256 && entries.some(([path]) => path === 'index.html'),
    'WEB_PACKAGE_ASSET_INVALID',
  );
  const staticFiles = entries.map(([path, digest]) => {
    ensure(
      /\.(?:html|js|css|svg|png|jpe?g|webp|woff2)$/.test(path) && /^[a-f0-9]{64}$/.test(digest),
      'WEB_PACKAGE_ASSET_INVALID',
    );
    const bytes = assetBytes(assets, path);
    ensure(hash(bytes) === digest, 'WEB_PACKAGE_ASSET_INTEGRITY');
    return { path, bytes };
  });
  mkdirSync(output, { recursive: false, mode: 0o700 });
  mkdirSync(join(output, 'modules'), { mode: 0o700 });
  const manifest: { path: string; source: string; sha256: string; bytes: number }[] = [];
  const write = (path: string, source: string, content: string | Uint8Array) => {
    mkdirSync(dirname(join(output, path)), { recursive: true, mode: 0o700 });
    writeFileSync(join(output, path), content, { flag: 'wx', mode: 0o600 });
    manifest.push({
      path,
      source,
      sha256: hash(content),
      bytes: typeof content === 'string' ? Buffer.byteLength(content) : content.byteLength,
    });
  };
  for (const [path, module] of definitions) {
    ensure(typeof module.contents === 'string', 'WEB_PACKAGE_SOURCE_INVALID');
    let content = module.contents;
    if (module.type === 'ESModule') {
      const parsed = ts.createSourceFile(path, content, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
      const edits: { start: number; end: number; value: string }[] = [];
      const visit = (node: ts.Node) => {
        ensure(
          !(
            ts.isCallExpression(node) &&
            (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
              (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
          ),
          'WEB_PACKAGE_DYNAMIC_IMPORT_FORBIDDEN',
        );
        if (
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier &&
          ts.isStringLiteral(node.moduleSpecifier)
        ) {
          const name = node.moduleSpecifier.text;
          if (name.startsWith('.')) {
            const target = files.get(resolve(dirname(path), name));
            ensure(target, 'WEB_PACKAGE_MODULE_MISSING');
            edits.push({
              start: node.moduleSpecifier.getStart(parsed),
              end: node.moduleSpecifier.end,
              value: JSON.stringify('./' + target.slice('modules/'.length)),
            });
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(parsed);
      for (const edit of edits.sort((a, b) => b.start - a.start))
        content = content.slice(0, edit.start) + edit.value + content.slice(edit.end);
    }
    write(files.get(path)!, sourceName(path), content);
  }
  write('jose-LICENSE.md', 'vendor/jose/LICENSE.md', readFileSync(join(joseRoot, 'LICENSE.md'), 'utf8'));
  for (const file of staticFiles) write('player-assets/' + file.path, 'player-client-build', file.bytes);
  write('player-assets/player-manifest.json', 'player-client-build', manifestBytes);
  for (const { name } of graphs) {
    const source = `workers/web-cloudflare/deploy/${name}.json.example`,
      config = JSON.parse(readFileSync(source, 'utf8'));
    config.main = './' + files.get(resolve(`workers/web-cloudflare/${name}.ts`));
    config.rules = [{ type: 'Text', globs: ['**/*.sql'], fallthrough: true }];
    if (name === 'edge') {
      config.assets.directory = './player-assets';
      config.vars.ASSET_MANIFEST_SHA256 = hash(manifestBytes);
    }
    write(name + '.json', source, JSON.stringify(config, null, 2) + '\n');
  }
  writeFileSync(
    join(output, 'package-manifest.json'),
    JSON.stringify(
      {
        version: 1,
        deployable: false,
        note: 'Defaults closed. Exact resource identities, upload approval and secret provisioning are still required.',
        files: manifest,
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  return { workers: workers.length, files: manifest.length + 1, bytes: manifest.reduce((n, row) => n + row.bytes, 0) };
}
if (import.meta.main) {
  const [output] = process.argv.slice(2);
  ensure(output && process.argv.length === 3, 'WEB_PACKAGE_OUTPUT_REQUIRED');
  console.log(JSON.stringify(stageWebCloudflarePackage(resolve(output), resolve('apps/player-web/dist'))));
}

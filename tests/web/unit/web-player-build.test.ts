import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildWebPlayer } from '../../../scripts/build-web-player.ts';
import { serveLocalStatic } from '../../../apps/server/platform/web-local-static.ts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'web-player-build-'));
  const app = join(root, 'apps/player-web/src/app');
  mkdirSync(app, { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  return { root, app, output: join(root, 'apps/player-web/dist') };
}

test('missing E entry fails without inventing a player page', () => {
  const site = fixture();
  assert.throws(() => buildWebPlayer(site), /PLAYER_ENTRY_MISSING/);
});

test('HTML keeps the source asset size bound before bundle rewriting', () => {
  const site = fixture();
  writeFileSync(join(site.app, 'main.ts'), 'export {};');
  writeFileSync(join(site.app, 'index.html'), ' '.repeat(2_000_001));
  assert.throws(() => buildWebPlayer(site), /PLAYER_ASSET_UNSAFE/);
});

test('fixture emits browser JS and explicit CSS only; unrelated files stay private', () => {
  const site = fixture();
  writeFileSync(join(site.app, 'main.ts'), "import { greeting } from './small.ts'; document.title = greeting;\n");
  writeFileSync(join(site.app, 'small.ts'), "export const greeting: string = 'fixture';\n");
  writeFileSync(
    join(site.app, 'index.html'),
    '<!doctype html><script type="module" src="/apps/player-web/src/app/main.js"></script>',
  );
  mkdirSync(join(site.root, 'apps/player-web/src/styles'), { recursive: true });
  writeFileSync(join(site.root, 'apps/player-web/src/styles/main.css'), 'body{color:red}');
  writeFileSync(join(site.root, 'apps/player-web/player-assets.json'), '["src/styles/main.css"]');
  mkdirSync(join(site.root, 'runtime'), { recursive: true });
  writeFileSync(join(site.root, 'runtime/private.key'), 'never public');
  const result = buildWebPlayer(site);
  // Part 15 named exception: main + dependency are now one bundle; keep the explicit CSS/HTML allowlist.
  assert.equal(result.files, 3);
  const names = Object.keys(JSON.parse(readFileSync(join(site.output, 'player-manifest.json'), 'utf8')).files);
  const mainName = names.find((name) => /^assets\/main-[A-Z0-9]{8}\.js$/.test(name))!;
  const js = readFileSync(join(site.output, mainName), 'utf8');
  assert.match(js, /fixture/);
  assert.doesNotMatch(js, /from[\s\S]*small/);
  assert.doesNotMatch(js, /small\.ts/);
  const manifest = JSON.parse(readFileSync(join(site.output, 'player-manifest.json'), 'utf8'));
  assert.equal(Object.keys(manifest.files).length, 3);
  assert.equal(
    manifest.files['index.html'],
    createHash('sha256')
      .update(readFileSync(join(site.output, 'index.html')))
      .digest('hex'),
  );
  assert.ok(!('runtime/private.key' in manifest.files));
});

test('static manifest permits only exact GET/HEAD and keeps API outside SPA', async () => {
  const site = fixture();
  writeFileSync(join(site.app, 'main.ts'), 'document.title = "fixture";\n');
  writeFileSync(join(site.app, 'index.html'), '<!doctype html><html><body>fixture</body></html>');
  mkdirSync(join(site.root, 'apps/player-web/src/styles'), { recursive: true });
  writeFileSync(join(site.root, 'apps/player-web/src/styles/main.css'), 'body{color:red}');
  writeFileSync(join(site.root, 'apps/player-web/player-assets.json'), '["src/styles/main.css"]');
  buildWebPlayer(site);
  // Part 15 named exception: discover generated paths, never accept old unhashed endpoints.
  const names = Object.keys(JSON.parse(readFileSync(join(site.output, 'player-manifest.json'), 'utf8')).files);
  const mainName = names.find((name) => /^assets\/main-[A-Z0-9]{8}\.js$/.test(name))!;
  const cssName = names.find((name) => name.endsWith('.css'))!;
  mkdirSync(join(site.root, 'runtime'), { recursive: true });
  writeFileSync(join(site.root, 'runtime/private.key'), 'private fixture');
  const server = createServer((req, res) => {
    if (!serveLocalStatic(req, res, site.output)) {
      res.writeHead(418);
      res.end('api untouched');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const get = (path: string, method = 'GET') => fetch(base + path, { method });
    const html = await get('/');
    assert.equal(html.status, 200);
    assert.equal(html.headers.get('cache-control'), 'no-store');
    assert.equal((await get('/player-manifest.json')).headers.get('cache-control'), 'no-store');
    assert.equal(html.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(html.headers.get('x-content-type-options'), 'nosniff');
    assert.match(await html.text(), /fixture/);
    const js = await get('/' + mainName);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type') ?? '', /text\/javascript/);
    const css = await get('/' + cssName);
    assert.equal(css.status, 200);
    for (const asset of [js, css])
      assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal((await get('/apps/player-web/src/app/main.js')).status, 404);
    assert.match(css.headers.get('content-type') ?? '', /text\/css/);
    assert.equal((await get('/', 'HEAD')).status, 200);
    assert.equal((await get('/missing')).status, 404);
    assert.equal((await get('/api/web/local/missing')).status, 418);
    assert.equal((await get('/runtime/private.key')).status, 404);
    const encoded = await new Promise<number>((resolveStatus, reject) => {
      const req = request({ hostname: '127.0.0.1', port: address.port, path: '/%2e%2e/runtime/private.key' }, (res) => {
        res.resume();
        res.on('end', () => resolveStatus(res.statusCode ?? 0));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(encoded, 404);
    assert.equal((await get('/' + mainName, 'POST')).status, 405);
    symlinkSync(join(site.root, 'runtime/private.key'), join(site.output, 'assets/link.js'));
    assert.equal((await get('/assets/link.js')).status, 404);
    writeFileSync(join(site.output, 'index.html'), 'tampered');
    assert.equal((await get('/')).status, 503);
    const main = join(site.output, mainName);
    rmSync(main);
    symlinkSync(join(site.root, 'runtime/private.key'), main);
    assert.equal((await get('/' + mainName)).status, 503);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('static absent build returns explicit unavailable', async () => {
  const site = fixture();
  const server = createServer((req, res) => {
    serveLocalStatic(req, res, site.output);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const res = await fetch(`http://127.0.0.1:${address.port}/`);
    assert.equal(res.status, 503);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'PLAYER_BUILD_UNAVAILABLE');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('bundles are content-addressed and admin code is reachable only through its lazy import', () => {
  const site = fixture();
  writeFileSync(join(site.app, 'index.html'), '<script type="module" src="/apps/player-web/src/app/main.js"></script>');
  writeFileSync(
    join(site.app, 'main.ts'),
    "document.title='player'; if(location.search==='?admin') void import('./admin.ts');",
  );
  writeFileSync(join(site.app, 'admin.ts'), "document.title='ADMIN_ONLY_SENTINEL'; export {}; ");
  buildWebPlayer(site);
  const manifest = () =>
    JSON.parse(readFileSync(join(site.output, 'player-manifest.json'), 'utf8')).files as Record<string, string>;
  const before = manifest();
  const entry = Object.keys(before).find((name) => name.includes('/main-'))!;
  const admin = Object.keys(before).find((name) => name.includes('/admin-'))!;
  assert.ok(admin);
  const js = readFileSync(join(site.output, entry), 'utf8');
  assert.match(js, /import\("\.\/admin-[A-Z0-9]{8}\.js"\)/);
  assert.doesNotMatch(js, /ADMIN_ONLY_SENTINEL/);
  assert.match(readFileSync(join(site.output, admin), 'utf8'), /ADMIN_ONLY_SENTINEL/);
  assert.ok(
    Object.keys(before).every((name) => name === 'index.html' || /^assets\/[\w-]+-[A-Z0-9]{8}\.js$/.test(name)),
  );
  writeFileSync(join(site.app, 'admin.ts'), "document.title='ADMIN_CHANGED_SENTINEL'; export {}; ");
  buildWebPlayer(site);
  const after = manifest();
  assert.ok(!Object.hasOwn(after, admin), 'changed lazy code gets a different address');
  assert.ok(!Object.hasOwn(after, entry), 'the referencing entry changes too');
  for (const [name, digest] of Object.entries(after)) assert.equal(hashFile(name), digest);
  function hashFile(name: string) {
    return createHash('sha256')
      .update(readFileSync(join(site.output, name)))
      .digest('hex');
  }
});

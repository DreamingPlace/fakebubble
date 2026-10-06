import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { localRuntime } from '../../../apps/server/platform/web-local-config.ts';
import { buildWebPlayer } from '../../../scripts/build-web-player.ts';

const runtime = localRuntime();
const script = resolve('scripts/web-v1.ts');
const dist = resolve('apps/player-web/dist');

type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer };

function call(ca: Buffer, method: string, path: string): Promise<Reply> {
  return new Promise((resolveReply, reject) => {
    const req = httpsRequest({ hostname: '127.0.0.1', port: runtime.port, path, method, ca }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () =>
        resolveReply({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

async function start(root: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, [script, 'serve', root], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '',
    stderr = '';
  child.stderr!.on('data', (chunk) => {
    stderr += String(chunk).slice(0, 800);
  });
  await new Promise<void>((resolveReady, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(Error(`serve timeout: ${stderr}`));
    }, 10_000);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(Error(`serve exit ${code}: ${stderr}`));
    });
    child.stdout!.on('data', (chunk) => {
      stdout += String(chunk);
      if (stdout.includes('"action":"serve"')) {
        clearTimeout(timeout);
        resolveReady();
      }
    });
  });
  return child;
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveExit, reject) => {
    const timeout = setTimeout(() => reject(Error('serve stop timeout')), 5_000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolveExit();
    });
    child.kill('SIGTERM');
  });
}

test('C fixed A-S4-002: independent TLS static boundary with synthetic build only', async () => {
  // The local server serves this fixed path, so move any real build aside and restore it afterwards.
  const preserved = existsSync(dist) ? `${dist}.preserved-${randomUUID().slice(0, 8)}` : null;
  if (preserved) renameSync(dist, preserved);
  const instance = join(runtime.parent, `local-c-static-${randomUUID().slice(0, 8)}`);
  const fixture = mkdtempSync(join(runtime.parent, 'fixture-c-static-'));
  let child: ChildProcess | null = null;
  try {
    for (const action of ['init', 'migrate']) {
      const done = spawnSync(process.execPath, [script, action, instance], { encoding: 'utf8', timeout: 30_000 });
      assert.equal(done.status, 0, `${action}: ${done.stderr}`);
    }
    const ca = readFileSync(join(instance, 'local-cert.pem'));
    child = await start(instance);
    const missing = await call(ca, 'GET', '/');
    assert.equal(missing.status, 503);
    assert.equal(JSON.parse(missing.body.toString()).error.code, 'PLAYER_BUILD_UNAVAILABLE');
    assert.equal((await call(ca, 'GET', '/health')).status, 200);
    assert.equal((await call(ca, 'GET', '/api/web/local/missing')).status, 401);

    const app = join(fixture, 'apps/player-web/src/app');
    const styles = join(fixture, 'apps/player-web/src/styles');
    mkdirSync(app, { recursive: true });
    mkdirSync(styles, { recursive: true });
    assert.throws(() => buildWebPlayer({ root: fixture, output: dist }), /PLAYER_ENTRY_MISSING/);
    writeFileSync(join(app, 'main.ts'), "import { label } from './label.ts'; document.title = label;\n");
    writeFileSync(join(app, 'label.ts'), "export const label: string = 'C fixture';\n");
    writeFileSync(
      join(app, 'index.html'),
      '<!doctype html><link rel="stylesheet" href="/apps/player-web/src/styles/main.css"><script type="module" src="/apps/player-web/src/app/main.js"></script>',
    );
    mkdirSync(join(fixture, 'runtime'), { recursive: true });
    writeFileSync(join(fixture, 'runtime/private.key'), 'C private fixture, never serve');
    const assetList = join(fixture, 'apps/player-web/player-assets.json');
    writeFileSync(assetList, '["../../runtime/private.key"]');
    assert.throws(() => buildWebPlayer({ root: fixture, output: dist }), /PLAYER_ASSET_LIST_INVALID/);
    writeFileSync(assetList, '["src/styles/main.css"]');
    symlinkSync(join(fixture, 'runtime/private.key'), join(styles, 'main.css'));
    assert.throws(() => buildWebPlayer({ root: fixture, output: dist }), /PLAYER_ASSET_UNSAFE/);
    rmSync(join(styles, 'main.css'));
    writeFileSync(join(styles, 'main.css'), 'body { color: #123456; }');
    const built = buildWebPlayer({ root: fixture, output: dist });
    assert.equal(built.files, 4);
    const manifest = JSON.parse(readFileSync(join(dist, 'player-manifest.json'), 'utf8')) as {
      files: Record<string, string>;
    };
    assert.deepEqual(Object.keys(manifest.files).sort(), [
      'apps/player-web/src/app/label.js',
      'apps/player-web/src/app/main.js',
      'apps/player-web/src/styles/main.css',
      'index.html',
    ]);
    for (const [name, hash] of Object.entries(manifest.files)) {
      assert.equal(
        createHash('sha256')
          .update(readFileSync(join(dist, name)))
          .digest('hex'),
        hash,
      );
    }
    assert.match(readFileSync(join(dist, 'apps/player-web/src/app/main.js'), 'utf8'), /\.\/label\.js/);
    const html = await call(ca, 'GET', '/');
    assert.equal(html.status, 200);
    assert.equal(html.headers['content-type'], 'text/html; charset=utf-8');
    assert.match(String(html.headers['content-security-policy']), /default-src 'none'/);
    assert.equal(html.headers['set-cookie'], undefined);
    assert.match(html.body.toString(), /main\.js/);
    const head = await call(ca, 'HEAD', '/');
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);
    assert.equal(head.headers['content-length'], String(html.body.length));
    assert.equal((await call(ca, 'GET', '/apps/player-web/src/app/main.js')).status, 200);
    const css = await call(ca, 'GET', '/apps/player-web/src/styles/main.css');
    assert.equal(css.status, 200);
    assert.equal(css.headers['content-type'], 'text/css; charset=utf-8');
    assert.equal((await call(ca, 'GET', '/runtime/private.key')).status, 404);
    assert.equal((await call(ca, 'GET', '/%2e%2e/runtime/private.key')).status, 404);
    assert.equal((await call(ca, 'POST', '/')).status, 405);
    assert.equal((await call(ca, 'GET', '/api/web/local/missing')).status, 401);
    writeFileSync(join(dist, 'apps/player-web/src/styles/main.css'), 'tampered');
    assert.equal((await call(ca, 'GET', '/apps/player-web/src/styles/main.css')).status, 503);
    assert.equal((await call(ca, 'GET', '/health')).status, 200);
    const main = join(dist, 'apps/player-web/src/app/main.js');
    rmSync(main);
    symlinkSync(join(fixture, 'runtime/private.key'), main);
    assert.equal((await call(ca, 'GET', '/apps/player-web/src/app/main.js')).status, 503);
    console.log(
      JSON.stringify({
        cStatic: 'synthetic-local TLS',
        instance,
        port: runtime.port,
        build: 'C fixture, not E bundle',
        files: built.files,
      }),
    );
  } finally {
    if (child) await stop(child);
    rmSync(dist, { recursive: true, force: true });
    if (preserved) renameSync(preserved, dist);
    rmSync(fixture, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import test from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { join, resolve } from 'node:path';
import { localRuntime, readLocalConfig } from '../../../apps/server/platform/web-local-config.ts';
import { WebStore } from '../../../apps/server/platform/store.ts';

const runtime = localRuntime(),
  script = resolve('scripts/web-v1.ts');
const origin = `https://127.0.0.1:${runtime.port}`;
function instance() {
  const root = join(runtime.parent, `local-c-readonly-${randomUUID().slice(0, 8)}`);
  for (const action of ['init', 'migrate']) {
    const done = spawnSync(process.execPath, [script, action, root], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(done.status, 0, `${action}: ${done.stderr}`);
  }
  return { root, ca: readFileSync(join(root, 'local-cert.pem')) };
}
async function start(root: string) {
  const child = spawn(process.execPath, [script, 'serve', root], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '',
    error = '';
  child.stderr!.on('data', (chunk) => {
    error += String(chunk).slice(0, 500);
  });
  await new Promise<void>((resolveReady, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(Error('serve timeout'));
    }, 8_000);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(Error(`serve exited ${code}: ${error}`));
    });
    child.stdout!.on('data', (chunk) => {
      output += String(chunk);
      if (output.includes('"action":"serve"')) {
        clearTimeout(timeout);
        resolveReady();
      }
    });
  });
  return child;
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
  child.kill('SIGTERM');
  await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(Error('stop timeout')), 5_000))]);
}
type Reply = { status: number; json: any; headers: Record<string, string | string[] | undefined> };
class Client {
  cookie = '';
  csrf = '';
  readonly ca: Buffer;
  constructor(ca: Buffer) {
    this.ca = ca;
  }
  call(method: string, path: string, payload?: unknown): Promise<Reply> {
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    return new Promise((resolveReply, reject) => {
      const req = httpsRequest(
        {
          hostname: '127.0.0.1',
          port: runtime.port,
          ca: this.ca,
          path,
          method,
          headers: {
            ...(this.cookie ? { Cookie: this.cookie } : {}),
            ...(method === 'POST' ? { Origin: origin, 'X-CSRF-Token': this.csrf } : {}),
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          res.on('end', () => {
            const bytes = Buffer.concat(chunks).toString('utf8');
            const json = JSON.parse(bytes);
            const issued = res.headers['set-cookie']?.[0]?.split(';')[0];
            if (issued) this.cookie = issued;
            if (typeof json?.csrf === 'string') this.csrf = json.csrf;
            resolveReply({ status: res.statusCode ?? 0, json, headers: res.headers });
          });
        },
      );
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }
}
function snapshot(root: string) {
  const config = readLocalConfig(root);
  const store = new WebStore(root, { create: false, instanceId: config.instanceId });
  try {
    return Object.fromEntries(
      ['web_principals', 'web_sessions', 'web_ip_windows', 'web_operations', 'messages', 'web_local_events'].map(
        (table) => [table, store.all<Record<string, unknown>>(`SELECT * FROM ${table}`).map((row) => ({ ...row }))],
      ),
    );
  } finally {
    store.close();
  }
}

test('C S4 real TLS: access and by-request are read-only, current-scope, no-store, and 404 is ambiguous', async (t) => {
  const { root, ca } = instance(),
    child = await start(root);
  t.after(async () => {
    await stop(child);
  });
  const alice = new Client(ca),
    bob = new Client(ca),
    anon = new Client(ca);
  const a = await alice.call('GET', '/api/web/local/bootstrap');
  const b = await bob.call('GET', '/api/web/local/bootstrap');
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.notEqual(a.json.access.principalId, b.json.access.principalId);
  assert.notEqual(a.json.access.worldId, b.json.access.worldId);
  const before = snapshot(root);
  assert.equal((await anon.call('GET', '/api/web/local/access')).status, 401);
  assert.equal((await anon.call('GET', '/api/web/local/operations/by-request/unknown')).status, 401);
  for (let i = 0; i < 3; i++) {
    const access = await alice.call('GET', '/api/web/local/access');
    assert.equal(access.status, 200);
    assert.deepEqual(access.json, a.json.access);
    assert.equal(access.headers['cache-control'], 'no-store');
    const missing = await alice.call('GET', '/api/web/local/operations/by-request/unknown');
    assert.equal(missing.status, 404);
    assert.equal(missing.headers['cache-control'], 'no-store');
  }
  assert.deepEqual(snapshot(root), before, 'read-only requests changed principal/session/guest/quota data');
  const accepted = await alice.call('POST', '/api/web/local/characters/synthetic-local/operations', {
    requestId: 'c-s4-one',
    text: 'C synthetic input',
    delivery: 'voice',
  });
  assert.equal(accepted.status, 202);
  const own = await alice.call('GET', '/api/web/local/operations/by-request/c-s4-one');
  assert.equal(own.status, 200);
  assert.equal(own.json.operationId, accepted.json.operation.operationId);
  assert.equal(own.headers['cache-control'], 'no-store');
  assert.equal((await bob.call('GET', '/api/web/local/operations/by-request/c-s4-one')).status, 404);
  assert.equal((await anon.call('GET', '/api/web/local/operations/by-request/c-s4-one')).status, 401);
  const registered = await alice.call('POST', '/api/web/local/register', {
    requestId: 'c-s4-register',
    username: `c_s4_${randomUUID().slice(0, 8)}`,
    password: 'synthetic-pass-123',
  }); // gitleaks:allow -- fixed offline fixture password, never a real account.
  assert.equal(registered.status, 200);
  // Wait for the admitted synthetic job, not an arbitrary delay: its publisher is an independent writer.
  const deadline = Date.now() + 10_000;
  while (true) {
    const settled = await alice.call('GET', '/api/web/local/operations/by-request/c-s4-one');
    assert.equal(settled.status, 200);
    if (settled.json.status === 'published') break;
    assert.ok(!['failed', 'cancelled', 'unknown'].includes(settled.json.status), settled.json.status);
    assert.ok(Date.now() < deadline, 'synthetic publication did not settle');
    await pause(20);
  }
  const config = readLocalConfig(root);
  const controlled = new WebStore(root, { create: false, instanceId: config.instanceId });
  try {
    controlled.run(
      `UPDATE web_sessions SET last_active_at=?
    WHERE principal_id=? AND revoked_at IS NULL`,
      Date.now() - 5 * 60_000,
      a.json.access.principalId,
    );
  } finally {
    controlled.close();
  }
  const accountBefore = snapshot(root);
  for (let i = 0; i < 3; i++) {
    const access = await alice.call('GET', '/api/web/local/access');
    assert.equal(access.status, 200);
    assert.equal(access.json.kind, 'account');
    assert.equal((await alice.call('GET', '/api/web/local/operations/by-request/c-s4-one')).status, 200);
  }
  assert.deepEqual(snapshot(root), accountBefore, 'account reads extended idle or changed business state');
  // A missing lookup does not prove an operation was never accepted; C's lost-receipt test preserves it.
  console.log(JSON.stringify({ cS4Readonly: 'ok', root, port: runtime.port }));
});

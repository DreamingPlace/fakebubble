import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { resolve } from 'node:path';
import { WebStore } from '../apps/server/store.ts';
import { localRuntime, readLocalConfig } from '../apps/server/web-local-config.ts';

const { parent, port } = localRuntime();
const root = resolve(parent, `local-restart-${randomUUID().slice(0, 12)}`);
const script = resolve('scripts/web-v1.ts');
let child: ChildProcess | null = null;

function run(action: string, expected = 0) {
  const result = spawnSync(process.execPath, [script, action, root],
    { encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, expected, `${action} exited ${result.status}: ${result.stderr}`);
  return result;
}
async function start() {
  const processChild = spawn(process.execPath, [script, 'serve-data-lifecycle', root],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  child = processChild;
  await new Promise<void>((resolveReady, reject) => {
    let output = '', errors = '';
    const timeout = setTimeout(() => reject(new Error(`serve timeout: ${errors.slice(0, 300)}`)), 10_000);
    processChild.once('exit', code => {
      clearTimeout(timeout); reject(new Error(`serve exited ${code}: ${errors.slice(0, 300)}`));
    });
    processChild.stderr!.on('data', chunk => { errors += String(chunk); });
    processChild.stdout!.on('data', chunk => {
      output += String(chunk);
      if (output.includes('"action":"serve-data-lifecycle"')) {
        clearTimeout(timeout); resolveReady();
      }
    });
  });
}
async function stop() {
  if (!child) return;
  const current = child; child = null;
  if (current.exitCode !== null) return;
  current.kill('SIGTERM');
  await new Promise<void>((resolveExit, reject) => {
    const timeout = setTimeout(() => reject(new Error('serve did not stop')), 5000);
    current.once('exit', () => { clearTimeout(timeout); resolveExit(); });
  });
}

try {
  run('init'); run('migrate');
  run('serve-data-lifecycle', 1); // Explicit serve still requires completed 110.
  run('migrate-data-lifecycle');
  run('migrate-data-lifecycle', 1); // No implicit replay or second migration.
  const config = readLocalConfig(root), ca = readFileSync(`${root}/local-cert.pem`);
  assert.equal(config.port, port);
  run('serve', 1); // The old route must never silently accept 110.
  run('migrate', 1); // Nor may old migrate auto-advance or re-run it.
  const guest = { cookie: '', csrf: '' }, account = { cookie: '', csrf: '' };
  async function call(method: string, path: string, body?: unknown, client = guest) {
    const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return new Promise<{ status: number; data: any; bytes: Buffer }>((resolveResponse, reject) => {
      const req = httpsRequest({ hostname: '127.0.0.1', port, path, method, ca,
        headers: { ...(client.cookie ? { Cookie: client.cookie } : {}), ...(bytes ? {
          'Content-Type': 'application/json', Origin: config.origin, 'X-CSRF-Token': client.csrf } : {}) } }, res => {
          const chunks: Buffer[] = [];
          res.on('data', chunk => chunks.push(Buffer.from(chunk)));
          res.on('end', () => {
            const raw = Buffer.concat(chunks), set = res.headers['set-cookie']?.[0]?.split(';')[0];
            if (set) client.cookie = set;
            let data: any = null;
            try { data = JSON.parse(raw.toString('utf8')); } catch { /* WAV or empty */ }
            if (typeof data?.csrf === 'string') client.csrf = data.csrf;
            resolveResponse({ status: res.statusCode ?? 0, data, bytes: raw });
          });
        });
      req.on('error', reject);
      if (bytes) req.write(bytes);
      req.end();
    });
  }
  await start();
  const initial = await call('GET', '/api/web/local/bootstrap');
  assert.equal(initial.status, 200);
  assert.equal(initial.data.contractVersion, 'web-v1-local-2');
  const principalId = initial.data.access.principalId;
  assert.equal((await call('GET', '/api/web/local/bootstrap', undefined, account)).status, 200);
  const registered = await call('POST', '/api/web/local/register',
    { requestId: 'healthy-register', username: `a3_${randomUUID().slice(0, 8)}`,
      password: 'synthetic-passphrase' }, account);
  assert.equal(registered.status, 200);
  const accountPrincipalId = registered.data.principalId;
  const sent = await call('POST', '/api/web/local/characters/synthetic-local/operations',
    { requestId: 'restart-once', text: 'synthetic restart marker', delivery: 'voice' });
  assert.equal(sent.status, 202);
  const operationId = sent.data.operation.operationId, conversationId = sent.data.operation.conversationId;
  let published: any = null;
  for (let i = 0; i < 60; i++) {
    const response = await call('GET', `/api/web/local/operations/${operationId}`);
    if (response.data?.status === 'published') { published = response.data; break; }
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  assert.ok(published, 'synthetic operation must publish before restart');
  const historyPath = `/api/web/local/conversations/${conversationId}/history`;
  const history = await call('GET', historyPath);
  assert.equal(history.status, 200);
  const voice = history.data.messages.find((message: any) => message.audio?.status === 'ready');
  assert.ok(voice);
  const mediaPath = `/api/web/local/conversations/${conversationId}/messages/${voice.messageId}` +
    `/audio/${voice.audio.mediaId}`;
  assert.equal((await call('GET', mediaPath)).status, 200);
  const accountCursor = (await call('GET', '/api/web/local/bootstrap', undefined, account)).data.syncCursor;
  assert.equal((await call('GET', `/api/web/local/sync?cursor=${encodeURIComponent(accountCursor)}`,
    undefined, account)).status, 200);
  await stop();

  await start(); // Fresh Node process, fresh WebStore, same synthetic root and identity.
  const resumed = await call('GET', '/api/web/local/bootstrap');
  assert.equal(resumed.data.access.principalId, principalId);
  assert.equal(resumed.data.access.trialRemaining, 2);
  assert.equal((await call('GET', historyPath)).status, 200);
  assert.equal((await call('GET', mediaPath)).status, 200);
  assert.equal((await call('GET', '/api/web/local/operations/by-request/restart-once')).data.status, 'published');
  assert.equal((await call('GET', `/api/web/local/sync?cursor=${encodeURIComponent(accountCursor)}`,
    undefined, account)).status, 200);
  await stop();

  await start();
  let accountStreamEnded = false;
  let streamReady!: () => void;
  const streamStarted = new Promise<void>(resolveReady => { streamReady = resolveReady; });
  const accountStream = httpsRequest({ hostname: '127.0.0.1', port,
    path: `/api/web/local/events?cursor=${encodeURIComponent(accountCursor)}`,
    method: 'GET', ca, headers: { Cookie: account.cookie } }, res => {
      assert.equal(res.statusCode, 200);
      res.on('data', () => streamReady());
      res.on('end', () => { accountStreamEnded = true; });
    });
  accountStream.on('error', () => { accountStreamEnded = true; });
  accountStream.end();
  await Promise.race([streamStarted, new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('account SSE did not start')), 2000))]);
  // Synthetic clock-jump fixture only; not a claim of a two-hour wall-clock wait.
  const store = new WebStore(root, { create: false, instanceId: config.instanceId,
    dataLifecycleTest: true });
  try {
    const now = Date.now();
    store.run(`UPDATE web_guest_retention SET started_at=?,expires_at=?,revision=revision+1
      WHERE principal_id=? AND state='active'`, now - 3 * 60 * 60_000, now - 1, principalId);
  } finally { store.close(); }
  const expired = await call('GET', '/api/web/local/bootstrap');
  assert.equal(expired.data.access.retentionState, 'expired');
  assert.deepEqual(expired.data.conversations, []);
  for (const path of [historyPath, mediaPath, `/api/web/local/operations/${operationId}`,
    '/api/web/local/operations/by-request/restart-once']) {
    const response = await call('GET', path);
    assert.equal(response.status, 410, path);
    assert.equal(response.bytes.includes(Buffer.from('synthetic restart marker')), false);
  }
  const audit = new WebStore(root, { create: false, instanceId: config.instanceId,
    dataLifecycleTest: true });
  let allocatedHigh = 0;
  try {
    for (let i = 0; i < 60; i++) {
      if (audit.get<{ state: string }>('SELECT state FROM web_guest_retention WHERE principal_id=?',
        principalId)?.state === 'purged') break;
      await new Promise(resolveWait => setTimeout(resolveWait, 50));
    }
    assert.equal(audit.get<{ state: string }>(
      'SELECT state FROM web_guest_retention WHERE principal_id=?', principalId)?.state, 'purged');
    const max = audit.get<{ seq: number }>('SELECT coalesce(max(seq),0) seq FROM web_local_events')!.seq;
    const high = audit.get<{ seq: number }>(
      "SELECT seq FROM sqlite_sequence WHERE name='web_local_events'")!.seq;
    allocatedHigh = high;
    const tail = audit.all<{ seq: number; principal_id: string; kind: string }>(
      'SELECT seq,principal_id,kind FROM web_local_events ORDER BY seq DESC LIMIT 3');
    assert.ok(high > max, `fixture must purge highest guest events (allocated=${high},live=${max},tail=${JSON.stringify(
      tail.map(row => ({ seq: row.seq, actor: row.principal_id === accountPrincipalId ? 'account' :
        row.principal_id === principalId ? 'guest' : 'other', kind: row.kind })))})`);
    assert.ok(audit.get('SELECT 1 FROM web_local_events WHERE principal_id=?', accountPrincipalId));
  } finally { audit.close(); }
  const accountSync = await call('GET', `/api/web/local/sync?cursor=${encodeURIComponent(accountCursor)}`,
    undefined, account);
  assert.equal(accountSync.status, 200, 'guest purge must not invalidate healthy account cursor');
  const futureFields = JSON.parse(Buffer.from(accountCursor.split('.')[0]!, 'base64url').toString('utf8'));
  futureFields[5] = allocatedHigh + 1;
  const futurePayload = Buffer.from(JSON.stringify(futureFields)).toString('base64url');
  const futureMac = createHmac('sha256', Buffer.from(config.cursorKey, 'base64url'))
    .update(futurePayload).digest('base64url');
  const future = await call('GET', `/api/web/local/sync?cursor=${encodeURIComponent(
    `${futurePayload}.${futureMac}`)}`, undefined, account);
  assert.equal(future.data?.error?.code, 'INVALID_CURSOR', 'unallocated future cursor remains invalid');
  await new Promise(resolveWait => setTimeout(resolveWait, 650));
  assert.equal(accountStreamEnded, false, 'guest purge must not close healthy account SSE');
  accountStream.destroy();
  await stop();
  await start();
  assert.equal((await call('GET', `/api/web/local/sync?cursor=${encodeURIComponent(accountCursor)}`,
    undefined, account)).status, 200, 'cursor remains valid after another real process restart');
  await stop();
  const final = new WebStore(root, { create: false, instanceId: config.instanceId,
    dataLifecycleTest: true });
  try {
    assert.equal(final.get<{ state: string }>('SELECT state FROM web_guest_retention WHERE principal_id=?',
      principalId)?.state, 'purged');
    assert.equal(final.get<{ used_total: number }>('SELECT used_total FROM web_ip_lifetime_quota')?.used_total, 1);
    assert.equal(final.get('PRAGMA foreign_key_check'), undefined);
  } finally { final.close(); }
  process.stdout.write('synthetic local-2 restart TLS: PASS\n');
} finally {
  await stop();
  rmSync(root, { recursive: true, force: true });
}

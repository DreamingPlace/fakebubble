import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import { resolve } from 'node:path';
import { localRuntime } from '../apps/server/web-local-config.ts';
import { readLocalConfig } from '../apps/server/web-local-config.ts';
import { WebStore } from '../apps/server/store.ts';

const runtime = localRuntime();
const root = resolve(runtime.parent, `local-check-${randomUUID().slice(0, 8)}`);
const origin = `https://127.0.0.1:${runtime.port}`;
const script = resolve('scripts/web-v1.ts');
for (const action of ['init', 'migrate']) {
  const result = spawnSync(process.execPath, [script, action, root], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, `${action}: ${result.stderr}`);
}
const ca = readFileSync(`${root}/local-cert.pem`);
let child: ChildProcess | null = null;
async function start() {
  const process = spawn(globalThis.process.execPath, [script, 'serve', root], {
    stdio: ['ignore', 'pipe', 'pipe'] });
  child = process;
  let output = '', errors = '';
  process.stderr!.on('data', chunk => { errors += String(chunk).slice(0, 500); });
  await new Promise<void>((resolveReady, reject) => {
    const timeout = setTimeout(() => reject(new Error(`serve timeout: ${errors}`)), 10_000);
    process.once('exit', code => { clearTimeout(timeout); reject(new Error(`serve exited ${code}: ${errors}`)); });
    process.stdout!.on('data', chunk => {
      output += String(chunk);
      if (output.includes('"action":"serve"')) { clearTimeout(timeout); resolveReady(); }
    });
  });
}
async function stop() {
  if (!child) return;
  const process = child; child = null;
  if (process.exitCode !== null) return;
  process.kill('SIGTERM');
  await new Promise<void>((resolveExit, reject) => {
    const timeout = setTimeout(() => reject(new Error('serve did not stop')), 5000);
    process.once('exit', () => { clearTimeout(timeout); resolveExit(); });
  });
}
type Response = { status: number; headers: IncomingHttpHeaders; data: any; bytes: Buffer };
class Client {
  cookie = '';
  csrf = '';
  async call(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Response> {
    const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const headers: Record<string, string> = {
      ...(this.cookie ? { Cookie: this.cookie } : {}),
      ...(bytes ? { 'Content-Type': 'application/json', Origin: origin,
        'X-CSRF-Token': this.csrf } : {}), ...extra };
    return new Promise((resolveResponse, reject) => {
      const req = httpsRequest({ hostname: '127.0.0.1', port: runtime.port, path, method, ca, headers }, res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(Buffer.from(chunk)));
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          let data: any = null;
          try { data = JSON.parse(raw.toString('utf8')); } catch { /* WAV or empty response */ }
          const cookie = res.headers['set-cookie']?.[0]?.split(';')[0];
          if (cookie) this.cookie = cookie;
          if (typeof data?.csrf === 'string') this.csrf = data.csrf;
          resolveResponse({ status: res.statusCode ?? 0, headers: res.headers, data, bytes: raw });
        });
      });
      req.on('error', reject);
      if (bytes) req.write(bytes);
      req.end();
    });
  }
}
function delayedWrite(client: Client, path: string, first: string, last: string) {
  let finish!: () => void;
  const response = new Promise<Response>((resolveResponse, reject) => {
    const req = httpsRequest({ hostname: '127.0.0.1', port: runtime.port, path, method: 'POST', ca,
      headers: { Cookie: client.cookie, Origin: origin, 'X-CSRF-Token': client.csrf,
        'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const bytes = Buffer.concat(chunks);
        resolveResponse({ status: res.statusCode ?? 0, headers: res.headers,
          data: JSON.parse(bytes.toString('utf8')), bytes });
      });
    });
    req.on('error', reject);
    req.write(first);
    finish = () => req.end(last);
  });
  return { finish: () => finish(), response };
}
async function sse(client: Client, cursor: string) {
  const seen: any[] = [];
  let end!: () => void;
  const ended = new Promise<void>(resolveEnd => { end = resolveEnd; });
  return new Promise<{ seen: any[]; ended: Promise<void>; close: () => void }>((resolveStream, reject) => {
    const req = httpsRequest({ hostname: '127.0.0.1', port: runtime.port,
      path: `/api/web/local/events?cursor=${encodeURIComponent(cursor)}`, method: 'GET', ca,
      headers: { Cookie: client.cookie } }, res => {
      assert.equal(res.statusCode, 200);
      let pending = '';
      res.on('data', chunk => {
        pending += String(chunk);
        while (pending.includes('\n\n')) {
          const index = pending.indexOf('\n\n'), block = pending.slice(0, index);
          pending = pending.slice(index + 2);
          const data = block.split('\n').find(line => line.startsWith('data: '));
          if (data) seen.push(JSON.parse(data.slice(6)));
        }
      });
      res.once('end', end);
      resolveStream({ seen, ended, close: () => req.destroy() });
    });
    req.on('error', reject); req.end();
  });
}
async function published(client: Client, operationId: string) {
  for (let i = 0; i < 50; i++) {
    const status = await client.call('GET', `/api/web/local/operations/${operationId}`);
    if (status.data?.status === 'published') return status.data;
    if (status.data?.status === 'failed' || status.data?.status === 'unknown')
      throw new Error(`operation terminal: ${status.data.status}/${status.data.errorCode}`);
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  throw new Error('operation did not publish');
}

try {
  await start();
  const duplicateServer = spawnSync(process.execPath, [script, 'serve', root],
    { encoding: 'utf8', timeout: 5_000 });
  assert.notEqual(duplicateServer.status, 0, 'second server must not acquire the coordinator or port');
  assert.equal(duplicateServer.signal, null, 'second server must fail promptly rather than hang');
  const alice = new Client(), bob = new Client();
  const manifestPath = resolve('apps/player-web/dist/player-manifest.json');
  const page = await alice.call('GET', '/');
  if (existsSync(manifestPath)) {
    // A present build has a specific, hash-checked expected response; 503 is never accepted here.
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      version: number; files: Record<string, string> };
    assert.equal(manifest.version, 1);
    for (const name of ['index.html', 'apps/player-web/src/app/main.js',
      'apps/player-web/src/styles/main.css']) {
      assert.match(manifest.files[name] ?? '', /^[a-f0-9]{64}$/, `${name} absent from real build`);
      const response = name === 'index.html' ? page : await alice.call('GET', `/${name}`);
      assert.equal(response.status, 200, `${name} must be served, not fallback/unavailable`);
      assert.equal(createHash('sha256').update(response.bytes).digest('hex'), manifest.files[name]);
      assert.equal(response.headers['x-content-type-options'], 'nosniff');
    }
    assert.match(String(page.headers['content-type']), /^text\/html/);
  } else {
    assert.equal(existsSync(resolve('apps/player-web/src/app/main.ts')) ||
      existsSync(resolve('apps/player-web/src/app/index.html')), false,
    'E entry exists but no browser build manifest; build before TLS verification');
    assert.equal(page.status, 503, 'absent build must not become a fake homepage');
    assert.equal(page.data.error.code, 'PLAYER_BUILD_UNAVAILABLE');
  }
  assert.equal((await alice.call('GET', '/api/web/local/missing')).status, 401,
    'API route must not receive an SPA/static fallback');
  const bootstrap = await alice.call('GET', '/api/web/local/bootstrap');
  assert.equal(bootstrap.status, 200);
  assert.equal(bootstrap.data.contractVersion, 'web-v1-local-1');
  assert.equal(bootstrap.data.mode, 'synthetic-local');
  assert.equal(bootstrap.data.characters[0].audition.state, 'unavailable');
  const anon = new Client();
  assert.equal((await anon.call('GET', '/api/web/local/access')).status, 401);
  assert.equal((await anon.call('GET', '/api/web/local/operations/by-request/missing')).status, 401);
  const accessBefore = await alice.call('GET', '/api/web/local/access');
  assert.equal(accessBefore.status, 200);
  assert.equal(accessBefore.headers['cache-control'], 'no-store');
  assert.deepEqual(accessBefore.data, bootstrap.data.access);
  assert.equal((await alice.call('GET', '/api/web/local/operations/by-request/missing')).status, 404);
  assert.ok(alice.cookie.startsWith('__Host-'));
  assert.equal((await bob.call('GET', '/api/web/local/bootstrap')).status, 200);
  assert.notEqual(alice.cookie, bob.cookie);
  const delayed = new Client();
  assert.equal((await delayed.call('GET', '/api/web/local/bootstrap')).status, 200);
  const slowSend = delayedWrite(delayed, '/api/web/local/characters/synthetic-local/operations',
    '{"requestId":"revoked-slow",', '"text":"never admitted","delivery":"voice"}');
  await new Promise(resolveWait => setTimeout(resolveWait, 50));
  assert.equal((await delayed.call('POST', '/api/web/local/logout', undefined,
    { Origin: origin, 'X-CSRF-Token': delayed.csrf })).status, 204);
  slowSend.finish();
  assert.equal((await slowSend.response).status, 401);
  const delayedCancel = new Client();
  assert.equal((await delayedCancel.call('GET', '/api/web/local/bootstrap')).status, 200);
  const slowCancel = delayedWrite(delayedCancel, '/api/web/local/operations/nonexistent/cancel', '{', '}');
  await new Promise(resolveWait => setTimeout(resolveWait, 50));
  assert.equal((await delayedCancel.call('POST', '/api/web/local/logout', undefined,
    { Origin: origin, 'X-CSRF-Token': delayedCancel.csrf })).status, 204);
  slowCancel.finish();
  assert.equal((await slowCancel.response).status, 401);
  const expiring = new Client();
  const expiringBootstrap = await expiring.call('GET', '/api/web/local/bootstrap');
  assert.equal(expiringBootstrap.status, 200);
  const expiringSend = delayedWrite(expiring, '/api/web/local/characters/synthetic-local/operations',
    '{"requestId":"expired-slow",', '"text":"must not admit","delivery":"voice"}');
  await new Promise(resolveWait => setTimeout(resolveWait, 50));
  const localConfig = readLocalConfig(root);
  const localStore = new WebStore(root, { create: false, instanceId: localConfig.instanceId });
  try { localStore.run('UPDATE web_sessions SET absolute_expires_at=? WHERE principal_id=?',
    Date.now() - 1, expiringBootstrap.data.access.principalId); }
  finally { localStore.close(); }
  expiringSend.finish();
  assert.equal((await expiringSend.response).status, 401);
  const denyOrigin = await alice.call('POST', '/api/web/local/characters/synthetic-local/operations',
    { requestId: 'bad-origin', text: 'x', delivery: 'voice' }, { Origin: 'https://attacker.invalid' });
  assert.equal(denyOrigin.status, 403);
  const denyCsrf = await alice.call('POST', '/api/web/local/characters/synthetic-local/operations',
    { requestId: 'bad-csrf', text: 'x', delivery: 'voice' }, { 'X-CSRF-Token': 'invalid' });
  assert.equal(denyCsrf.status, 403);
  const denyText = await alice.call('POST', '/api/web/local/characters/synthetic-local/operations',
    { requestId: 'bad-text', text: 'x', delivery: 'text' });
  assert.equal(denyText.status, 400);
  const denyBody = await alice.call('POST', '/api/web/local/characters/synthetic-local/operations',
    { requestId: 'big', text: 'x'.repeat(9000), delivery: 'voice' });
  assert.equal(denyBody.status, 400);
  const duplicateCookie = await alice.call('GET', '/api/web/local/bootstrap', undefined,
    { Cookie: `${alice.cookie}; ${alice.cookie}` });
  assert.equal(duplicateCookie.status, 400);
  let conversationId = '', thirdOperation = '';
  for (let round = 1; round <= 3; round++) {
    const requestId = `round-${round}`;
    const sent = await alice.call('POST', '/api/web/local/characters/synthetic-local/operations',
      { requestId, text: `第${round}轮`, delivery: 'voice' });
    assert.equal(sent.status, 202);
    const byRequest = await alice.call('GET', `/api/web/local/operations/by-request/${requestId}`);
    assert.equal(byRequest.status, 200);
    assert.equal(byRequest.data.operationId, sent.data.operation.operationId);
    assert.equal(byRequest.headers['cache-control'], 'no-store');
    assert.equal((await bob.call('GET', `/api/web/local/operations/by-request/${requestId}`)).status, 404);
    const replay = await alice.call('POST', '/api/web/local/characters/synthetic-local/operations',
      { requestId, text: `第${round}轮`, delivery: 'voice' });
    assert.equal(replay.status, 200);
    assert.equal(replay.data.operation.operationId, sent.data.operation.operationId);
    const conflict = await alice.call('POST', '/api/web/local/characters/synthetic-local/operations',
      { requestId, text: 'different', delivery: 'voice' });
    assert.equal(conflict.data.error.code, 'IDEMPOTENCY_CONFLICT');
    const op = await published(alice, sent.data.operation.operationId);
    conversationId = op.conversationId;
    if (round === 3) thirdOperation = op.operationId;
  }
  const rejected = await bob.call('POST', '/api/web/local/characters/synthetic-local/operations',
    { requestId: 'bob', text: 'same-ip', delivery: 'voice' });
  assert.equal(rejected.data.error.code, 'TRIAL_EXHAUSTED');
  assert.equal((await bob.call('GET', `/api/web/local/operations/${thirdOperation}`)).status, 404);
  const history = await alice.call('GET', `/api/web/local/conversations/${conversationId}/history`);
  assert.equal(history.status, 200);
  assert.equal(history.data.messages.filter((m: any) => m.origin === 'narrative').length, 3);
  assert.equal(history.data.messages.filter((m: any) => m.origin === 'trial_footer').length, 1);
  const narrative = history.data.messages.find((m: any) => m.origin === 'narrative');
  const audioPath = `/api/web/local/conversations/${conversationId}/messages/${narrative.messageId}/audio/${narrative.audio.mediaId}`;
  const audio = await alice.call('GET', audioPath);
  assert.equal(audio.status, 200);
  assert.equal(audio.bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(audio.headers['cache-control'], 'no-store');
  assert.equal((await bob.call('GET', audioPath)).status, 404);
  const sync = await alice.call('GET', `/api/web/local/sync?cursor=${encodeURIComponent(bootstrap.data.syncCursor)}`);
  assert.equal(sync.status, 200);
  assert.ok(sync.data.events.some((event: any) => event.kind === 'publication'));
  assert.equal((await alice.call('GET', '/api/web/local/sync?cursor=bad')).status, 400);
  const oldCookie = alice.cookie, oldStream = await sse(alice, sync.data.cursor);
  const rotatedSend = delayedWrite(alice, '/api/web/local/characters/synthetic-local/operations',
    '{"requestId":"rotated-slow",', '"text":"must not admit","delivery":"voice"}');
  await new Promise(resolveWait => setTimeout(resolveWait, 50));
  const username = `local_${randomUUID().slice(0, 8)}`, password = 'testing-pass-123';
  const registered = await alice.call('POST', '/api/web/local/register',
    { requestId: 'register-1', username, password });
  assert.equal(registered.status, 200);
  rotatedSend.finish();
  assert.equal((await rotatedSend.response).status, 401);
  await Promise.race([oldStream.ended, new Promise((_, reject) =>
    setTimeout(() => reject(new Error('revoked SSE did not close')), 3000))]);
  assert.equal((await alice.call('POST', '/api/web/local/identity/receipt-status',
    { requestId: 'register-1' })).status, 200);
  const retired = new Client(); retired.cookie = oldCookie;
  assert.equal((await retired.call('GET', '/api/web/local/bootstrap')).status, 409);
  const challenge = await retired.call('GET', '/api/web/local/identity/receipt-challenge');
  assert.equal(challenge.status, 200);
  retired.csrf = challenge.data.csrf;
  const recovered = await retired.call('POST', '/api/web/local/identity/receipt-recover',
    { requestId: 'register-1', username, password });
  assert.equal(recovered.status, 200);
  assert.equal(retired.cookie, alice.cookie);
  assert.equal((await alice.call('GET', '/api/web/local/bootstrap')).data.access.kind, 'account');
  const accountIdleBefore = new WebStore(root, { create: false, instanceId: localConfig.instanceId });
  const idleBefore = accountIdleBefore.get<{ last_active_at: number }>(
    'SELECT last_active_at FROM web_sessions WHERE principal_id=? AND revoked_at IS NULL',
    bootstrap.data.access.principalId)?.last_active_at;
  accountIdleBefore.close();
  assert.equal((await alice.call('GET', '/api/web/local/access')).data.kind, 'account');
  const accountIdleAfter = new WebStore(root, { create: false, instanceId: localConfig.instanceId });
  assert.equal(accountIdleAfter.get<{ last_active_at: number }>(
    'SELECT last_active_at FROM web_sessions WHERE principal_id=? AND revoked_at IS NULL',
    bootstrap.data.access.principalId)?.last_active_at, idleBefore);
  accountIdleAfter.close();
  const liveCursor = (await alice.call('GET', '/api/web/local/bootstrap')).data.syncCursor;
  const liveStream = await sse(alice, liveCursor);
  const sent = await alice.call('POST', '/api/web/local/characters/synthetic-local/operations',
    { requestId: 'entitled-4', text: '注册后', delivery: 'voice' });
  assert.equal(sent.status, 202);
  await published(alice, sent.data.operation.operationId);
  for (let i = 0; i < 30 && !liveStream.seen.some(event => event.kind === 'publication'); i++)
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  assert.ok(liveStream.seen.some(event => event.kind === 'publication'));
  liveStream.close();
  await stop();
  await start();
  assert.equal((await alice.call('GET', `/api/web/local/operations/${sent.data.operation.operationId}`)).data.status,
    'published');
  assert.equal((await alice.call('GET', audioPath)).status, 200);
  const recoveredHistory = await alice.call('GET', `/api/web/local/conversations/${conversationId}/history`);
  assert.equal(recoveredHistory.data.messages.filter((m: any) => m.origin === 'narrative').length, 4);
  assert.equal(recoveredHistory.data.messages.filter((m: any) => m.origin === 'trial_footer').length, 1);
  console.log(JSON.stringify({ result: 'ok', root, rounds: 4, restarted: true,
    privateAudio: true, cursor: true, sameIpLimit: true }));
} finally { await stop(); }

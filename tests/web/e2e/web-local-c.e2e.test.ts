import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { localRuntime, readLocalConfig } from '../../../apps/server/web-local-config.ts';
import { WebStore } from '../../../apps/server/store.ts';
import { WebAdmission } from '../../../apps/server/web-admission.ts';

const runtime = localRuntime();
const origin = `https://127.0.0.1:${runtime.port}`;
const script = resolve('scripts/web-v1.ts');
const wait = (ms: number) => new Promise(resolveWait => setTimeout(resolveWait, ms));
type Reply = { status: number; headers: IncomingHttpHeaders; json: any; bytes: Buffer };

function newInstance() {
  const root = join(runtime.parent, `local-c-${randomUUID().slice(0, 8)}`);
  for (const action of ['init', 'migrate']) {
    const result = spawnSync(process.execPath, [script, action, root], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, `${action} failed: ${result.stderr}`);
  }
  return { root, ca: readFileSync(join(root, 'local-cert.pem')) };
}

async function start(root: string, timeoutMs = 8_000): Promise<ChildProcess> {
  const child = spawn(process.execPath, [script, 'serve', root], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stderr!.on('data', chunk => { errors += String(chunk).slice(0, 1000); });
  await new Promise<void>((resolveReady, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('serve timeout')); }, timeoutMs);
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`serve exited ${code}: ${errors}`)); });
    child.stdout!.on('data', chunk => {
      output += String(chunk);
      if (output.includes('"action":"serve"')) { clearTimeout(timeout); resolveReady(); }
    });
  });
  return child;
}

async function stop(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM') {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolveExit, reject) => {
    const timeout = setTimeout(() => reject(new Error('serve stop timeout')), 5_000);
    child.once('exit', () => { clearTimeout(timeout); resolveExit(); });
  });
  child.kill(signal);
  await exited;
}

function request(ca: Buffer, method: string, path: string, headers: Record<string, string> = {},
  body?: string): Promise<Reply> {
  return new Promise((resolveReply, reject) => {
    const req = httpsRequest({ hostname: '127.0.0.1', port: runtime.port, path, method, ca, headers }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const bytes = Buffer.concat(chunks);
        let json: any = null;
        try { json = JSON.parse(bytes.toString('utf8')); } catch { /* empty or WAV */ }
        resolveReply({ status: res.statusCode ?? 0, headers: res.headers, json, bytes });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

class Client {
  cookie = '';
  csrf = '';
  readonly ca: Buffer;
  constructor(ca: Buffer) { this.ca = ca; }
  async call(method: string, path: string, body?: unknown, override: Record<string, string> = {}) {
    const raw = body === undefined ? undefined : JSON.stringify(body);
    const reply = await request(this.ca, method, path, {
      ...(this.cookie ? { Cookie: this.cookie } : {}),
      ...(method === 'POST' ? { Origin: origin, 'X-CSRF-Token': this.csrf } : {}),
      ...(raw ? { 'Content-Type': 'application/json' } : {}), ...override }, raw);
    const cookie = reply.headers['set-cookie']?.[0]?.split(';')[0];
    if (cookie) this.cookie = cookie;
    if (typeof reply.json?.csrf === 'string') this.csrf = reply.json.csrf;
    return reply;
  }
  bootstrap() { return this.call('GET', '/api/web/local/bootstrap'); }
  send(requestId: string, text: string) {
    return this.call('POST', '/api/web/local/characters/synthetic-local/operations',
      { requestId, text, delivery: 'voice' });
  }
}

function delayed(client: Client, path: string, first: string, rest: string) {
  let finish!: () => void;
  const response = new Promise<Reply>((resolveReply, reject) => {
    const req = httpsRequest({ hostname: '127.0.0.1', port: runtime.port, path, method: 'POST', ca: client.ca,
      headers: { Cookie: client.cookie, Origin: origin, 'X-CSRF-Token': client.csrf,
        'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const bytes = Buffer.concat(chunks);
        resolveReply({ status: res.statusCode ?? 0, headers: res.headers,
          json: JSON.parse(bytes.toString('utf8')), bytes });
      });
    });
    req.on('error', reject);
    req.write(first);
    finish = () => req.end(rest);
  });
  return { finish: () => finish(), response };
}

async function published(client: Client, operationId: string) {
  for (let i = 0; i < 60; i++) {
    const result = await client.call('GET', `/api/web/local/operations/${operationId}`);
    if (result.json?.status === 'published') return result.json;
    if (['failed', 'unknown', 'cancelled'].includes(result.json?.status))
      throw new Error(`unexpected terminal status ${result.json.status}`);
    await wait(50);
  }
  throw new Error('publication timeout');
}

async function openSse(client: Client, cursor: string) {
  return new Promise<{ response: IncomingMessage; seen: any[]; ended: Promise<void> }>((resolveStream, reject) => {
    const req = httpsRequest({ hostname: '127.0.0.1', port: runtime.port, ca: client.ca,
      path: `/api/web/local/events?cursor=${encodeURIComponent(cursor)}`, method: 'GET',
      headers: { Cookie: client.cookie } }, res => {
      const seen: any[] = [];
      let pending = '';
      const ended = new Promise<void>(resolveEnd => res.once('end', resolveEnd));
      res.on('data', chunk => {
        pending += String(chunk);
        while (pending.includes('\n\n')) {
          const index = pending.indexOf('\n\n'), block = pending.slice(0, index);
          pending = pending.slice(index + 2);
          const line = block.split('\n').find(value => value.startsWith('data: '));
          if (line) seen.push(JSON.parse(line.slice(6)));
        }
      });
      resolveStream({ response: res, seen, ended });
    });
    req.on('error', reject);
    req.end();
  });
}

test('C real loopback TLS: scoped publish, replay, delayed send/cancel revocation and SSE', async t => {
  const { root, ca } = newInstance();
  let child = await start(root);
  t.after(async () => { await stop(child); });
  const duplicate = spawnSync(process.execPath, [script, 'serve', root],
    { encoding: 'utf8', timeout: 5_000 });
  assert.notEqual(duplicate.status, 0, 'a second server must not own the same instance');
  assert.equal(duplicate.signal, null, 'duplicate instance must fail promptly, not hang');
  const alice = new Client(ca), bob = new Client(ca);
  await assert.rejects(new Promise<void>((resolveUnexpected, rejectTls) => {
    const untrusted = httpsRequest({ hostname: '127.0.0.1', port: runtime.port,
      path: '/health', method: 'GET' }, () => resolveUnexpected());
    untrusted.on('error', rejectTls); untrusted.end();
  }), /self-signed|certificate/i);
  const boot = await alice.bootstrap();
  assert.equal(boot.status, 200);
  assert.equal(boot.json.mode, 'synthetic-local');
  assert.equal(boot.headers['cache-control'], 'no-store');
  assert.match(boot.headers['set-cookie']![0]!, /Secure; HttpOnly; SameSite=Lax/);
  assert.equal((await bob.bootstrap()).status, 200);
  assert.notEqual(alice.cookie, bob.cookie);

  const sendPath = '/api/web/local/characters/synthetic-local/operations';
  const cleanInput = { requestId: 'reject-before-write', text: 'not admitted', delivery: 'voice' };
  assert.equal((await alice.call('POST', sendPath, cleanInput,
    { Origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await alice.call('POST', sendPath, cleanInput,
    { 'X-CSRF-Token': 'invalid' })).status, 403);
  assert.equal((await alice.call('POST', sendPath,
    { ...cleanInput, delivery: 'text' })).status, 400);
  assert.equal((await alice.call('POST', sendPath,
    { ...cleanInput, text: 'x'.repeat(9_000) })).status, 400);

  const admitted = await alice.send('first', 'x');
  assert.equal(admitted.status, 202);
  const first = await published(alice, admitted.json.operation.operationId);
  const replay = await alice.send('first', 'x');
  assert.equal(replay.status, 200);
  assert.equal(replay.json.operation.operationId, first.operationId);
  const mismatch = await alice.send('first', 'other');
  assert.equal(mismatch.json.error.code, 'IDEMPOTENCY_CONFLICT');
  const history = await alice.call('GET', `/api/web/local/conversations/${first.conversationId}/history`);
  assert.equal(history.status, 200);
  const narrative = history.json.messages.find((row: any) => row.origin === 'narrative');
  assert.ok(narrative?.audio?.mediaId);
  const audioPath = `/api/web/local/conversations/${first.conversationId}/messages/${narrative.messageId}/audio/${narrative.audio.mediaId}`;
  assert.equal((await alice.call('GET', audioPath)).bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal((await bob.call('GET', audioPath)).status, 404);
  assert.equal((await bob.call('GET', `/api/web/local/operations/${first.operationId}`)).status, 404);
  assert.equal((await bob.call('GET', `/api/web/local/conversations/${first.conversationId}/history`)).status, 404);
  const sync = await alice.call('GET', `/api/web/local/sync?cursor=${encodeURIComponent(boot.json.syncCursor)}`);
  assert.equal(sync.status, 200);
  assert.ok(sync.json.events.some((event: any) => event.kind === 'publication'));
  assert.equal((await bob.call('GET', `/api/web/local/sync?cursor=${encodeURIComponent(sync.json.cursor)}`)).status, 400);

  const stream = await openSse(alice, sync.json.cursor);
  assert.equal(stream.response.statusCode, 200);
  assert.equal((await alice.call('GET', `/api/web/local/events?cursor=${encodeURIComponent(sync.json.cursor)}`)).status,
    429);
  const second = await alice.send('sse-second', '第二轮');
  assert.equal(second.status, 202);
  await published(alice, second.json.operation.operationId);
  for (let i = 0; i < 20 && !stream.seen.some(event => event.kind === 'publication'); i++) await wait(100);
  assert.ok(stream.seen.some(event => event.kind === 'publication'));
  stream.response.pause(); // A temporarily slow reader must not stop another publish.
  const third = await alice.send('third', '第三轮');
  assert.equal(third.status, 202);
  await published(alice, third.json.operation.operationId);
  stream.response.resume();
  const trialHistory = await alice.call('GET', `/api/web/local/conversations/${first.conversationId}/history`);
  assert.equal(trialHistory.json.messages.filter((row: any) => row.origin === 'narrative').length, 3);
  assert.equal(trialHistory.json.messages.filter((row: any) => row.origin === 'trial_footer').length, 1);
  assert.equal((await bob.send('same-ip-exhausted', '同出口IP')).json.error.code, 'TRIAL_EXHAUSTED');

  const oldCookie = alice.cookie;
  const registration = await alice.call('POST', '/api/web/local/register',
    { requestId: 'c-register', username: `c_${randomUUID().slice(0, 8)}`, password: 'synthetic-pass-123' }); // gitleaks:allow -- fixed offline fixture password, never a real account.
  assert.equal(registration.status, 200);
  await Promise.race([stream.ended, wait(2000).then(() => { throw new Error('SSE did not revoke'); })]);
  const retired = new Client(ca); retired.cookie = oldCookie;
  assert.equal((await retired.call('GET', audioPath)).status, 401);
  assert.equal((await retired.call('GET', `/api/web/local/conversations/${first.conversationId}/history`)).status, 401);

  // Transport-only event burst: use a controlled same-principal fixture, not fake business publications.
  const accountSnapshot = await alice.bootstrap();
  const accountConfig = readLocalConfig(root);
  const eventStore = new WebStore(root, { create: false, instanceId: accountConfig.instanceId });
  try {
    eventStore.transaction(() => {
      for (let i = 0; i < 120; i++) eventStore.run(`INSERT INTO web_local_events
        (principal_id,world_id,conversation_id,operation_id,kind,revision,payload_json)
        VALUES (?,?,NULL,NULL,'access',?,?)`, accountSnapshot.json.access.principalId,
      accountSnapshot.json.access.worldId, 1000 + i, JSON.stringify({ fixtureIndex: i }));
    });
  } finally { eventStore.close(); }
  const firstPage = await alice.call('GET',
    `/api/web/local/sync?cursor=${encodeURIComponent(accountSnapshot.json.syncCursor)}`);
  assert.equal(firstPage.status, 200);
  assert.equal(firstPage.json.events.length, 100);
  assert.equal(firstPage.json.hasMore, true);
  const secondPage = await alice.call('GET',
    `/api/web/local/sync?cursor=${encodeURIComponent(firstPage.json.cursor)}`);
  assert.equal(secondPage.status, 200);
  assert.equal(secondPage.json.events.length, 20);
  assert.equal(secondPage.json.hasMore, false);
  assert.equal(new Set([...firstPage.json.events, ...secondPage.json.events]
    .map((event: any) => event.eventId)).size, 120);
  const accountStream = await openSse(alice, secondPage.json.cursor);
  assert.equal(accountStream.response.statusCode, 200);
  const fourth = await alice.send('entitled-fourth', '注册后第四轮');
  assert.equal(fourth.status, 202);
  await published(alice, fourth.json.operation.operationId);
  for (let i = 0; i < 20 && !accountStream.seen.some(event => event.kind === 'publication'); i++) await wait(100);
  assert.ok(accountStream.seen.some(event => event.kind === 'publication'));
  accountStream.response.destroy();
  const entitledHistory = await alice.call('GET', `/api/web/local/conversations/${first.conversationId}/history`);
  assert.equal(entitledHistory.json.messages.filter((row: any) => row.origin === 'narrative').length, 4);
  assert.equal(entitledHistory.json.messages.filter((row: any) => row.origin === 'trial_footer').length, 1);

  const delayedGuest = new Client(ca);
  await delayedGuest.bootstrap();
  const slowSend = delayed(delayedGuest, '/api/web/local/characters/synthetic-local/operations',
    '{"requestId":"c-revoked-send",', '"text":"should not save","delivery":"voice"}');
  await wait(50);
  assert.equal((await delayedGuest.call('POST', '/api/web/local/logout')).status, 204);
  slowSend.finish();
  assert.equal((await slowSend.response).status, 401);

  const cancelGuest = new Client(ca);
  const cancelBoot = await cancelGuest.bootstrap();
  const config = readLocalConfig(root);
  const store = new WebStore(root, { create: false, instanceId: config.instanceId });
  let cancellableId = '';
  try {
    const futureClock = { now: () => Date.now() + 10_000 };
    cancellableId = new WebAdmission(store, futureClock, randomUUID).admit({
      principalId: cancelBoot.json.access.principalId, requestId: 'c-cancellable',
      characterId: 'synthetic-local', text: 'queued until future', ipHash: 'd'.repeat(64) }).operationId;
    assert.equal(store.get<{ status: string }>('SELECT status FROM web_operations WHERE id=?', cancellableId)!.status,
      'queued');
  } finally { store.close(); }
  const slowCancel = delayed(cancelGuest, `/api/web/local/operations/${cancellableId}/cancel`, '{', '}');
  await wait(50);
  assert.equal((await cancelGuest.call('POST', '/api/web/local/logout')).status, 204);
  slowCancel.finish();
  assert.equal((await slowCancel.response).status, 401);
  const audit = new WebStore(root, { create: false, instanceId: config.instanceId });
  try {
    assert.equal(audit.get<{ status: string; quota_state: string }>(
      'SELECT status,quota_state FROM web_operations WHERE id=?', cancellableId)!.status, 'queued');
    assert.equal(audit.get('SELECT 1 FROM web_operations WHERE request_id=?', 'c-revoked-send'), undefined);
    assert.equal(audit.get('SELECT 1 FROM web_operations WHERE request_id=?', 'reject-before-write'), undefined);
  } finally { audit.close(); }

  assert.equal((await alice.call('POST', '/api/web/local/logout')).status, 204);
  assert.equal((await alice.call('GET', audioPath)).status, 401);
  console.log(JSON.stringify({ cTls: 'ok', root, port: runtime.port, published: 4,
    delayedSendRevoked: true, delayedValidCancelRevoked: true, sseRevoked: true }));
});

test('C real process recovery: immediate restart after SIGKILL must keep the isolated instance available', async t => {
  const { root, ca } = newInstance();
  let child = await start(root);
  t.after(async () => { await stop(child); });
  const client = new Client(ca);
  assert.equal((await client.bootstrap()).status, 200);
  const sent = await client.send('before-crash', '请回复');
  assert.equal(sent.status, 202);
  await published(client, sent.json.operation.operationId);
  const config = readLocalConfig(root);
  const before = new WebStore(root, { create: false, instanceId: config.instanceId });
  const attemptCount = before.get<{ n: number }>(
    'SELECT count(*) n FROM web_external_attempts WHERE operation_id=?', sent.json.operation.operationId)!.n;
  before.close();
  await stop(child, 'SIGKILL');
  const restartingAt = Date.now();
  child = await start(root, 36_000); // Original coordinator lease may require its full 30 s before takeover.
  const after = await client.call('GET', `/api/web/local/operations/${sent.json.operation.operationId}`);
  assert.equal(after.json.status, 'published');
  const reopened = new WebStore(root, { create: false, instanceId: config.instanceId });
  try { assert.equal(reopened.get<{ n: number }>(
    'SELECT count(*) n FROM web_external_attempts WHERE operation_id=?', sent.json.operation.operationId)!.n,
  attemptCount); }
  finally { reopened.close(); }
  console.log(JSON.stringify({ cCrashRecovery: 'ok', root, port: runtime.port,
    restartWaitMs: Date.now() - restartingAt }));
});

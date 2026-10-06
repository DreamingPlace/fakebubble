import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { localRuntime, readLocalConfig } from '../../../apps/server/platform/web-local-config.ts';
import { WebStore } from '../../../apps/server/platform/store.ts';
import { WebIdentity } from '../../../apps/server/identity/web-identity.ts';

const runtime = localRuntime(),
  origin = `https://127.0.0.1:${runtime.port}`;
const script = resolve('scripts/web-v1.ts');
const sleep = (ms: number) => new Promise((resolveWait) => setTimeout(resolveWait, ms));
type Session = { cookie: string; csrf: string; principalId: string; publicBootstrap: boolean };
type Result = { status: number; json: any; elapsedMs: number; headers: Record<string, string | string[] | undefined> };

function createInstance() {
  const root = join(runtime.parent, `local-c-load-${randomUUID().slice(0, 8)}`);
  for (const action of ['init', 'migrate']) {
    const command = spawnSync(process.execPath, [script, action, root], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(command.status, 0, `${action}: ${command.stderr}`);
  }
  return { root, ca: readFileSync(join(root, 'local-cert.pem')) };
}

async function serve(root: string) {
  const child = spawn(process.execPath, [script, 'serve', root], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '',
    stderr = '';
  child.stderr!.on('data', (chunk) => {
    stderr += String(chunk).slice(0, 500);
  });
  await new Promise<void>((resolveReady, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('serve timeout'));
    }, 8_000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`serve exit ${code}: ${stderr}`));
    });
    child.stdout!.on('data', (chunk) => {
      stdout += String(chunk);
      if (stdout.includes('"action":"serve"')) {
        clearTimeout(timer);
        resolveReady();
      }
    });
  });
  return child;
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
  child.kill('SIGTERM');
  await Promise.race([
    exit,
    sleep(5_000).then(() => {
      throw new Error('stop timeout');
    }),
  ]);
}

function call(ca: Buffer, method: string, path: string, session?: Session, payload?: unknown): Promise<Result> {
  const body = payload === undefined ? undefined : JSON.stringify(payload);
  const started = performance.now();
  return new Promise((resolveResult, reject) => {
    const req = httpsRequest(
      {
        hostname: '127.0.0.1',
        port: runtime.port,
        ca,
        path,
        method,
        headers: {
          ...(session ? { Cookie: session.cookie } : {}),
          ...(method === 'POST' ? { Origin: origin, 'X-CSRF-Token': session?.csrf ?? '' } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => {
          const bytes = Buffer.concat(chunks);
          let json: any = null;
          try {
            json = JSON.parse(bytes.toString('utf8'));
          } catch {
            /* empty response */
          }
          resolveResult({
            status: res.statusCode ?? 0,
            json,
            elapsedMs: performance.now() - started,
            headers: res.headers,
          });
        });
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function openSse(ca: Buffer, session: Session): Promise<{ status: number; close: () => void }> {
  return new Promise((resolveStream, reject) => {
    const req = httpsRequest(
      {
        hostname: '127.0.0.1',
        port: runtime.port,
        ca,
        path: '/api/web/local/events',
        method: 'GET',
        headers: { Cookie: session.cookie },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolveStream({ status: res.statusCode ?? 0, close: () => req.destroy() });
          return;
        }
        res.on('data', () => {
          /* Drain normally; this test counts admitted live streams. */
        });
        resolveStream({ status: 200, close: () => req.destroy() });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function metric(values: number[]) {
  const sorted = values.toSorted((a, b) => a - b);
  if (!sorted.length) return { samples: 0, p50Ms: null, p95Ms: null };
  return {
    samples: sorted.length,
    p50Ms: sorted[Math.floor((sorted.length - 1) * 0.5)]!,
    p95Ms: sorted[Math.floor((sorted.length - 1) * 0.95)]!,
  };
}

test('C load smoke: 10/30/50 scoped SSE sessions and 50 connections with 10 same-IP submissions', async (t) => {
  const { root, ca } = createInstance(),
    child = await serve(root);
  t.after(async () => {
    await stop(child);
  });
  const sessions: Session[] = [];
  const guestStart = performance.now();
  for (let i = 0; i < 30; i++) {
    const reply = await call(ca, 'GET', '/api/web/local/bootstrap');
    assert.equal(reply.status, 200);
    sessions.push({
      cookie: reply.headers['set-cookie']![0]!.split(';')[0]!,
      csrf: reply.json.csrf,
      principalId: reply.json.access.principalId,
      publicBootstrap: true,
    });
  }
  const publicBootstrapMs = performance.now() - guestStart;
  const config = readLocalConfig(root),
    store = new WebStore(root, { create: false, instanceId: config.instanceId });
  try {
    const identity = new WebIdentity(store, {
      origin,
      cookieName: config.cookieName,
      clock: { now: () => Date.now() },
      keys: {
        keyId: 'local-v1',
        sealKey: Buffer.from(config.sealKey, 'base64url'),
        requestKey: Buffer.from(config.requestKey, 'base64url'),
      },
    });
    for (let i = 0; i < 20; i++) {
      const boot = identity.bootstrap();
      sessions.push({
        cookie: `${config.cookieName}=${boot.issuedToken!}`,
        csrf: boot.csrf,
        principalId: boot.principalId,
        publicBootstrap: false,
      });
    }
  } finally {
    store.close();
  }
  assert.equal(new Set(sessions.map((session) => session.principalId)).size, 50);

  const online: { target: number; accepted: number; limited: number; openMs: number }[] = [];
  for (const target of [10, 30, 50]) {
    const started = performance.now();
    const streams = await Promise.all(sessions.slice(0, target).map((session) => openSse(ca, session)));
    online.push({
      target,
      accepted: streams.filter((stream) => stream.status === 200).length,
      limited: streams.filter((stream) => stream.status === 429).length,
      openMs: performance.now() - started,
    });
    for (const stream of streams) stream.close();
    await sleep(100);
  }
  assert.deepEqual(
    online.map((row) => [row.accepted, row.limited]),
    [
      [10, 0],
      [30, 0],
      [32, 18],
    ],
  );

  // 50 fresh TLS connections, ten simultaneous writes from ten public guests sharing one exit IP.
  const health = await Promise.all(Array.from({ length: 50 }, () => call(ca, 'GET', '/health')));
  assert.equal(health.filter((reply) => reply.status === 200).length, 50);
  const sends = await Promise.all(
    sessions.slice(0, 10).map((session, index) =>
      call(ca, 'POST', '/api/web/local/characters/synthetic-local/operations', session, {
        requestId: `c-load-${index}`,
        text: `合成负载${index}`,
        delivery: 'voice',
      }),
    ),
  );
  const accepted = sends.filter((reply) => reply.status === 202),
    denied = sends.filter((reply) => reply.status !== 202);
  assert.equal(accepted.length, 3);
  assert.equal(denied.length, 7);
  assert.ok(denied.every((reply) => reply.json?.error?.code === 'TRIAL_EXHAUSTED'));
  for (let tick = 0; tick < 80; tick++) {
    const query = new WebStore(root, { create: false, instanceId: config.instanceId });
    const complete = query.get<{ n: number }>(`SELECT count(*) n FROM web_publications p
      JOIN web_operations o ON o.id=p.operation_id WHERE o.request_id LIKE 'c-load-%'`)!.n;
    query.close();
    if (complete === 3) break;
    await sleep(50);
  }
  const evidence = new WebStore(root, { create: false, instanceId: config.instanceId });
  let stage: Record<string, ReturnType<typeof metric>> = {};
  try {
    const rows = evidence.all<{
      created_at: number;
      published_at: number;
      phase: string;
      sent_at: number;
      settled_at: number;
    }>(`SELECT o.created_at,p.published_at,a.phase,a.sent_at,a.settled_at
      FROM web_operations o JOIN web_publications p ON p.operation_id=o.id
      JOIN web_external_attempts a ON a.operation_id=o.id
      WHERE o.request_id LIKE 'c-load-%' ORDER BY o.id,a.phase`);
    assert.equal(rows.length, 9); // Three successful rounds, draft/review/speech each.
    stage.queueToDraft = metric(rows.filter((row) => row.phase === 'draft').map((row) => row.sent_at - row.created_at));
    for (const phase of ['draft', 'review', 'speech'])
      stage[phase] = metric(rows.filter((row) => row.phase === phase).map((row) => row.settled_at - row.sent_at));
    stage.publishFromAdmission = metric(
      rows.filter((row) => row.phase === 'speech').map((row) => row.published_at - row.created_at),
    );
  } finally {
    evidence.close();
  }
  console.log(
    JSON.stringify({
      cLoad: 'synthetic-local',
      root,
      port: runtime.port,
      publicBootstrap: { sessions: 30, elapsedMs: publicBootstrapMs },
      additionalInternalSessions: 20,
      online,
      connections50: metric(health.map((row) => row.elapsedMs)),
      tenSameIpSends: {
        accepted: accepted.length,
        denied: denied.length,
        admissionResponse: metric(sends.map((row) => row.elapsedMs)),
      },
      stage,
      databaseTime: 'NOT_INSTRUMENTED',
      provider: 'synthetic-local',
    }),
  );
});

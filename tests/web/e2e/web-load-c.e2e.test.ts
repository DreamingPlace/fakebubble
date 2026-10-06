import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { WebStore } from '../../../apps/server/store.ts';
import { WebIdentity } from '../../../apps/server/web-identity.ts';
import { localRuntime, readLocalConfig } from '../../../apps/server/web-local-config.ts';

const pause = (ms: number) => new Promise((resolvePause) => setTimeout(resolvePause, ms));
const summary = (samples: number[]) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: Number(sorted[Math.floor((sorted.length - 1) * 0.5)]?.toFixed(2)),
    p95: Number(sorted[Math.floor((sorted.length - 1) * 0.95)]?.toFixed(2)),
    max: Number(sorted.at(-1)?.toFixed(2)),
  };
};
type Reply = { status: number; data: any; durationMs: number };

test('C synthetic 10/30/50 sessions, SSE cap and 50-session 10-submit load', { timeout: 90_000 }, async (t) => {
  const { parent, port } = localRuntime();
  assert.ok([18461, 18491].includes(port));
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const root = join(parent, `local-invite-c-load-${randomUUID().slice(0, 12)}`);
  const script = resolve('scripts/web-v1.ts');
  for (const action of ['init', 'migrate', 'migrate-data-lifecycle']) {
    const result = spawnSync(process.execPath, [script, action, root], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, `${action}: ${result.stderr.slice(0, 300)}`);
  }
  const config = readLocalConfig(root),
    ca = readFileSync(join(root, 'local-cert.pem'));
  const child: ChildProcess = spawn(process.execPath, [script, 'serve-data-lifecycle', root], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolveExit, reject) => {
      const timer = setTimeout(() => reject(Error('load service stop timeout')), 5000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolveExit();
      });
    });
    child.kill('SIGTERM');
    await exited;
  };
  t.after(stop);
  await new Promise<void>((resolveReady, reject) => {
    let stdout = '',
      stderr = '';
    const timer = setTimeout(() => reject(Error(`load service timeout ${stderr}`)), 10_000);
    child.stderr!.on('data', (chunk) => {
      stderr += String(chunk).slice(0, 200);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(Error(`load service ${code} ${stderr}`));
    });
    child.stdout!.on('data', (chunk) => {
      stdout += String(chunk);
      if (stdout.includes('"action":"serve-data-lifecycle"')) {
        clearTimeout(timer);
        resolveReady();
      }
    });
  });
  class Client {
    cookie = '';
    csrf = '';
    cursor = '';
    async call(method: string, path: string, body?: unknown): Promise<Reply> {
      const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const started = performance.now();
      return new Promise((resolveReply, reject) => {
        const req = httpsRequest(
          {
            hostname: '127.0.0.1',
            port,
            ca,
            method,
            path,
            headers: {
              ...(this.cookie ? { Cookie: this.cookie } : {}),
              ...(bytes
                ? { Origin: config.origin, 'Content-Type': 'application/json', 'X-CSRF-Token': this.csrf }
                : {}),
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
            res.on('end', () => {
              const raw = Buffer.concat(chunks),
                setCookie = res.headers['set-cookie']?.[0]?.split(';')[0];
              if (setCookie) this.cookie = setCookie;
              let data: any = null;
              try {
                data = JSON.parse(raw.toString('utf8'));
              } catch {
                /* none */
              }
              if (typeof data?.csrf === 'string') this.csrf = data.csrf;
              resolveReply({ status: res.statusCode ?? 0, data, durationMs: performance.now() - started });
            });
          },
        );
        req.on('error', reject);
        if (bytes) req.write(bytes);
        req.end();
      });
    }
  }
  const clients: Client[] = [],
    cohorts: Array<{ sessions: number; seeded: number; bootstrapMs: ReturnType<typeof summary> }> = [];
  let seeded = 0;
  for (const target of [10, 30, 50]) {
    const times: number[] = [];
    while (clients.length < target) {
      const client = new Client();
      if (clients.length >= 32) {
        // HTTP deliberately caps new guests at 32 per exit IP/day; preseed only the rest.
        const fixtureStore = new WebStore(root, {
          create: false,
          instanceId: config.instanceId,
          dataLifecycleTest: true,
        });
        try {
          const identity = new WebIdentity(fixtureStore, {
            origin: config.origin,
            cookieName: config.cookieName,
            clock: { now: () => Date.now() },
            keys: {
              keyId: 'local-v1',
              sealKey: Buffer.from(config.sealKey, 'base64url'),
              requestKey: Buffer.from(config.requestKey, 'base64url'),
            },
          });
          const issued = identity.bootstrap();
          assert.ok(issued.issuedToken);
          client.cookie = `${config.cookieName}=${issued.issuedToken}`;
        } finally {
          fixtureStore.close();
        }
        seeded++;
      }
      const boot = await client.call('GET', '/api/web/local/bootstrap');
      assert.equal(boot.status, 200);
      client.cursor = boot.data.syncCursor;
      times.push(boot.durationMs);
      clients.push(client);
    }
    cohorts.push({ sessions: target, seeded, bootstrapMs: summary(times) });
  }
  assert.equal(new Set(clients.map((client) => client.cookie)).size, 50);
  const streams: Array<{ req: ReturnType<typeof httpsRequest>; response: IncomingMessage }> = [];
  const openStream = (client: Client) =>
    new Promise<number>((resolveOpen, reject) => {
      const req = httpsRequest(
        {
          hostname: '127.0.0.1',
          port,
          ca,
          method: 'GET',
          path: `/api/web/local/events?cursor=${encodeURIComponent(client.cursor)}`,
          headers: { Cookie: client.cookie },
        },
        (res) => {
          if (res.statusCode === 200) {
            res.on('data', () => {});
            streams.push({ req, response: res });
            resolveOpen(200);
          } else {
            res.resume();
            res.once('end', () => resolveOpen(res.statusCode ?? 0));
          }
        },
      );
      req.on('error', reject);
      req.end();
    });
  t.after(() => {
    for (const stream of streams) {
      stream.response.destroy();
      stream.req.destroy();
    }
  });
  const streamStatuses: number[] = [];
  for (let index = 0; index < 33; index++) streamStatuses.push(await openStream(clients[index]!));
  assert.deepEqual(streamStatuses.slice(0, 32), Array(32).fill(200));
  assert.equal(streamStatuses[32], 429, 'configured global SSE cap is 32, not 50');

  for (let index = 0; index < 10; index++) {
    const registered = await clients[index]!.call('POST', '/api/web/local/register', {
      requestId: `c-load-register-${index}`,
      username: `cload_${randomUUID().slice(0, 8)}`,
      password: 'c-synthetic-passphrase',
    });
    assert.equal(registered.status, 200, `register ${index}: ${registered.data?.error?.code}`);
  }
  const started = performance.now();
  const submits = await Promise.all(
    clients.slice(0, 10).map((client, index) =>
      client.call('POST', '/api/web/local/characters/synthetic-local/operations', {
        requestId: `c-load-send-${index}`,
        text: `C 合成负载请求 ${index}`,
        delivery: 'voice',
      }),
    ),
  );
  assert.deepEqual(
    submits.map((reply) => reply.status),
    Array(10).fill(202),
  );
  const ids = submits.map((reply) => reply.data.operation.operationId as string);
  const completion: number[] = Array(10).fill(0);
  for (let tick = 0; tick < 300 && completion.some((value) => value === 0); tick++) {
    await Promise.all(
      ids.map(async (id, index) => {
        if (completion[index]) return;
        const reply = await clients[index]!.call('GET', `/api/web/local/operations/${id}`);
        assert.notEqual(reply.data?.status, 'failed');
        if (reply.data?.status === 'published') completion[index] = performance.now() - started;
      }),
    );
    if (completion.some((value) => value === 0)) await pause(25);
  }
  assert.equal(completion.filter(Boolean).length, 10, 'all ten entitled synthetic operations publish');
  const store = new WebStore(root, { create: false, instanceId: config.instanceId, dataLifecycleTest: true });
  t.after(() => store.close());
  const queue: number[] = [],
    draft: number[] = [],
    review: number[] = [],
    audio: number[] = [],
    publish: number[] = [],
    db: number[] = [];
  for (const id of ids) {
    const startedDb = performance.now();
    const op = store.get<{ created_at: number }>('SELECT created_at FROM web_operations WHERE id=?', id)!;
    const attempts = store.all<{ phase: string; ordinal: number; created_at: number; settled_at: number | null }>(
      `SELECT phase,ordinal,created_at,settled_at
        FROM web_external_attempts WHERE operation_id=? ORDER BY created_at,ordinal`,
      id,
    );
    const publication = store.get<{ published_at: number }>(
      'SELECT published_at FROM web_publications WHERE operation_id=?',
      id,
    )!;
    db.push(performance.now() - startedDb);
    const first = attempts.find((row) => row.phase === 'draft')!;
    const second = attempts.find((row) => row.phase === 'review')!;
    const speech = attempts.filter((row) => row.phase === 'speech');
    assert.ok(first.settled_at !== null && second.settled_at !== null && speech.length > 0);
    assert.ok(speech.every((row) => row.settled_at !== null));
    queue.push(first.created_at - op.created_at);
    draft.push(first.settled_at! - first.created_at);
    review.push(second.settled_at! - second.created_at);
    audio.push(Math.max(...speech.map((row) => row.settled_at!)) - Math.min(...speech.map((row) => row.created_at)));
    publish.push(publication.published_at - Math.max(...speech.map((row) => row.settled_at!)));
  }
  process.stdout.write(
    JSON.stringify({
      case: 'C-S2-COMBINED-LOAD',
      root,
      machine: process.arch,
      sessions: cohorts,
      sse: { accepted: 32, limited: 1, configuredCap: 32 },
      submits: {
        attempted: 10,
        admitted: 10,
        published: 10,
        acceptMs: summary(submits.map((reply) => reply.durationMs)),
        reachPublishedMs: summary(completion),
      },
      stagesMs: {
        queue: summary(queue),
        draft: summary(draft),
        review: summary(review),
        audio: summary(audio),
        publication: summary(publish),
        dbRead: summary(db),
      },
      method: 'single local run; perf_hooks HTTP wall time + persisted millisecond timestamps',
    }) + '\n',
  );
  await stop();
});

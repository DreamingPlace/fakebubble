import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { localRuntime, readLocalConfig } from '../../../apps/server/platform/web-local-config.ts';
import { Store, WebStore } from '../../../apps/server/platform/store.ts';
import { WebIdentity } from '../../../apps/server/identity/web-identity.ts';
import { readdirSync } from 'node:fs';
import { DomainError } from '../../../packages/domain/errors.ts';
import { parseWebConcurrency } from '../../../config/web-concurrency.ts';
import { WebProviderOffline } from '../../../apps/server/generation/web-provider-offline.ts';
import {
  migrateWebProviderMetrics,
  migrateWebProviderOffline,
} from '../../../apps/server/generation/web-provider-migration.ts';
import { WebProviderRunner, type FakeFish } from '../../../apps/server/generation/web-provider-runner.ts';
import { WebProviderExecutor } from '../../../apps/server/generation/web-provider-executor.ts';
import { DeepSeekTextGenerator } from '../../../apps/server/generation/deepseek.ts';
import { WebDispatchLedger } from '../../../apps/server/budget/web-dispatch-ledger.ts';
import { freezeInputSnapshot } from '../../../apps/server/generation/web-input-snapshot.ts';
import { protocolFingerprint } from '../../../apps/server/generation/accepted-text-protocol.ts';
import { textPromptHash } from '../../../apps/server/generation/accepted-text-prompt.ts';
import { sceneState } from '../../../apps/server/conversation/scenes.ts';
import { userStore } from '../../../apps/server/platform/store-boundary.ts';
import { syntheticTone } from '../../../apps/server/platform/web-local-fake.ts';
import { acceptedAuditEnvelope, draftEnvelope, draftPresentation, textRequest } from '../../text-fixtures.ts';
import { ControlledProvider, ManualClock } from '../integration/controlled-provider.ts';
import { MemoryBudget } from '../fixtures/memory-budget.ts';
import { createHash } from 'node:crypto';

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

/**
 * 30 players at once against the deployment defaults (20 text, 4 audio): the controlled provider answers text in
 * 3-8s and audio in 2-6s, and rejects every tenth audio call with HTTP 429. Time is scaled (1 real ms = SCALE virtual
 * ms) so the whole scenario takes a few seconds of wall clock; every timer, backoff, wait and deadline is virtual.
 */
test('C load: 30 players, 20/4 slots, 10% Fish 429: nothing fails, voice or text fallback, <=4 audio in flight, budget exact', async (t) => {
  const SCALE = 20,
    PLAYERS = 30,
    base = 1_800_000_000_000,
    started = Date.now();
  const clock = { now: () => base + (Date.now() - started) * SCALE };
  const virtualSleep = (ms: number) => new Promise((done) => setTimeout(done, Math.max(1, Math.round(ms / SCALE))));
  let seed = 20260603;
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  const between = (low: number, high: number) => low + Math.floor(random() * (high - low + 1));
  const sha = (value: string) => createHash('sha256').update(value).digest('hex');

  const store = new Store(':memory:');
  t.after(() => store.close());
  Object.defineProperty(store, 'concurrency', { value: parseWebConcurrency(undefined) });
  const folder = new URL('../../../apps/server/web-migrations/', import.meta.url);
  for (const file of readdirSync(folder).sort()) {
    if (Number(file.slice(0, 3)) > 112) break;
    store.db.exec(readFileSync(new URL(file, folder), 'utf8'));
  }
  store.db.exec('PRAGMA user_version=112');
  store.run('INSERT INTO web_instance(singleton,instance_id) VALUES (1,?)', 'load-instance');
  store.run('INSERT INTO character_templates VALUES (?,?,?)', 'character', 1, '{}');
  const voiceVersion = 'load-voice:v1';
  const bubbles = [
    { text: '第一段合成语音。', expression: 'neutral' as const },
    { text: '第二段合成语音。', expression: 'neutral' as const },
  ];
  const requests = new Map<string, ReturnType<typeof textRequest>>();
  const now = base;
  for (let i = 0; i < PLAYERS; i++) {
    const [player, world, conversation, input, principal, window, operation] = [
      `player-${i}`,
      `world-${i}`,
      `conversation-${i}`,
      `input-${i}`,
      `principal-${i}`,
      `window-${i}`,
      `operation-${i}`,
    ];
    store.run('INSERT INTO api_players VALUES (?,?)', player, now);
    store.run('INSERT INTO worlds VALUES (?,?,?,?)', world, player, 'UTC', '{}');
    store.run("INSERT INTO world_characters VALUES (?,'character','new')", world);
    store.run(
      "INSERT INTO conversations(world_id,id,kind,private_character_id) VALUES (?,?,'private','character')",
      world,
      conversation,
    );
    store.run("INSERT INTO participants VALUES (?,?,'character')", world, conversation);
    store.run("INSERT INTO contacts VALUES (?,?,'character','{}')", world, conversation);
    store.run(
      `INSERT INTO messages(id,world_id,conversation_id,author_kind,author_id,body,created_at,delivery,proactive)
      VALUES (?,?,?,'player',?,'合成',?,'text',0)`,
      input,
      world,
      conversation,
      player,
      now,
    );
    store.run(
      "INSERT INTO web_principals(id,player_id,world_id,kind) VALUES (?,?,?,'guest')",
      principal,
      player,
      world,
    );
    store.run(
      `INSERT INTO web_guest_retention(principal_id,world_id,started_at,expires_at,state)
      VALUES (?,?,?,?,'active')`,
      principal,
      world,
      now - 1,
      now + 3_600_000,
    );
    store.run(
      'INSERT INTO web_ip_windows(id,ip_hash,starts_at,expires_at,reserved) VALUES (?,?,?,?,1)',
      window,
      `ip-${i}`,
      now - 1,
      now + 3_600_000,
    );
    store.run('UPDATE web_principals SET trial_reserved=1 WHERE id=?', principal);
    store.run('INSERT INTO web_ip_lifetime_quota VALUES (?,?,0,1,1)', `ip-${i}`, 'synthetic');
    store.run(
      `INSERT INTO web_operations(id,principal_id,request_id,payload_hash,world_id,conversation_id,
      character_id,input_message_id,ip_window_id,status,quota_state,created_at,deadline_at,text_queued_at,admission_seq)
      VALUES (?,?,?,?,?,?,'character',?,?,'queued','reserved',?,?,?,?)`,
      operation,
      principal,
      `request-${i}`,
      `payload-${i}`,
      world,
      conversation,
      input,
      window,
      now,
      now + 300_000,
      now,
      i + 1,
    );
    freezeInputSnapshot(store as WebStore, operation, now);
    const request = textRequest();
    request.jobId = operation;
    request.scope = { worldId: world, conversationId: conversation, characterId: 'character' };
    request.character.id = 'character';
    request.requiredMessageIds = [input];
    request.messages = [
      {
        ...request.messages[0]!,
        id: input,
        worldId: world,
        conversationId: conversation,
        authorId: player,
        text: '合成',
      },
    ];
    request.deliveryMode = 'voice';
    request.sceneContext = sceneState(
      userStore(store),
      { playerId: player, worldId: world, conversationId: conversation, characterId: 'character' },
      now,
    );
    const json = JSON.stringify(request);
    store.run(
      `INSERT INTO web_v7_requests VALUES (?,?,?,?,?,'character',?,?,?,?,?,0,'0:0',0,0,?,?)`,
      operation,
      principal,
      player,
      world,
      conversation,
      input,
      json,
      sha(json),
      sha(JSON.stringify(protocolFingerprint())),
      textPromptHash(),
      voiceVersion,
      now,
    );
    requests.set(sha(JSON.stringify([world, conversation, 'character'])), request);
  }
  migrateWebProviderOffline(store);
  migrateWebProviderMetrics(store);

  // The controlled provider scripts each outcome just in time; the latency of every call is virtual.
  const provider = new ControlledProvider(new ManualClock());
  const live = { text: 0, audio: 0, maxText: 0, maxAudio: 0, audioCalls: 0, rejected: 0 };
  const generator = new DeepSeekTextGenerator({
    apiKey: 'offline-only',
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { user_id: string; tools: { function: { name: string } }[] };
      const request = requests.get(body.user_id)!;
      const draft = body.tools[0]!.function.name === 'submit_dialogue_draft';
      provider.script(request.jobId, 'text', draft ? 0 : 1, { kind: 'ok', value: 'text' });
      live.maxText = Math.max(live.maxText, ++live.text);
      try {
        await provider.invoke(request.jobId, 'text', draft ? 0 : 1);
        await virtualSleep(between(1500, 4000));
      } finally {
        live.text--;
      }
      if (draft) return Response.json(draftEnvelope(request));
      const envelope = acceptedAuditEnvelope(request);
      const call = envelope.choices[0]!.message.tool_calls[0]!.function;
      const audit = JSON.parse(call.arguments);
      audit.replacementBubbles = bubbles;
      const key = Object.keys(audit.coverage)[0]!;
      audit.coverage[key].supportQuote = bubbles[0]!.text;
      call.arguments = JSON.stringify(audit);
      return Response.json(envelope);
    },
  });
  const fish: FakeFish = async (request) => {
    const separator = request.speech.jobId.lastIndexOf('-');
    const operation = request.speech.jobId.slice(0, separator),
      segment = Number(request.speech.jobId.slice(separator + 1));
    live.maxAudio = Math.max(live.maxAudio, ++live.audio);
    try {
      const call = ++live.audioCalls;
      provider.script(
        operation,
        'audio',
        segment,
        call % 10 === 0 ? { kind: 'rate_limited', retryAfterMs: 0 } : { kind: 'ok', value: 'clip' },
      );
      const outcome = await provider.invoke(operation, 'audio', segment);
      if (outcome.kind === 'rate_limited') {
        live.rejected++;
        throw new DomainError('FISH_RATE_LIMITED');
      }
      await virtualSleep(between(2000, 6000));
      return { audio: syntheticTone(), receipt: { id: 'load-fish' }, usageUnits: request.billedTextBytes };
    } finally {
      live.audio--;
    }
  };
  const budget = new MemoryBudget();
  const runner = new WebProviderRunner(store, clock, generator, fish, budget);
  const ledger = new WebProviderOffline(store, clock);
  const capacity = new WebDispatchLedger(store as WebStore, clock);
  for (const provider of ['deepseek', 'fish']) ledger.configureBudget(provider, 3_000_000);
  for (const phase of ['draft', 'review'] as const) {
    ledger.configurePrice({
      id: `deepseek-${phase}`,
      provider: 'deepseek',
      model: phase === 'draft' ? generator.model : generator.reviewModel,
      phase,
      currency: 'USD',
      unit: 'token',
      upperMicrosPerUnit: 1,
      validFrom: now - 1,
      validUntil: now + 3_600_000,
      version: 1,
    });
    capacity.configureBudget({ provider: 'deepseek', stage: 'text', phase, capacity: 20 });
  }
  ledger.configurePrice({
    id: 'fish-speech',
    provider: 'fish',
    model: 's2.1-pro',
    phase: 'speech',
    currency: 'USD',
    unit: 'byte',
    upperMicrosPerUnit: 1,
    validFrom: now - 1,
    validUntil: now + 3_600_000,
    version: 1,
  });
  capacity.configureBudget({ provider: 'fish', stage: 'audio', phase: 'speech', capacity: 4 });
  ledger.configureVoice({
    characterId: 'character',
    voiceVersion,
    voiceRevision: 1,
    profileId: 'load-profile',
    referenceId: 'load-reference',
    model: 's2.1-pro',
    approved: true,
  });
  const executor = new WebProviderExecutor(store, clock, runner, {
    hold: () => {},
    settled: async () => {},
  });
  t.after(() => executor.close());

  const terminal = () =>
    store.get<{ n: number }>(
      "SELECT count(*) n FROM web_operations WHERE status IN ('published','failed','cancelled','unknown')",
    )!.n;
  const wall = Date.now();
  while (terminal() < PLAYERS && Date.now() - wall < 45_000) {
    executor.managedPass('load-scheduler');
    await sleep(10);
  }
  await executor.close();
  const elapsedMs = Date.now() - wall;

  const statuses = store.all<{ status: string; n: number }>(
    'SELECT status,count(*) n FROM web_operations GROUP BY status',
  );
  assert.deepEqual(
    statuses.map((row) => [row.status, row.n]),
    [['published', PLAYERS]],
    `no operation fails: ${JSON.stringify(statuses)} ${executor.lastError}`,
  );
  const published = store.all<{ operation_id: string; origins: string }>(
    `SELECT operation_id,group_concat(origin) origins FROM web_publication_items
    WHERE origin IN ('narrative','text_fallback') GROUP BY operation_id`,
  );
  assert.equal(published.length, PLAYERS, 'every operation published');
  const voice = published.filter((row) => row.origins === 'narrative,narrative').length;
  const fallback = published.filter((row) => row.origins === 'text_fallback,text_fallback').length;
  assert.equal(
    voice + fallback,
    PLAYERS,
    'every voice request ended as voice or as a text fallback, never mixed or lost',
  );
  assert.ok(voice >= 1, 'some players still got voice');
  assert.ok(live.maxAudio >= 1 && live.maxAudio <= 4, `at most maxAudioRunning in flight: ${live.maxAudio}`);
  assert.ok(live.maxText > 4 && live.maxText <= 20, `text concurrency honours 20, not the old 4: ${live.maxText}`);
  assert.ok(live.rejected >= 1, 'the provider did answer 429 to some audio calls');
  const metrics = store.all<{ retries: number; fallback_used: number }>(
    'SELECT audio_rate_limit_retries retries,fallback_used FROM web_operation_metrics',
  );
  assert.equal(metrics.length, PLAYERS);
  assert.equal(
    metrics.reduce((n, row) => n + row.retries, 0),
    live.rejected,
    'every 429 was one counted retry (none exhausted)',
  );
  assert.equal(
    metrics.reduce((n, row) => n + row.fallback_used, 0),
    fallback,
  );

  // Paid audio is never discarded for waiting: an operation that fell back after waiting for a slot had not started
  // a single audio segment, so no successful speech attempt belongs to it.
  const waitDiscarded = store.get<{ n: number }>(
    `SELECT count(*) n FROM web_provider_attempts a JOIN web_operation_metrics m ON m.operation_id=a.operation_id
    WHERE m.fallback_reason='audio_wait' AND a.phase='speech' AND a.state IN ('sent','unknown','known')
      AND (a.state<>'known' OR a.outcome='succeeded')`,
  )!.n;
  assert.equal(waitDiscarded, 0, 'zero audio segments are discarded by the wait-time fallback');
  const waitFallbacks = store.get<{ n: number }>(
    "SELECT count(*) n FROM web_operation_metrics WHERE fallback_reason='audio_wait'",
  )!.n;
  const rateLimitDiscarded = store.get<{ n: number }>(
    'SELECT coalesce(sum(discarded_audio_segments),0) n FROM web_operation_metrics',
  )!.n;
  assert.equal(
    store.get<{ n: number }>(
      "SELECT count(*) n FROM web_operation_metrics WHERE fallback_reason='audio_wait' AND discarded_audio_segments<>0",
    )!.n,
    0,
    'the wait fallback records no discarded segment',
  );
  assert.equal(
    waitFallbacks +
      store.get<{ n: number }>("SELECT count(*) n FROM web_operation_metrics WHERE fallback_reason='rate_limited'")!.n,
    fallback,
    'every fallback has a recorded reason',
  );

  // Budget reconciles exactly: nothing held, nothing unknown, every reservation settled once.
  const attempts = store.all<{ provider: string; state: string; charged_micros: number | null }>(
    'SELECT provider,state,charged_micros FROM web_provider_attempts',
  );
  assert.ok(
    attempts.every((row) => row.state === 'known'),
    'no attempt left sent, unknown or not_sent',
  );
  for (const providerName of ['deepseek', 'fish']) {
    const spending = store.get<{ held_micros: number; spent_micros: number }>(
      'SELECT held_micros,spent_micros FROM web_provider_spending WHERE provider=?',
      providerName,
    )!;
    assert.equal(spending.held_micros, 0, `${providerName} nothing held`);
    assert.equal(
      spending.spent_micros,
      attempts.filter((row) => row.provider === providerName).reduce((n, row) => n + (row.charged_micros ?? 0), 0),
    );
  }
  const reconciled = budget.reconcile();
  assert.equal(reconciled.reservations, attempts.length, 'one reservation per attempt, retries reuse it');
  assert.equal(
    reconciled.charged,
    attempts.reduce((n, row) => n + (row.charged_micros ?? 0), 0),
    'shared budget equals the local ledger',
  );
  assert.equal(
    store.get<{ n: number }>('SELECT sum(reserved) n FROM web_external_budgets')!.n,
    0,
    'no provider capacity ticket left',
  );
  assert.equal(store.get<{ n: number }>('SELECT sum(trial_reserved) n FROM web_principals')!.n, 0);
  assert.equal(store.get<{ n: number }>('SELECT sum(trial_used) n FROM web_principals')!.n, PLAYERS);
  console.log(
    JSON.stringify({
      cLoad30: 'controlled-provider',
      players: PLAYERS,
      virtualToRealScale: SCALE,
      elapsedMs,
      voice,
      textFallback: fallback,
      waitFallbacks,
      waitDiscardedAudio: waitDiscarded,
      rateLimitDiscardedAudio: rateLimitDiscarded,
      audioCalls: live.audioCalls,
      rejected429: live.rejected,
      maxAudioInFlight: live.maxAudio,
      maxTextInFlight: live.maxText,
    }),
  );
});

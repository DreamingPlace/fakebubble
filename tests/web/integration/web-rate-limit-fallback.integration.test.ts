import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import test, { type TestContext } from 'node:test';
import { DomainError } from '../../../packages/domain/errors.ts';
import { Store, type WebStore } from '../../../apps/server/platform/store.ts';
import { WebProviderOffline } from '../../../apps/server/generation/web-provider-offline.ts';
import {
  migrateWebProviderMetrics,
  migrateWebProviderOffline,
} from '../../../apps/server/generation/web-provider-migration.ts';
import { syntheticTone } from '../../../apps/server/platform/web-local-fake.ts';
import { draftEnvelope, acceptedAuditEnvelope, draftPresentation, textRequest } from '../../text-fixtures.ts';
import { protocolFingerprint } from '../../../apps/server/generation/accepted-text-protocol.ts';
import { textPromptHash } from '../../../apps/server/generation/accepted-text-prompt.ts';
import { freezeInputSnapshot } from '../../../apps/server/generation/web-input-snapshot.ts';
import { WebStageQueue } from '../../../apps/server/admission/web-stage-queue.ts';
import { WebDispatchLedger } from '../../../apps/server/budget/web-dispatch-ledger.ts';
import { sceneState } from '../../../apps/server/conversation/scenes.ts';
import { userStore } from '../../../apps/server/platform/store-boundary.ts';
import { DeepSeekTextGenerator } from '../../../apps/server/generation/deepseek.ts';
import { WebProviderRunner, type FakeFish } from '../../../apps/server/generation/web-provider-runner.ts';
import { WebVerticalPublisher } from '../../../apps/server/conversation/web-vertical-publisher.ts';
import type { WebAttemptBudget } from '../../../apps/server/budget/web-provider-budget-contract.ts';
import { MemoryBudget } from '../fixtures/memory-budget.ts';
import { WebAccountAdmin } from '../../../apps/server/admin/web-account-admin.ts';
import { webProviderNextDue } from '../../../apps/server/cloudflare/web-executor.ts';
import { WebProviderExecutor } from '../../../apps/server/generation/web-provider-executor.ts';
import { WEB_LIMITS } from '../../../config/web-v1.ts';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const now = 1_700_000_000_000;

function fixture(t: TestContext) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const folder = new URL('../../../apps/server/web-migrations/', import.meta.url);
  for (const file of readdirSync(folder).sort()) {
    if (Number(file.slice(0, 3)) > 112) break;
    store.db.exec(readFileSync(new URL(file, folder), 'utf8'));
  }
  store.db.exec('PRAGMA user_version=112');
  store.run('INSERT INTO web_instance(singleton,instance_id) VALUES (1,?)', 'fixture-instance');
  store.run('INSERT INTO character_templates VALUES (?,?,?)', 'character', 1, '{}');
  store.run('INSERT INTO api_players VALUES (?,?)', 'player', now);
  store.run('INSERT INTO worlds VALUES (?,?,?,?)', 'world', 'player', 'UTC', '{}');
  store.run("INSERT INTO world_characters VALUES ('world','character','new')");
  store.run(
    "INSERT INTO conversations(world_id,id,kind,private_character_id) VALUES ('world','conversation','private','character')",
  );
  store.run("INSERT INTO participants VALUES ('world','conversation','character')");
  store.run("INSERT INTO contacts VALUES ('world','conversation','character','{}')");
  store.run(
    "INSERT INTO messages(id,world_id,conversation_id,author_kind,author_id,body,created_at,delivery,proactive) VALUES ('input','world','conversation','player','player','合成',?,'text',0)",
    now,
  );
  store.run("INSERT INTO web_principals(id,player_id,world_id,kind) VALUES ('principal','player','world','guest')");
  store.run(
    `INSERT INTO web_guest_retention(principal_id,world_id,started_at,expires_at,state)
    VALUES ('principal','world',?,?,'active')`,
    now - 1,
    now + 999_999,
  );
  store.run(
    "INSERT INTO web_ip_windows(id,ip_hash,starts_at,expires_at) VALUES ('window','ip',?,?)",
    now - 1,
    now + 999_999,
  );
  store.run("UPDATE web_ip_windows SET reserved=1 WHERE id='window'");
  store.run("UPDATE web_principals SET trial_reserved=1 WHERE id='principal'");
  store.run("INSERT INTO web_ip_lifetime_quota VALUES ('ip','synthetic',0,1,1)");
  store.run(
    `INSERT INTO web_operations(id,principal_id,request_id,payload_hash,world_id,conversation_id,
    character_id,input_message_id,ip_window_id,status,quota_state,created_at,deadline_at)
    VALUES ('operation','principal','request','payload','world','conversation','character','input',
      'window','queued','reserved',?,?)`,
    now,
    now + 100_000,
  );
  freezeInputSnapshot(store as WebStore, 'operation', now);
  const request = textRequest();
  request.jobId = 'operation';
  request.scope = { worldId: 'world', conversationId: 'conversation', characterId: 'character' };
  request.character.id = 'character';
  request.requiredMessageIds = ['input'];
  request.messages = [
    {
      ...request.messages[0]!,
      id: 'input',
      worldId: 'world',
      conversationId: 'conversation',
      authorId: 'player',
      text: '合成',
    },
  ];
  request.deliveryMode = 'voice';
  request.sceneContext = sceneState(
    userStore(store),
    { playerId: 'player', worldId: 'world', conversationId: 'conversation', characterId: 'character' },
    now,
  );
  const requestJson = JSON.stringify(request);
  const requestDigest = hash(requestJson),
    policyHash = hash('policy'),
    voiceVersion = 'fixture-voice:v1';
  store.run(
    `INSERT INTO web_v7_requests VALUES ('operation','principal','player','world','conversation',
    'character','input',?,?,?,?,0,'0:0',0,0,?,?)`,
    requestJson,
    requestDigest,
    hash(JSON.stringify(protocolFingerprint())),
    textPromptHash(),
    voiceVersion,
    now,
  );
  migrateWebProviderOffline(store);
  migrateWebProviderMetrics(store);
  const ledger = new WebProviderOffline(store, { now: () => now });
  const scope = {
    principalId: 'principal',
    playerId: 'player',
    worldId: 'world',
    conversationId: 'conversation',
    characterId: 'character',
    inputMessageId: 'input',
  };
  const price = (provider: string, phase: 'draft' | 'review' | 'speech') => {
    ledger.configureBudget(provider, 3_000_000);
    ledger.configurePrice({
      id: `${provider}-${phase}-v1`,
      provider,
      model: 'fake-model',
      phase,
      currency: 'USD',
      unit: phase === 'speech' ? 'byte' : 'token',
      upperMicrosPerUnit: 1000,
      validFrom: now - 1,
      validUntil: now + 10_000,
      version: 1,
    });
  };
  const input = (phase: 'draft' | 'review' | 'speech', ordinal = -1) => ({
    operationId: 'operation',
    phase,
    ordinal,
    ...scope,
    requestDigest,
    policyHash,
    wireRequestHash: hash(`${phase}:${ordinal}`),
    voiceVersion,
    provider: phase === 'speech' ? 'fake-fish' : 'fake-deepseek',
    model: 'fake-model',
    maxUnits: 1000,
  });
  return { store, ledger, scope, price, input, request, requestDigest, policyHash, voiceVersion };
}

const bubbles = [
  { text: '第一段合成语音。', expression: 'neutral' as const },
  { text: '第二段合成语音。', expression: 'neutral' as const },
];
const signal = () => new AbortController().signal;
const rateLimited = () => new DomainError('FISH_RATE_LIMITED');

function stage(
  t: TestContext,
  options: {
    fish: (call: number, request: Parameters<FakeFish>[0]) => Promise<ReturnType<typeof ok>> | ReturnType<typeof ok>;
    fetch?: (call: number, tool: string) => Response | Promise<Response>;
    deadlineMs?: number;
  },
) {
  const f = fixture(t);
  let clockNow = now;
  const clock = { now: () => clockNow };
  const budget = new MemoryBudget();
  const calls = { fish: 0, text: 0, textAtReady: 0 };
  const generator = new DeepSeekTextGenerator({
    apiKey: 'offline-only',
    fetch: async (_url, init) => {
      calls.text++;
      const tool = JSON.parse(String(init?.body)).tools[0].function.name as string;
      if (options.fetch) return options.fetch(calls.text, tool);
      if (tool === 'submit_dialogue_draft') return Response.json(draftEnvelope(f.request));
      const envelope = acceptedAuditEnvelope(f.request);
      const call = envelope.choices[0]!.message.tool_calls[0]!.function;
      const audit = JSON.parse(call.arguments);
      audit.replacementBubbles = bubbles;
      audit.coverage.input.supportQuote = bubbles[0]!.text;
      call.arguments = JSON.stringify(audit);
      return Response.json(envelope);
    },
  });
  const fish: FakeFish = async (request) => options.fish(++calls.fish, request);
  const runner = new WebProviderRunner(f.store, clock, generator, fish, budget);
  const ledger = new WebProviderOffline(f.store, clock);
  const capacity = new WebDispatchLedger(f.store as WebStore, clock);
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
      validUntil: now + 1_000_000,
      version: 1,
    });
    capacity.configureBudget({ provider: 'deepseek', stage: 'text', phase, capacity: 2 });
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
    validUntil: now + 1_000_000,
    version: 1,
  });
  capacity.configureBudget({ provider: 'fish', stage: 'audio', phase: 'speech', capacity: 2 });
  ledger.configureVoice({
    characterId: 'character',
    voiceVersion: f.voiceVersion,
    voiceRevision: 1,
    profileId: 'synthetic-profile',
    referenceId: 'synthetic-reference',
    model: 's2.1-pro',
    approved: true,
  });
  f.store.run(
    "UPDATE web_operations SET deadline_at=?,text_queued_at=?,admission_seq=1 WHERE id='operation'",
    now + (options.deadlineMs ?? 300_000),
    now,
  );
  let ids = 0;
  const queue = new WebStageQueue(f.store as WebStore, clock, () => `stage-id-${++ids}`);
  const lease = queue.acquireCoordinator('coordinator');
  /** Runs the real text stage (draft + review) so the candidate is exactly what production would publish. */
  const readyForAudio = async () => {
    await runner.runText(queue.claimText(lease, 'text-worker')!, new AbortController().signal);
    assert.equal(
      f.store.get<{ status: string }>("SELECT status FROM web_operations WHERE id='operation'")?.status,
      'text_ready',
    );
    calls.textAtReady = calls.text;
  };
  const row = <T>(sql: string, ...params: (string | number)[]) => f.store.get<T>(sql, ...params)!;
  const attempt = (phase: string, ordinal: number) =>
    row<{ state: string; outcome: string | null; held_micros: number; charged_micros: number | null }>(
      'SELECT state,outcome,held_micros,charged_micros FROM web_provider_attempts WHERE operation_id=? AND phase=? AND ordinal=?',
      'operation',
      phase,
      ordinal,
    );
  const operation = () =>
    row<{ status: string; audio_wait_started_at: number | null; text_queued_at: number; quota_state: string }>(
      "SELECT status,audio_wait_started_at,text_queued_at,quota_state FROM web_operations WHERE id='operation'",
    );
  const spending = (provider: string) => ({
    ...row<{ held_micros: number; spent_micros: number }>(
      'SELECT held_micros,spent_micros FROM web_provider_spending WHERE provider=?',
      provider,
    ),
  });
  const metrics = () =>
    row<Record<string, number | string | null>>("SELECT * FROM web_operation_metrics WHERE operation_id='operation'");
  return {
    ...f,
    clock,
    budget,
    calls,
    runner,
    queue,
    lease,
    ledger,
    capacity,
    readyForAudio,
    attempt,
    operation,
    spending,
    metrics,
    row,
    advance: (ms: number) => {
      clockNow += ms;
    },
    generator,
  };
}
const ok = () => ({ audio: syntheticTone(), receipt: { id: 'fake-fish' }, usageUnits: 0 });
const fishOk = (request: Parameters<FakeFish>[0]) => ({ ...ok(), usageUnits: request.billedTextBytes });

test('Fish HTTP 429 is known not-executed: stage returns to pending with 2s/4s/8s backoff on ONE reservation', async (t) => {
  const f = stage(t, {
    fish: (call, request) => {
      if (call <= 3) throw rateLimited();
      return fishOk(request);
    },
  });
  await f.readyForAudio();
  const pause = [2000, 4000, 8000];
  let held: number | undefined;
  for (const [index, backoff] of pause.entries()) {
    const claim = f.queue.claimAudio(f.lease, 'audio-worker')!;
    assert.equal(claim.ordinal, 0);
    assert.equal(await f.runner.runSpeech(claim, signal()), null, 'a 429 is not a failure and is not thrown');
    assert.equal(f.calls.fish, index + 1);
    const state = f.attempt('speech', 0);
    assert.equal(state.state, 'not_sent', 'rejected before execution, so never unknown');
    held ??= state.held_micros;
    assert.equal(state.held_micros, held, 'the same single hold');
    assert.equal(f.spending('fish').held_micros, held, 'no second hold was added');
    const op = f.operation();
    assert.equal(op.status, 'audio_pending');
    assert.equal(op.audio_wait_started_at, f.clock.now() + backoff, `backoff ${backoff}ms`);
    assert.equal(f.queue.claimAudio(f.lease, 'audio-worker'), null, 'not claimable before the backoff ends');
    f.advance(backoff - 1);
    assert.equal(f.queue.claimAudio(f.lease, 'audio-worker'), null);
    f.advance(1);
  }
  const last = f.queue.claimAudio(f.lease, 'audio-worker')!;
  await f.runner.runSpeech(last, signal());
  assert.equal(f.calls.fish, 4, 'one call that ran, after three rejected ones');
  assert.equal(f.attempt('speech', 0).state, 'known');
  assert.equal(f.attempt('speech', 0).outcome, 'succeeded');
  assert.deepEqual(
    f.budget.calls.filter((c) => c.endsWith(':speech:0') || c.includes(':speech:')),
    ['begin:speech:0', 'resume:speech:0', 'resume:speech:0', 'resume:speech:0', 'settle:speech:0'],
  );
  const settled = f.spending('fish');
  assert.equal(settled.held_micros, 0);
  assert.equal(settled.spent_micros, f.attempt('speech', 0).charged_micros);
  assert.equal(f.metrics().audio_rate_limit_retries, 3);
  assert.equal(
    f.row<{ n: number }>("SELECT count(*) n FROM web_attempt_rejections WHERE operation_id='operation'").n,
    1,
  );
  assert.equal(
    f.row<{ reserved: number }>("SELECT reserved FROM web_external_budgets WHERE provider='fish'").reserved,
    0,
  );
});

test('Fish 429 never schedules a retry past the operation deadline', async (t) => {
  const f = stage(t, {
    fish: () => {
      throw rateLimited();
    },
    deadlineMs: 1500,
  });
  await f.readyForAudio();
  assert.equal(await f.runner.runSpeech(f.queue.claimAudio(f.lease, 'audio-worker')!, signal()), null);
  assert.equal(f.calls.fish, 1);
  assert.equal(f.attempt('speech', 0).state, 'known', '2s would pass the 1.5s deadline: no retry');
  assert.equal(f.attempt('speech', 0).charged_micros, 0);
  assert.equal(f.metrics().fallback_reason, 'rate_limited');
  assert.equal(f.spending('fish').held_micros, 0);
});

test('Fish 429 retries exhausted: text fallback publishes the reviewed text as text, budget released exactly once', async (t) => {
  const f = stage(t, {
    fish: () => {
      throw rateLimited();
    },
  });
  await f.readyForAudio();
  for (const backoff of [2000, 4000, 8000, 0]) {
    const claim = f.queue.claimAudio(f.lease, 'audio-worker')!;
    assert.ok(claim, `claimable after ${backoff}ms`);
    await f.runner.runSpeech(claim, signal());
    f.advance(backoff);
  }
  assert.equal(f.calls.fish, 4, 'first call plus three retries, then stop');
  const spent = f.attempt('speech', 0);
  assert.deepEqual([spent.state, spent.outcome, spent.charged_micros], ['known', 'failed', 0]);
  assert.deepEqual(f.spending('fish'), { held_micros: 0, spent_micros: 0 });
  assert.deepEqual(
    f.budget.calls.filter((c) => c.endsWith(':speech:0') || c.includes(':speech:')),
    ['begin:speech:0', 'resume:speech:0', 'resume:speech:0', 'resume:speech:0', 'settle:speech:0'],
  );
  assert.equal(f.budget.entries.get('operation:speech:0')?.charged, 0);
  assert.equal(
    f.row<{ reserved: number }>("SELECT reserved FROM web_external_budgets WHERE provider='fish'").reserved,
    0,
  );
  assert.equal(f.metrics().fallback_reason, 'rate_limited');
  assert.equal(f.metrics().fallback_used, 0);
  assert.equal(f.queue.claimAudio(f.lease, 'audio-worker'), null, 'a given-up voice stage is never claimed again');
  const receipt = await f.runner.publishTextFallback(f.lease, 'operation');
  assert.equal(receipt.messageIds.length, 2);
  assert.equal(receipt.footerMessageId, null);
  const messages = f.store.all<{ body: string; delivery: string; voice_fallback: number; media_id: string | null }>(
    `SELECT m.body,m.delivery,m.voice_fallback,m.media_id FROM web_publication_items i
    JOIN messages m ON m.id=i.message_id WHERE i.operation_id='operation' ORDER BY i.ordinal`,
  );
  assert.deepEqual(
    messages.map((m) => [m.body, m.delivery, m.voice_fallback, m.media_id]),
    bubbles.map((b) => [b.text, 'text', 1, null]),
  );
  assert.deepEqual(
    f.store
      .all<Record<string, unknown>>(
        "SELECT ordinal,origin,media_id FROM web_publication_items WHERE operation_id='operation' ORDER BY ordinal",
      )
      .map((item) => ({ ...item })),
    [
      { ordinal: 0, origin: 'text_fallback', media_id: null },
      { ordinal: 1, origin: 'text_fallback', media_id: null },
    ],
  );
  assert.equal(f.operation().status, 'published');
  assert.equal(f.operation().quota_state, 'used');
  assert.equal(f.metrics().fallback_used, 1);
  assert.equal(f.calls.text, f.calls.textAtReady, 'the fallback never generates new text');
  assert.equal(f.calls.fish, 4, 'and never calls the speech provider again');
  assert.deepEqual(
    await f.runner.publishTextFallback(f.lease, 'operation').catch((e) => (e as Error).message),
    'WEB_PUBLICATION_NOT_READY',
  );
});

test('no audio slot within audioFallbackWaitMs: reviewed text is published as text without any provider call', async (t) => {
  const f = stage(t, {
    fish: () => {
      throw new Error('FISH_MUST_NOT_BE_CALLED');
    },
  });
  await f.readyForAudio();
  assert.deepEqual(f.ledger.fallbackDue(f.clock.now()), []);
  f.advance(7_999);
  assert.deepEqual(f.ledger.fallbackDue(f.clock.now()), [], '8s is the default wait');
  f.advance(1);
  assert.deepEqual(f.ledger.fallbackDue(f.clock.now()), ['operation']);
  assert.equal(await f.runner.beginTextFallback('operation'), 0, 'nothing was held for the unused audio stage');
  assert.equal(f.metrics().fallback_reason, 'audio_wait');
  assert.equal(f.metrics().audio_queue_wait_ms, 8_000);
  assert.deepEqual(f.ledger.fallbackDue(f.clock.now()), [], 'decided once');
  assert.equal(f.queue.claimAudio(f.lease, 'audio-worker'), null);
  const receipt = await f.runner.publishTextFallback(f.lease, 'operation');
  assert.equal(receipt.messageIds.length, 2);
  assert.equal(f.calls.fish, 0);
  assert.equal(f.calls.text, f.calls.textAtReady);
  assert.equal(f.operation().status, 'published');
  assert.equal(f.metrics().fallback_used, 1);
  assert.deepEqual(f.spending('fish'), { held_micros: 0, spent_micros: 0 });
});

test('waiting for a slot after a 429 counts from the backoff end; the held reservation is settled at zero on fallback', async (t) => {
  const f = stage(t, {
    fish: () => {
      throw rateLimited();
    },
  });
  await f.readyForAudio();
  await f.runner.runSpeech(f.queue.claimAudio(f.lease, 'audio-worker')!, signal());
  assert.equal(f.attempt('speech', 0).state, 'not_sent');
  const held = f.attempt('speech', 0).held_micros;
  assert.equal(f.spending('fish').held_micros, held);
  f.advance(2_000 + 7_999);
  assert.deepEqual(f.ledger.fallbackDue(f.clock.now()), [], 'not yet 8s of waiting after the backoff');
  f.advance(1);
  assert.deepEqual(f.ledger.fallbackDue(f.clock.now()), ['operation']);
  assert.equal(await f.runner.beginTextFallback('operation'), 1);
  assert.deepEqual(f.attempt('speech', 0).outcome, 'failed');
  assert.equal(f.attempt('speech', 0).charged_micros, 0);
  assert.deepEqual(f.spending('fish'), { held_micros: 0, spent_micros: 0 });
  assert.deepEqual(
    f.budget.calls.filter((c) => c.endsWith(':speech:0') || c.includes(':speech:')),
    ['begin:speech:0', 'settle:speech:0'],
  );
  assert.equal(
    f.row<{ reserved: number }>("SELECT reserved FROM web_external_budgets WHERE provider='fish'").reserved,
    0,
  );
  await f.runner.publishTextFallback(f.lease, 'operation');
  assert.equal(f.operation().status, 'published');
});

test('timeouts, network errors and 5xx are still UNKNOWN and never retried', async (t) => {
  for (const code of ['AUDIO_REQUEST_TIMEOUT', 'AUDIO_NETWORK_ERROR', 'FISH_UNAVAILABLE', 'FISH_REQUEST_REJECTED']) {
    await t.test(`fish ${code}`, async () => {
      const f = stage(t, {
        fish: () => {
          throw new DomainError(code);
        },
      });
      await f.readyForAudio();
      const claim = f.queue.claimAudio(f.lease, 'audio-worker')!;
      await assert.rejects(f.runner.runSpeech(claim, signal()), new RegExp(code));
      assert.equal(f.attempt('speech', 0).state, 'unknown');
      assert.equal(f.operation().status, 'audio_running', 'the claim is not returned to pending');
      assert.equal(f.row<{ n: number }>('SELECT count(*) n FROM web_attempt_rejections').n, 0);
      await assert.rejects(f.runner.runSpeech(claim, signal()), /WEB_PROVIDER_RECOVERY_UNKNOWN/);
      assert.equal(f.calls.fish, 1, 'never resent');
      assert.ok(f.spending('fish').held_micros > 0, 'the reservation is not released');
      assert.deepEqual(
        f.budget.calls.filter((c) => c.endsWith(':speech:0') || c.includes(':speech:')),
        ['begin:speech:0'],
      );
    });
  }
  const f = stage(t, {
    fish: () => {
      throw new Error('FISH_NOT_CALLED');
    },
    fetch: () => {
      throw new TypeError('network down');
    },
  });
  const text = f.queue.claimText(f.lease, 'text-worker')!;
  await assert.rejects(f.runner.runText(text, signal()));
  assert.equal(f.attempt('draft', -1).state, 'unknown');
  assert.equal(f.operation().status, 'text_running');
  await assert.rejects(f.runner.runText(text, signal()), /WEB_PROVIDER_RECOVERY_UNKNOWN/);
  assert.equal(f.calls.text, 1);
});

test('DeepSeek 5xx is still UNKNOWN; DeepSeek HTTP 429 is known not-executed and retried once on one reservation', async (t) => {
  const five = stage(t, {
    fish: () => fishOk({ billedTextBytes: 1 } as never),
    fetch: () => new Response('x', { status: 503 }),
  });
  await assert.rejects(five.runner.runText(five.queue.claimText(five.lease, 'text-worker')!, signal()));
  assert.equal(five.attempt('draft', -1).state, 'unknown');
  assert.equal(five.row<{ n: number }>('SELECT count(*) n FROM web_attempt_rejections').n, 0);

  const f = stage(t, {
    fish: () => fishOk({ billedTextBytes: 1 } as never),
    fetch: (call, tool) => {
      if (call === 1) return new Response('{}', { status: 429 });
      return Response.json(
        tool === 'submit_dialogue_draft' ? draftEnvelope(f.request) : acceptedAuditEnvelope(f.request),
      );
    },
  });
  const first = f.queue.claimText(f.lease, 'text-worker')!;
  assert.equal(await f.runner.runText(first, signal()), null);
  assert.equal(f.attempt('draft', -1).state, 'not_sent');
  assert.equal(f.operation().status, 'queued');
  assert.equal(f.operation().text_queued_at, f.clock.now() + 2_000);
  assert.equal(f.queue.claimText(f.lease, 'text-worker'), null, 'waits out the backoff');
  const held = f.attempt('draft', -1).held_micros;
  assert.equal(f.spending('deepseek').held_micros, held, 'one hold, not two');
  f.advance(2_000);
  const second = f.queue.claimText(f.lease, 'text-worker')!;
  assert.ok(second);
  await f.runner.runText(second, signal());
  assert.equal(f.calls.text, 3, 'rejected draft, draft that ran, review');
  assert.equal(f.operation().status, 'text_ready');
  assert.deepEqual(f.budget.calls, [
    'begin:draft:-1',
    'resume:draft:-1',
    'settle:draft:-1',
    'begin:review:-1',
    'settle:review:-1',
  ]);
  assert.equal(f.spending('deepseek').held_micros, 0);
  assert.equal(f.metrics().text_rate_limit_retries, 1);
  assert.equal(f.metrics().text_queue_wait_ms, 0);
  assert.equal(f.metrics().text_stage_ms, 2_000);
});

test("an operation waiting out a 429 backoff keeps its place ahead of the same principal's later inputs", async (t) => {
  const f = stage(t, {
    fish: () => fishOk({ billedTextBytes: 1 } as never),
    fetch: () => new Response('{}', { status: 429 }),
  });
  f.store.run(
    `INSERT INTO messages(id,world_id,conversation_id,author_kind,author_id,body,created_at,delivery,proactive)
    VALUES ('later-input','world','conversation','player','player','再来一句',?,'text',0)`,
    now + 1,
  );
  f.store.run(
    `INSERT INTO web_operations(id,principal_id,request_id,payload_hash,world_id,conversation_id,
    character_id,input_message_id,ip_window_id,status,quota_state,created_at,deadline_at,text_queued_at,admission_seq)
    VALUES ('later','principal','later-request','later-payload','world','conversation','character','later-input',
      'window','queued','reserved',?,?,?,2)`,
    now + 1,
    now + 300_000,
    now + 1,
  );
  const first = f.queue.claimText(f.lease, 'text-worker')!;
  assert.equal(first.operationId, 'operation');
  await f.runner.runText(first, signal());
  assert.equal(f.operation().status, 'queued');
  assert.equal(f.queue.claimText(f.lease, 'text-worker'), null, 'the later input does not jump the queue');
});

test('the audio slot limit counts a backing-off attempt, so a retry never competes for capacity it already holds', async (t) => {
  const f = stage(t, {
    fish: () => {
      throw rateLimited();
    },
  });
  await f.readyForAudio();
  f.store.run("UPDATE web_external_budgets SET capacity=1 WHERE provider='fish'");
  await f.runner.runSpeech(f.queue.claimAudio(f.lease, 'audio-worker')!, signal());
  assert.equal(f.attempt('speech', 0).state, 'not_sent');
  assert.equal(
    f.row<{ reserved: number }>("SELECT reserved FROM web_external_budgets WHERE provider='fish'").reserved,
    1,
    'the rewound attempt keeps its provider capacity ticket',
  );
});

test('the Cloudflare alarm wakes at the backoff end and at the fallback wait, not in a busy loop', async (t) => {
  const f = stage(t, {
    fish: () => {
      throw rateLimited();
    },
  });
  await f.readyForAudio();
  const store = f.store as WebStore;
  // Waiting for an audio slot: the next wake is the fallback decision, 8s after the wait started.
  assert.equal(webProviderNextDue(store, f.clock.now(), false), now + 8_000);
  await f.runner.runSpeech(f.queue.claimAudio(f.lease, 'audio-worker')!, signal());
  const retryAt = f.clock.now() + 2_000;
  assert.equal(f.operation().audio_wait_started_at, retryAt);
  assert.equal(webProviderNextDue(store, f.clock.now(), true), retryAt, 'the retry is due at the backoff end');
  f.advance(2_000);
  assert.equal(webProviderNextDue(store, f.clock.now(), true), f.clock.now(), 'claimable now');
  await f.runner.runSpeech(f.queue.claimAudio(f.lease, 'audio-worker')!, signal());
  assert.equal(webProviderNextDue(store, f.clock.now(), true), f.clock.now() + 4_000);
});

test('once the first audio segment was sent the wait fallback never applies: the operation keeps waiting and ends as voice', async (t) => {
  const f = stage(t, { fish: (_call, request) => fishOk(request) });
  await f.readyForAudio();
  await f.runner.runSpeech(f.queue.claimAudio(f.lease, 'audio-worker')!, signal());
  assert.equal(f.operation().status, 'audio_pending', 'segment 0 is paid and finished; segment 1 waits for a slot');
  f.advance(8_000);
  assert.deepEqual(f.ledger.fallbackDue(f.clock.now()), [], 'a started operation is exempt from the wait fallback');
  f.advance(20_000);
  assert.deepEqual(f.ledger.fallbackDue(f.clock.now()), [], 'however long it waits');
  await assert.rejects(f.runner.beginTextFallback('operation'), /WEB_FALLBACK_NOT_DUE/);
  assert.equal(f.metrics().fallback_reason, null);
  await f.runner.runSpeech(f.queue.claimAudio(f.lease, 'audio-worker')!, signal());
  const receipt = f.runner.publish(f.lease, 'operation');
  assert.equal(receipt.messageIds.length, 2);
  assert.deepEqual(
    f.store
      .all<{ origin: string }>(
        "SELECT origin FROM web_publication_items WHERE operation_id='operation' ORDER BY ordinal",
      )
      .map((item) => item.origin),
    ['narrative', 'narrative'],
  );
  assert.equal(f.metrics().fallback_used, 0);
  assert.equal(f.metrics().discarded_audio_segments, 0);
  assert.equal(f.calls.fish, 2);
});

test('429 retries exhausted after an earlier segment was generated: the discarded paid segment is counted', async (t) => {
  const f = stage(t, {
    fish: (call, request) => {
      if (call === 1) return fishOk(request);
      throw rateLimited();
    },
  });
  await f.readyForAudio();
  await f.runner.runSpeech(f.queue.claimAudio(f.lease, 'audio-worker')!, signal());
  for (const backoff of [2000, 4000, 8000, 0]) {
    await f.runner.runSpeech(f.queue.claimAudio(f.lease, 'audio-worker')!, signal());
    f.advance(backoff);
  }
  assert.equal(f.metrics().fallback_reason, 'rate_limited');
  assert.equal(f.metrics().discarded_audio_segments, 1, 'segment 0 was generated and paid, then dropped for text');
  await f.runner.publishTextFallback(f.lease, 'operation');
  assert.equal(f.metrics().fallback_used, 1);
});

test('both text calls store DeepSeek cache hit/miss tokens and the owner view reports the daily hit ratio per stage', async (t) => {
  const s = stage(t, { fish: (_call, request) => fishOk(request) });
  await s.readyForAudio();
  const usage = (phase: string) =>
    JSON.parse(
      s.row<{ metadata_json: string }>(
        "SELECT metadata_json FROM web_provider_attempts WHERE operation_id='operation' AND phase=?",
        phase,
      ).metadata_json,
    ).usage;
  assert.deepEqual(usage('draft'), {
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    cacheHitInputTokens: 6,
    cacheMissInputTokens: 4,
  });
  assert.deepEqual(usage('review'), {
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    cacheHitInputTokens: 8,
    cacheMissInputTokens: 2,
  });
  const origin = 'https://admin.fixture.invalid';
  const admin = new WebAccountAdmin(s.store, s.clock, origin);
  const owner = admin.login(admin.issueLoginGrant().token, origin);
  const view = admin.stageLatency(owner.cookie, owner.csrf, origin, 7) as { days: { day: string; cache: unknown }[] };
  assert.equal(view.days.length, 1);
  assert.deepEqual(view.days[0]!.cache, {
    draft: { calls: 1, hitTokens: 6, missTokens: 4, hitRatio: 0.6 },
    review: { calls: 1, hitTokens: 8, missTokens: 2, hitRatio: 0.8 },
  });
});

test('a provider that reports no cache counters adds no cache sample (ratio null, never a guess)', async (t) => {
  let request: ReturnType<typeof textRequest> | undefined;
  const s = stage(t, {
    fish: (_call, request) => fishOk(request),
    fetch: (_call, tool) => {
      const envelope = tool === 'submit_dialogue_draft' ? draftEnvelope(request) : acceptedAuditEnvelope(request);
      if (tool !== 'submit_dialogue_draft') {
        const call = envelope.choices[0]!.message.tool_calls[0]!.function;
        const audit = JSON.parse(call.arguments);
        audit.replacementBubbles = bubbles;
        audit.coverage.input.supportQuote = bubbles[0]!.text;
        call.arguments = JSON.stringify(audit);
      }
      return Response.json({ ...envelope, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
    },
  });
  request = s.request;
  await s.readyForAudio();
  const origin = 'https://admin.fixture.invalid';
  const admin = new WebAccountAdmin(s.store, s.clock, origin);
  const owner = admin.login(admin.issueLoginGrant().token, origin);
  const view = admin.stageLatency(owner.cookie, owner.csrf, origin, 7) as { days: { cache: unknown }[] };
  const none = { calls: 0, hitTokens: 0, missTokens: 0, hitRatio: null };
  assert.deepEqual(view.days[0]!.cache, { draft: none, review: none });
});

test('an operation that started audio is not expired by the summed 60 s queue wait; it finishes as voice within its deadline', async (t) => {
  const f = stage(t, { fish: (_call, request) => fishOk(request), deadlineMs: 300_000 });
  await f.readyForAudio();
  await f.runner.runSpeech(f.queue.claimAudio(f.lease, 'audio-worker')!, signal());
  assert.equal(f.operation().status, 'audio_pending', 'segment 0 is paid and finished; segment 1 waits for a slot');
  // Wait far longer than queueWaitMs in total for the next slot, still well inside the operation deadline.
  for (let waited = 0; waited < WEB_LIMITS.queueWaitMs + 30_000; waited += 10_000) f.advance(10_000);
  assert.ok(f.clock.now() - now > WEB_LIMITS.queueWaitMs);
  assert.ok(f.clock.now() < now + 300_000);
  const lease = f.queue.acquireCoordinator('coordinator');
  const fence = f.capacity.fence('operation');
  assert.throws(
    () => f.capacity.terminate(lease, fence, fence.principalId, 'failed', 'expired'),
    /WEB_OPERATION_NOT_EXPIRED/,
    'the wait alone no longer ends a started operation',
  );
  assert.equal(f.operation().status, 'audio_pending');
  assert.equal(f.operation().quota_state, 'reserved');
  await f.runner.runSpeech(f.queue.claimAudio(lease, 'audio-worker')!, signal());
  const receipt = f.runner.publish(lease, 'operation');
  assert.equal(receipt.messageIds.length, 2);
  assert.deepEqual(
    f.store
      .all<{ origin: string }>(
        "SELECT origin FROM web_publication_items WHERE operation_id='operation' ORDER BY ordinal",
      )
      .map((item) => item.origin),
    ['narrative', 'narrative'],
    'published as voice, nothing paid is discarded',
  );
  assert.equal(f.metrics().fallback_used, 0);
  assert.equal(f.metrics().discarded_audio_segments, 0);
  assert.equal(f.calls.fish, 2);
});

test('an operation that has not started audio still expires through the summed queue wait', async (t) => {
  const f = stage(t, { fish: (_call, request) => fishOk(request) });
  await f.readyForAudio();
  f.advance(WEB_LIMITS.queueWaitMs + 1_000);
  const lease = f.queue.acquireCoordinator('coordinator');
  const fence = f.capacity.fence('operation');
  f.capacity.terminate(lease, fence, fence.principalId, 'failed', 'expired');
  assert.equal(f.operation().status, 'failed');
  assert.equal(f.calls.fish, 0);
});

test('the scheduler sweep does not expire a started operation either; the executor finishes it as voice', async (t) => {
  const f = stage(t, { fish: (_call, request) => fishOk(request), deadlineMs: 300_000 });
  await f.readyForAudio();
  await f.runner.runSpeech(f.queue.claimAudio(f.lease, 'audio-worker')!, signal());
  const executor = new WebProviderExecutor(f.store as WebStore, f.clock, f.runner, {
    hold: () => {},
    settled: async () => {},
  });
  t.after(() => executor.close());
  for (let waited = 0; waited < WEB_LIMITS.queueWaitMs + 30_000; waited += 10_000) f.advance(10_000);
  const started = Date.now();
  while (f.operation().status !== 'published' && Date.now() - started < 10_000) {
    executor.managedPass('sweep');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await executor.close();
  assert.equal(f.operation().status, 'published');
  assert.equal(f.calls.fish, 2);
  assert.equal(f.metrics().fallback_used, 0);
  assert.equal(f.metrics().discarded_audio_segments, 0);
  assert.deepEqual(
    f.store
      .all<{ origin: string }>(
        "SELECT origin FROM web_publication_items WHERE operation_id='operation' ORDER BY ordinal",
      )
      .map((item) => item.origin),
    ['narrative', 'narrative'],
  );
});

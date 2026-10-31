import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import test, { type TestContext } from 'node:test';
import { DomainError } from '../../../packages/domain/errors.ts';
import type { FishModel, VoiceModelBinding } from '../../../packages/contracts/audio.ts';
import { Store, type WebStore } from '../../../apps/server/platform/store.ts';
import { WebProviderOffline } from '../../../apps/server/generation/web-provider-offline.ts';
import {
  migrateWebProviderMemory,
  migrateWebProviderMetrics,
  migrateWebProviderOffline,
} from '../../../apps/server/generation/web-provider-migration.ts';
import { syntheticTone } from '../../../apps/server/platform/web-local-fake.ts';
import { acceptedAuditEnvelope, draftWire, textRequest, toolEnvelope } from '../../text-fixtures.ts';
import { protocolFingerprint } from '../../../apps/server/generation/accepted-text-protocol.ts';
import { textPromptHash } from '../../../apps/server/generation/accepted-text-prompt.ts';
import { freezeInputSnapshot } from '../../../apps/server/generation/web-input-snapshot.ts';
import { WebStageQueue } from '../../../apps/server/admission/web-stage-queue.ts';
import { WebDispatchLedger } from '../../../apps/server/budget/web-dispatch-ledger.ts';
import { sceneState } from '../../../apps/server/conversation/scenes.ts';
import { userStore } from '../../../apps/server/platform/store-boundary.ts';
import { DeepSeekTextGenerator } from '../../../apps/server/generation/deepseek.ts';
import { WebProviderRunner, type FakeFish } from '../../../apps/server/generation/web-provider-runner.ts';
import { MemoryBudget } from '../fixtures/memory-budget.ts';

// Part 23b: the per-character voice direction on the Drama 3 wire, read from the operation's frozen template.
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const now = 1_700_000_000_000;

function fixture(t: TestContext, templateConfig = '{}') {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const folder = new URL('../../../apps/server/web-migrations/', import.meta.url);
  for (const file of readdirSync(folder).sort()) {
    if (Number(file.slice(0, 3)) > 112) break;
    store.db.exec(readFileSync(new URL(file, folder), 'utf8'));
  }
  store.db.exec('PRAGMA user_version=112');
  store.run('INSERT INTO web_instance(singleton,instance_id) VALUES (1,?)', 'fixture-instance');
  store.run('INSERT INTO character_templates VALUES (?,?,?)', 'character', 1, templateConfig);
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
  migrateWebProviderMemory(store);
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

function stage(
  t: TestContext,
  options: {
    binding: VoiceModelBinding;
    siteModel?: FishModel;
    /** What the draft model put in `soundCue` of the utterance ("none" when not given). */
    soundCue?: string;
    fish: (call: number, request: Parameters<FakeFish>[0]) => Promise<ReturnType<typeof ok>> | ReturnType<typeof ok>;
    deadlineMs?: number;
    /** The character template the operation is frozen with (config_json of version 1). */
    templateConfig?: string;
  },
) {
  const f = fixture(t, options.templateConfig);
  let clockNow = now;
  const clock = { now: () => clockNow };
  const budget = new MemoryBudget();
  const calls = { fish: 0, text: 0, textAtReady: 0 };
  const generator = new DeepSeekTextGenerator({
    apiKey: 'offline-only',
    fetch: async (_url, init) => {
      calls.text++;
      const tool = JSON.parse(String(init?.body)).tools[0].function.name as string;
      if (tool === 'submit_dialogue_draft') {
        const wire = draftWire(f.request) as { utterance: Record<string, unknown> } & Record<string, unknown>;
        wire.utterance = { ...wire.utterance, ...bubbles[0], soundCue: options.soundCue ?? 'none' };
        wire.afterthoughts = [];
        return Response.json(toolEnvelope('submit_dialogue_draft', wire));
      }
      const envelope = acceptedAuditEnvelope(f.request);
      const call = envelope.choices[0]!.message.tool_calls[0]!.function;
      const audit = JSON.parse(call.arguments);
      audit.replacementBubbles = [];
      audit.coverage.input.supportQuote = bubbles[0]!.text;
      call.arguments = JSON.stringify(audit);
      return Response.json(envelope);
    },
  });
  const fish: FakeFish = async (request) => options.fish(++calls.fish, request);
  const runner = new WebProviderRunner(
    f.store,
    clock,
    generator,
    fish,
    budget,
    undefined,
    options.siteModel === undefined ? undefined : { voiceModel: options.siteModel },
  );
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
  for (const model of ['s2.1-pro', 'drama-3'] as const)
    ledger.configurePrice({
      id: `fish-speech-${model}`,
      provider: 'fish',
      model,
      phase: 'speech',
      currency: 'USD',
      unit: 'byte',
      upperMicrosPerUnit: 15,
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
    model: options.binding,
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

const bubbles = [{ text: '第一段合成语音。', expression: 'soft' as const }];
const signal = () => new AbortController().signal;
const ok = () => ({ audio: syntheticTone(), receipt: { id: 'fake-fish' }, usageUnits: 0 });
const DIRECTION = '像平时聊天，不朗诵、不表演。并列短句连贯稍快。';
const withVoice = (direction?: string) =>
  JSON.stringify({
    voice: { profileId: 'synthetic-profile', version: 1, speed: 1, ...(direction ? { direction } : {}) },
  });

async function speakOnce(
  t: TestContext,
  options: { binding: VoiceModelBinding; siteModel?: FishModel; direction?: string; fish?: FakeFish },
) {
  const seen: Parameters<FakeFish>[0][] = [];
  const f = stage(t, {
    binding: options.binding,
    ...(options.siteModel ? { siteModel: options.siteModel } : {}),
    templateConfig: options.direction === undefined ? '{}' : withVoice(options.direction),
    fish: (_call, request) => {
      seen.push(request);
      return { ...ok(), usageUnits: request.billedTextBytes };
    },
  });
  await f.readyForAudio();
  const claim = f.queue.claimAudio(f.lease, 'audio-worker')!;
  await f.runner.runSpeech(claim, signal());
  assert.equal(seen.length, 1);
  const attempt = f.row<{ model: string; held_micros: number }>(
    "SELECT model,held_micros FROM web_provider_attempts WHERE operation_id='operation' AND phase='speech'",
  );
  return { wire: seen[0]!, attempt, f };
}

test('drama-3 with a direction: the direction bracket comes first, then the existing brackets, then the words', async (t) => {
  const withDir = await speakOnce(t, { binding: 'drama-3', direction: DIRECTION });
  assert.equal(
    JSON.parse(withDir.wire.body).text,
    `[${DIRECTION}] [soft and gentle, unhurried, tender] 第一段合成语音。`,
  );
  const without = await speakOnce(t, { binding: 'drama-3' });
  assert.equal(JSON.parse(without.wire.body).text, '[soft and gentle, unhurried, tender] 第一段合成语音。');
  assert.notEqual(withDir.wire.wireRequestHash, without.wire.wireRequestHash, 'the direction is part of the hash');
  // The reservation counts the direction: billed bytes are the UTF-8 length of the whole text, 50 micros/byte is not used here.
  const sent = JSON.parse(withDir.wire.body).text as string;
  assert.equal(withDir.wire.billedTextBytes, Buffer.byteLength(sent, 'utf8'));
  assert.ok(withDir.wire.billedTextBytes > without.wire.billedTextBytes);
  assert.equal(withDir.attempt.held_micros, withDir.wire.billedTextBytes * 15);
  const stored = withDir.f.row<{ wire_request_hash: string }>(
    "SELECT wire_request_hash FROM web_provider_attempts WHERE operation_id='operation' AND phase='speech'",
  );
  assert.equal(stored.wire_request_hash, withDir.wire.wireRequestHash, 'the stored hash is the hash of the bytes sent');
});

test('drama-3 without a direction (no voice in the template, or a voice without one): byte-identical to main', async (t) => {
  const none = await speakOnce(t, { binding: 'drama-3' });
  const voiceOnly = await speakOnce(t, { binding: 'drama-3', direction: '' });
  assert.equal(JSON.parse(none.wire.body).text, '[soft and gentle, unhurried, tender] 第一段合成语音。');
  assert.equal(voiceOnly.wire.body, none.wire.body);
  assert.equal(voiceOnly.wire.wireRequestHash, none.wire.wireRequestHash);
});

test('pin:s2.1-pro and an unpinned s2.1-pro binding ignore the direction: byte-identical to main', async (t) => {
  for (const binding of ['pin:s2.1-pro', 's2.1-pro'] as const) {
    const withDir = await speakOnce(t, { binding, siteModel: 's2.1-pro', direction: DIRECTION });
    const without = await speakOnce(t, { binding, siteModel: 's2.1-pro' });
    assert.equal(JSON.parse(withDir.wire.body).text, '[soft tone]第一段合成语音。');
    assert.equal(withDir.wire.body, without.wire.body);
    assert.equal(withDir.wire.wireRequestHash, without.wire.wireRequestHash);
    assert.equal(withDir.wire.billedTextBytes, without.wire.billedTextBytes);
  }
  const pinned = await speakOnce(t, { binding: 'pin:s2.1-pro', siteModel: 'drama-3', direction: DIRECTION });
  assert.equal(JSON.parse(pinned.wire.body).text, '[soft tone]第一段合成语音。');
});

test('frozen version: the direction is the one in the operation snapshot, whatever is live at dispatch', async (t) => {
  const f = stage(t, { binding: 'drama-3', templateConfig: withVoice(DIRECTION), fish: () => ok() });
  await f.readyForAudio();
  const request = f.row<Record<string, string>>("SELECT * FROM web_v7_requests WHERE operation_id='operation'");
  const frozen = () =>
    (f.runner as unknown as { frozenDirection(row: Record<string, string>): string | undefined }).frozenDirection(
      request,
    );
  assert.equal(frozen(), DIRECTION);
  // v2 goes live with another direction (the same voice, so the binding row and its clips are unchanged).
  f.store.run(
    "UPDATE character_templates SET version=2,config_json=? WHERE id='character'",
    withVoice('语速很慢，句尾拖长。'),
  );
  assert.equal(frozen(), DIRECTION, 'v1 is still what the snapshot carries');
  f.store.run("UPDATE character_templates SET version=3,config_json='{}' WHERE id='character'");
  assert.equal(frozen(), DIRECTION, 'a later v3 without a direction changes nothing either');
});

test('frozen version: an operation frozen on v1 whose character moved to v2 is refused before any provider call', async (t) => {
  const seen: unknown[] = [];
  const f = stage(t, {
    binding: 'drama-3',
    templateConfig: withVoice(DIRECTION),
    fish: (_call, request) => {
      seen.push(request);
      return ok();
    },
  });
  await f.readyForAudio();
  const claim = f.queue.claimAudio(f.lease, 'audio-worker')!;
  f.store.run(
    "UPDATE character_templates SET version=2,config_json=? WHERE id='character'",
    withVoice('语速很慢，句尾拖长。'),
  );
  await assert.rejects(f.runner.runSpeech(claim, signal()), { code: 'WEB_INPUT_SNAPSHOT_STALE' });
  assert.equal(seen.length, 0, 'v2 text is never sent for a v1 operation');
  assert.equal(f.calls.fish, 0);
});

test('replay and recovery send the very same bytes; an UNKNOWN attempt is never resent and keeps its hold', async (t) => {
  const bodies: string[] = [];
  const f = stage(t, {
    binding: 'drama-3',
    templateConfig: withVoice(DIRECTION),
    fish: (call, request) => {
      bodies.push(request.body);
      if (call === 1) throw new DomainError('FISH_RATE_LIMITED');
      throw new Error('UNKNOWN_NETWORK');
    },
  });
  await f.readyForAudio();
  await f.runner.runSpeech(f.queue.claimAudio(f.lease, 'audio-worker')!, signal());
  assert.equal(f.attempt('speech', 0).state, 'not_sent', 'a 429 is known not executed and backs off');
  const held = f.attempt('speech', 0).held_micros;
  f.advance(2_000);
  const second = f.queue.claimAudio(f.lease, 'audio-worker')!;
  await assert.rejects(f.runner.runSpeech(second, signal()), /UNKNOWN_NETWORK/);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1], bodies[0], 'the retry after the backoff is byte-identical');
  assert.equal(JSON.parse(bodies[0]!).text, `[${DIRECTION}] [soft and gentle, unhurried, tender] 第一段合成语音。`);
  assert.equal(f.attempt('speech', 0).state, 'unknown');
  assert.equal(f.attempt('speech', 0).held_micros, held, 'the reservation of an UNKNOWN call is never released');
  await assert.rejects(f.runner.runSpeech(second, signal()), /WEB_PROVIDER_RECOVERY_UNKNOWN/);
  assert.equal(f.attempt('speech', 0).held_micros, held);
  assert.equal(f.calls.fish, 2, 'no third call');
});

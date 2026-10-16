import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import test, { type TestContext } from 'node:test';
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

// Which model a speech call is sent, reserved and priced under: site default (FISH_VOICE_MODEL) x voice binding.
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

async function speakOnce(
  t: TestContext,
  options: { binding: VoiceModelBinding; siteModel?: FishModel; soundCue?: string },
) {
  const seen: Parameters<FakeFish>[0][] = [];
  const f = stage(t, {
    binding: options.binding,
    ...(options.siteModel ? { siteModel: options.siteModel } : {}),
    ...(options.soundCue ? { soundCue: options.soundCue } : {}),
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
  return { wire: seen[0]!, attempt };
}

test('flag unset: an unpinned (existing) binding is sent as s2.1-pro with the s2.1 cue table, as before', async (t) => {
  const { wire, attempt } = await speakOnce(t, { binding: 's2.1-pro' });
  assert.equal(wire.model, 's2.1-pro');
  assert.equal(wire.speech.model, 's2.1-pro');
  assert.match(wire.speech.expression, /^soft$/);
  assert.equal(JSON.parse(wire.body).text.startsWith('[soft tone]'), true);
  assert.equal(attempt.model, 's2.1-pro');
});

test('site model drama-3: unpinned bindings are sent as drama-3 with Drama 3 directions, priced at 15 micros/byte', async (t) => {
  const { wire, attempt } = await speakOnce(t, { binding: 's2.1-pro', siteModel: 'drama-3' });
  assert.equal(wire.model, 'drama-3');
  assert.equal(JSON.parse(wire.body).text.startsWith('[soft and gentle, unhurried, tender] '), true);
  assert.equal(attempt.model, 'drama-3');
  assert.equal(attempt.held_micros, wire.billedTextBytes * 15, 'reserved at the s2.1 upper bound');
});

test('per-character fallback: pin:s2.1-pro stays on s2.1-pro while the site default is drama-3', async (t) => {
  const { wire, attempt } = await speakOnce(t, { binding: 'pin:s2.1-pro', siteModel: 'drama-3' });
  assert.equal(wire.model, 's2.1-pro');
  assert.equal(JSON.parse(wire.body).text.startsWith('[soft tone]'), true);
  assert.equal(attempt.model, 's2.1-pro');
});

test('an explicit drama-3 binding uses drama-3 even when the site default is s2.1-pro', async (t) => {
  const { wire } = await speakOnce(t, { binding: 'drama-3', siteModel: 's2.1-pro' });
  assert.equal(wire.model, 'drama-3');
});

test('a soundCue chosen in the draft reaches the stored candidate and is rendered for drama-3 and ignored for s2.1-pro', async (t) => {
  const drama = await speakOnce(t, { binding: 's2.1-pro', siteModel: 'drama-3', soundCue: 'small_laugh' });
  assert.equal(JSON.parse(drama.wire.body).text, '[soft and gentle, unhurried, tender] [small laugh] 第一段合成语音。');
  const s21 = await speakOnce(t, { binding: 's2.1-pro', soundCue: 'small_laugh' });
  assert.equal(JSON.parse(s21.wire.body).text, '[soft tone]第一段合成语音。');
});

test('an unlisted soundCue is rejected with the draft: no candidate exists and nothing is sent to Fish', async (t) => {
  const f = stage(t, {
    binding: 's2.1-pro',
    siteModel: 'drama-3',
    soundCue: '[evil tag]',
    fish: () => {
      throw new Error('Fish must not be called');
    },
  });
  await assert.rejects(f.readyForAudio(), { code: 'INVALID_BUBBLES' });
  assert.equal(f.calls.fish, 0);
  assert.equal(f.row<{ n: number }>('SELECT count(*) n FROM web_provider_candidates').n, 0);
});

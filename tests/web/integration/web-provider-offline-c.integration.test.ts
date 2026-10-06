import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import test, { type TestContext } from 'node:test';
import { Store } from '../../../apps/server/platform/store.ts';
import { WebProviderOffline } from '../../../apps/server/generation/web-provider-offline.ts';
import { migrateWebProviderOffline } from '../../../apps/server/generation/web-provider-migration.ts';
import { syntheticTone } from '../../../apps/server/platform/web-local-fake.ts';
import { protocolFingerprint } from '../../../apps/server/generation/accepted-text-protocol.ts';
import { textPromptHash } from '../../../apps/server/generation/accepted-text-prompt.ts';
import { textRequest, draftWire, draftPresentation } from '../../text-fixtures.ts';
import { freezeInputSnapshot } from '../../../apps/server/generation/web-input-snapshot.ts';
import type { WebStore } from '../../../apps/server/platform/store.ts';
import { WebStageQueue } from '../../../apps/server/admission/web-stage-queue.ts';
import { WebDispatchLedger } from '../../../apps/server/budget/web-dispatch-ledger.ts';
import { WebProviderRunner, fishTransport } from '../../../apps/server/generation/web-provider-runner.ts';
import { DeepSeekTextGenerator } from '../../../apps/server/generation/deepseek.ts';
import { FishAudio, fishSpeechRequest } from '../../../workers/audio/fish.ts';
import { SpeechFailure } from '../../../workers/audio/validation-error.ts';
import { sceneState } from '../../../apps/server/conversation/scenes.ts';
import { userStore } from '../../../apps/server/platform/store-boundary.ts';
import { WebVerticalPublisher } from '../../../apps/server/conversation/web-vertical-publisher.ts';
import { WebCloudBudgetClient } from '../../../apps/server/cloudflare/web-budget-client.ts';
import type { WebAttemptBudget } from '../../../apps/server/budget/web-provider-budget-contract.ts';
import type { CloudBudgetEntry } from '../../../apps/server/cloudflare/web-budget.ts';

const now = 1_800_000_000_000;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

function setup(t: TestContext) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const folder = new URL('../../../apps/server/web-migrations/', import.meta.url);
  for (const file of readdirSync(folder).sort()) {
    if (Number(file.slice(0, 3)) > 112) break;
    store.db.exec(readFileSync(new URL(file, folder), 'utf8'));
  }
  store.db.exec('PRAGMA user_version=112');
  store.run('INSERT INTO web_instance(singleton,instance_id) VALUES (1,?)', 'c-provider-instance');
  store.run('INSERT INTO character_templates VALUES (?,?,?)', 'c-character', 1, '{}');
  store.run('INSERT INTO api_players VALUES (?,?)', 'c-player', now);
  store.run('INSERT INTO worlds VALUES (?,?,?,?)', 'c-world', 'c-player', 'UTC', '{}');
  store.run("INSERT INTO world_characters VALUES ('c-world','c-character','new')");
  store.run(`INSERT INTO conversations(world_id,id,kind,private_character_id)
    VALUES ('c-world','c-conversation','private','c-character')`);
  store.run("INSERT INTO participants VALUES ('c-world','c-conversation','c-character')");
  store.run(
    `INSERT INTO messages(id,world_id,conversation_id,author_kind,author_id,body,created_at,delivery,proactive)
    VALUES ('c-input','c-world','c-conversation','player','c-player','C 合成输入',?,'text',0)`,
    now,
  );
  store.run(`INSERT INTO web_principals(id,player_id,world_id,kind)
    VALUES ('c-principal','c-player','c-world','guest')`);
  store.run(
    `INSERT INTO web_guest_retention(principal_id,world_id,started_at,expires_at,state)
    VALUES ('c-principal','c-world',?,?,'active')`,
    now - 1,
    now + 300_000,
  );
  store.run(
    `INSERT INTO web_ip_windows(id,ip_hash,starts_at,expires_at)
    VALUES ('c-window','c-ip',?,?)`,
    now - 1,
    now + 300_000,
  );
  store.run(
    `INSERT INTO web_operations(id,principal_id,request_id,payload_hash,world_id,conversation_id,
    character_id,input_message_id,ip_window_id,status,quota_state,created_at,deadline_at)
    VALUES ('c-operation','c-principal','c-request','c-payload','c-world','c-conversation',
      'c-character','c-input','c-window','queued','reserved',?,?)`,
    now,
    now + 300_000,
  );
  freezeInputSnapshot(store as WebStore, 'c-operation', now);
  const request = textRequest();
  request.jobId = 'c-operation';
  request.scope = { worldId: 'c-world', conversationId: 'c-conversation', characterId: 'c-character' };
  request.character.id = 'c-character';
  request.requiredMessageIds = ['c-input'];
  request.messages = [
    {
      ...request.messages[0]!,
      id: 'c-input',
      worldId: 'c-world',
      conversationId: 'c-conversation',
      authorId: 'c-player',
    },
  ];
  request.deliveryMode = 'voice';
  request.sceneContext = sceneState(
    userStore(store),
    { playerId: 'c-player', worldId: 'c-world', conversationId: 'c-conversation', characterId: 'c-character' },
    now,
  );
  const requestJson = JSON.stringify(request),
    requestDigest = sha(requestJson);
  const voiceVersion = 'c-voice:v1';
  store.run(
    `INSERT INTO web_v7_requests VALUES ('c-operation','c-principal','c-player','c-world',
    'c-conversation','c-character','c-input',?,?,?,?,0,'context',0,0,?,?)`,
    requestJson,
    requestDigest,
    sha(JSON.stringify(protocolFingerprint())),
    textPromptHash(),
    voiceVersion,
    now,
  );
  migrateWebProviderOffline(store);
  const ledger = new WebProviderOffline(store, { now: () => now });
  const scope = {
    principalId: 'c-principal',
    playerId: 'c-player',
    worldId: 'c-world',
    conversationId: 'c-conversation',
    characterId: 'c-character',
    inputMessageId: 'c-input',
  };
  for (const [phase, provider] of [
    ['draft', 'c-text'],
    ['review', 'c-text'],
    ['speech', 'c-audio'],
  ] as const) {
    if (phase !== 'review') ledger.configureBudget(provider, 3_000_000);
    ledger.configurePrice({
      id: `c-${phase}`,
      provider,
      model: 'c-model',
      phase,
      currency: 'USD',
      unit: phase === 'speech' ? 'byte' : 'token',
      upperMicrosPerUnit: 1000,
      validFrom: now - 1,
      validUntil: now + 100_000,
      version: 1,
    });
  }
  const input = (phase: 'draft' | 'review' | 'speech', ordinal = -1) => ({
    operationId: 'c-operation',
    phase,
    ordinal,
    ...scope,
    requestDigest,
    policyHash: sha('c-policy'),
    wireRequestHash: sha(`c-wire-${phase}`),
    voiceVersion,
    provider: phase === 'speech' ? 'c-audio' : 'c-text',
    model: 'c-model',
    maxUnits: 100,
  });
  const known = (phase: 'draft' | 'review' | 'speech', output: unknown, ordinal = -1, spokenText?: string) => {
    const key = input(phase, ordinal);
    ledger.reserve(key);
    ledger.markSent(key, scope);
    ledger.confirm(key, scope, {
      outcome: 'succeeded',
      receipt: { phase, ordinal },
      usageUnits: 1,
      output,
      ...(spokenText ? { spokenText } : {}),
    });
    return key;
  };
  const acceptedReview = () => {
    const spokenText = draftPresentation(request).bubbles[0]!.text;
    return {
      spokenText,
      output: {
        decision: 'accept',
        replacementBubbles: [],
        topics: [],
        coverage: { 'c-input': { status: 'answered', supportQuote: spokenText, missingInformation: '' } },
        sceneUpdate: null,
      },
    };
  };
  return { store, ledger, scope, input, known, request, voiceVersion, acceptedReview };
}

function audioFixture(t: TestContext) {
  const f = setup(t),
    clock = { now: () => clockNow };
  let clockNow = now,
    leaseId = 0;
  const candidate = {
    ...draftPresentation(f.request),
    bubbles: [
      { text: 'C 首段你好🙂。', expression: 'soft' as const },
      { text: 'C 次段未知。', expression: 'neutral' as const },
    ],
    sceneUpdate: null,
  };
  const candidateJson = JSON.stringify(candidate);
  const requestDigest = f.store.get<{ request_digest: string }>(
    "SELECT request_digest FROM web_v7_requests WHERE operation_id='c-operation'",
  )!.request_digest;
  f.store.run(
    `INSERT INTO web_provider_candidates VALUES ('c-operation',?,?,?,?,?,?,?)`,
    requestDigest,
    candidateJson,
    sha(candidateJson),
    f.voiceVersion,
    sha('draft'),
    sha('review'),
    now,
  );
  for (const [ordinal, bubble] of candidate.bubbles.entries())
    f.store.run(
      `INSERT INTO web_provider_voice_segments(operation_id,ordinal,text_digest,voice_version,state)
      VALUES ('c-operation',?,?,?,'pending')`,
      ordinal,
      sha(bubble.text),
      f.voiceVersion,
    );
  f.store.run(
    `UPDATE web_operations SET status='text_ready',
    stage_version=(SELECT max(revision) FROM web_local_events WHERE operation_id='c-operation'),
    audio_queued_at=?,audio_wait_started_at=?,
    audio_wait_used_ms=0 WHERE id='c-operation'`,
    now,
    now,
  );
  f.store.run(
    `UPDATE web_scheduler_state SET epoch=1,coordinator_token='c-coordinator',
    coordinator_expires_at=? WHERE singleton=1`,
    now + 300_000,
  );
  f.ledger.configureBudget('fish', 3_000_000);
  f.ledger.configurePrice({
    id: 'c-fish-speech',
    provider: 'fish',
    model: 's2.1-pro',
    phase: 'speech',
    currency: 'USD',
    unit: 'byte',
    upperMicrosPerUnit: 1,
    validFrom: now - 1,
    validUntil: now + 300_000,
    version: 1,
  });
  f.ledger.configureVoice({
    characterId: 'c-character',
    voiceVersion: f.voiceVersion,
    voiceRevision: 1,
    profileId: 'c-profile',
    referenceId: 'c-reference',
    model: 's2.1-pro',
    approved: true,
  });
  const recovery = new WebDispatchLedger(f.store as WebStore, clock);
  recovery.configureBudget({ provider: 'fish', stage: 'audio', phase: 'speech', capacity: 1 });
  const coordinator = { epoch: 1, token: 'c-coordinator', owner: 'c-coordinator', expiresAt: now + 300_000 };
  const queue = new WebStageQueue(f.store as WebStore, clock, () => `c-audio-${++leaseId}`);
  const makeRunner = (fish: ConstructorParameters<typeof WebProviderRunner>[3], budget?: WebAttemptBudget) =>
    new WebProviderRunner(
      f.store,
      clock,
      new DeepSeekTextGenerator({
        apiKey: 'offline-only',
        fetch: async () => {
          throw new Error('C_TEXT_NOT_CALLED');
        },
      }),
      fish,
      budget,
    );
  return {
    ...f,
    clock,
    candidate,
    coordinator,
    queue,
    recovery,
    makeRunner,
    advance: (value: number) => {
      clockNow = value;
    },
  };
}

test('C A-PROVIDER-001: identical audio wire hash still reserves distinct ordinals and outputs', (t) => {
  const f = setup(t),
    first = f.input('speech', 0),
    second = f.input('speech', 1);
  assert.equal(first.wireRequestHash, second.wireRequestHash);
  assert.equal(f.ledger.reserve(first).duplicate, false);
  assert.equal(f.ledger.reserve(second).duplicate, false);
  assert.equal(
    f.store.get<{ n: number }>(`SELECT count(*) n FROM web_provider_attempts
    WHERE phase='speech'`)?.n,
    2,
  );
  f.ledger.markSent(first, f.scope);
  f.ledger.confirm(first, f.scope, {
    outcome: 'succeeded',
    receipt: { ordinal: 0 },
    usageUnits: 1,
    output: syntheticTone(),
    spokenText: 'C 首段',
  });
  assert.throws(() => f.ledger.readKnown(second, f.scope), /WEB_PROVIDER_OUTPUT_UNAVAILABLE/);
  f.ledger.markSent(second, f.scope);
  f.ledger.confirm(second, f.scope, {
    outcome: 'succeeded',
    receipt: { ordinal: 1 },
    usageUnits: 1,
    output: syntheticTone(),
    spokenText: 'C 次段',
  });
  assert.ok(f.ledger.readKnown(first, f.scope) instanceof Buffer);
  assert.ok(f.ledger.readKnown(second, f.scope) instanceof Buffer);
  assert.equal(
    f.store.get<{ n: number }>(`SELECT count(*) n FROM web_provider_outputs
    WHERE phase='speech'`)?.n,
    2,
  );
});

test('C A-PROVIDER-002: opaque draft and review cannot pass even with known audio', (t) => {
  const f = setup(t),
    { output, spokenText } = f.acceptedReview();
  f.known('draft', { opaque: 'not-a-draft' });
  f.known('review', output);
  f.known('speech', syntheticTone(), 0, spokenText);
  assert.throws(
    () => f.ledger.validatePublication('c-operation', f.scope, [0], f.voiceVersion),
    /INVALID_DRAFT_SCHEMA/,
  );
});

test('C A-PROVIDER-002: malformed review and mismatched spokenText reject publication', (t) => {
  const f = setup(t);
  f.known('draft', draftWire(f.request));
  f.known('review', { opaque: 'not-a-review' });
  f.known('speech', syntheticTone(), 0, 'C 随意发音');
  assert.throws(
    () => f.ledger.validatePublication('c-operation', f.scope, [0], f.voiceVersion),
    /INVALID_REVIEW_SCHEMA/,
  );
});

test('C A-PROVIDER-002: accepted review still requires exact spokenText per ordinal', (t) => {
  const f = setup(t),
    review = f.acceptedReview();
  f.known('draft', draftWire(f.request));
  f.known('review', review.output);
  f.known('speech', syntheticTone(), 0, `${review.spokenText}不一致`);
  assert.throws(
    () => f.ledger.validatePublication('c-operation', f.scope, [0], f.voiceVersion),
    /WEB_PROVIDER_PUBLICATION_INVALID/,
  );
});

test('C S3-003: scene drift blocks before reserve/send; actual Fish wire bills cue UTF-8 bytes', async (t) => {
  const f = audioFixture(t),
    signal = new AbortController().signal;
  let fishCalls = 0;
  const runner = f.makeRunner(async (wire) => {
    fishCalls++;
    const expected = fishSpeechRequest(
      {
        jobId: 'c-operation-0',
        text: f.candidate.bubbles[0]!.text,
        expression: 'soft',
        speed: 1,
        voice: { profileId: 'c-profile', referenceId: 'c-reference', version: 1 },
        model: 's2.1-pro',
        deliveryStyle: 'conversational',
      },
      's2.1-pro',
    );
    const { speech, ...sent } = wire;
    assert.deepEqual(sent, {
      body: expected.body,
      wireRequestHash: expected.requestHash,
      model: 's2.1-pro',
      billedTextBytes: expected.bytes,
    });
    // The live adapter re-prepares from `speech`; it must serialize to the exact same wire.
    assert.equal(fishSpeechRequest(speech, 's2.1-pro').body, expected.body);
    assert.equal(expected.bytes, Buffer.byteLength(`[soft tone]${f.candidate.bubbles[0]!.text}`, 'utf8'));
    assert.ok(expected.bytes > Buffer.byteLength(f.candidate.bubbles[0]!.text, 'utf8'));
    return { audio: syntheticTone(), receipt: { synthetic: true }, usageUnits: expected.bytes };
  });
  const claim = f.queue.claimAudio(f.coordinator, 'c-worker')!;
  assert.equal(claim.ordinal, 0);
  f.store.run(
    `INSERT INTO scene_states(world_id,conversation_id,character_id,revision,
    scene_json,updated_at,expires_at) VALUES ('c-world','c-conversation','c-character',1,?,?,NULL)`,
    JSON.stringify({ kind: 'remote', setting: null, plan: null, proximity: 'ordinary', speaking: 'normal' }),
    now,
  );
  await assert.rejects(runner.runSpeech(claim, signal), /SCENE_CONTEXT_CHANGED/);
  assert.equal(fishCalls, 0);
  for (const table of ['web_provider_attempts', 'web_external_attempts'])
    assert.equal(f.store.get<{ n: number }>(`SELECT count(*) n FROM ${table} WHERE operation_id='c-operation'`)?.n, 0);
  assert.equal(
    f.store.get<{ held_micros: number }>("SELECT held_micros FROM web_provider_spending WHERE provider='fish'")
      ?.held_micros,
    0,
  );
  f.store.run("DELETE FROM scene_states WHERE world_id='c-world' AND conversation_id='c-conversation'");
  await runner.runSpeech(claim, signal);
  assert.equal(fishCalls, 1);
  assert.equal(
    f.store.get<{ usage_units: number }>(`SELECT usage_units FROM web_provider_attempts
    WHERE operation_id='c-operation' AND phase='speech' AND ordinal=0`)?.usage_units,
    Buffer.byteLength(`[soft tone]${f.candidate.bubbles[0]!.text}`, 'utf8'),
  );
});

test('C S3-003: expired audio lease reclaims known bytes without resend; UNKNOWN never resends', async (t) => {
  const f = audioFixture(t),
    signal = new AbortController().signal;
  let calls = 0;
  const runner = f.makeRunner(async (request) => {
    calls++;
    if (calls === 1) {
      f.advance(now + 11);
      return { audio: syntheticTone(), receipt: { synthetic: true }, usageUnits: request.billedTextBytes };
    }
    throw new Error('C_UNKNOWN_RECEIPT');
  });
  const first = f.queue.claimAudio(f.coordinator, 'c-worker')!;
  f.store.run("UPDATE web_operations SET lease_expires_at=? WHERE id='c-operation'", now + 10);
  await assert.rejects(runner.runSpeech(first, signal), /WEB_PROVIDER_CLAIM_STALE/);
  assert.equal(
    f.store.get<{ state: string }>(`SELECT state FROM web_provider_attempts
    WHERE operation_id='c-operation' AND phase='speech' AND ordinal=0`)?.state,
    'known',
  );
  assert.deepEqual(f.recovery.recover(f.coordinator, f.recovery.fence('c-operation')), { status: 'audio_pending' });
  const reclaimed = f.queue.claimAudio(f.coordinator, 'c-recover')!;
  assert.equal(reclaimed.ordinal, 0);
  await runner.runSpeech(reclaimed, signal);
  assert.equal(calls, 1);
  assert.equal(
    f.store.get<{ state: string }>(`SELECT state FROM web_provider_voice_segments
    WHERE operation_id='c-operation' AND ordinal=0`)?.state,
    'complete',
  );
  const second = f.queue.claimAudio(f.coordinator, 'c-worker')!;
  assert.equal(second.ordinal, 1);
  await assert.rejects(runner.runSpeech(second, signal), /C_UNKNOWN_RECEIPT/);
  assert.equal(
    f.store.get<{ state: string }>(`SELECT state FROM web_provider_attempts
    WHERE operation_id='c-operation' AND phase='speech' AND ordinal=1`)?.state,
    'unknown',
  );
  await assert.rejects(runner.runSpeech(second, signal), /WEB_PROVIDER_RECOVERY_UNKNOWN/);
  assert.equal(calls, 2);
});

test('C S3-003: revoked invite rejects private audio lookup and fresh provider reservation', (t) => {
  const f = audioFixture(t);
  f.store.run('INSERT INTO admin_sessions VALUES (?,?,?,?,NULL)', 'c-admin', 'c-admin-hash', now, now + 300_000);
  f.store.run(
    `INSERT INTO web_invite_codes(id,code_digest,issue_request_id,issue_digest,
    redeem_by,access_duration_ms,status,batch,created_by,created_at)
    VALUES ('c-code','c-code-hash','c-issue','c-issue-hash',?,300000,'active','c-batch','c-admin',?)`,
    now + 300_000,
    now,
  );
  f.store.run(
    `INSERT INTO web_invite_grants(id,invite_id,principal_id,player_id,world_id,redeemed_at,expires_at)
    VALUES ('c-grant','c-code','c-principal','c-player','c-world',?,?)`,
    now - 1,
    now + 300_000,
  );
  f.store.run("UPDATE web_principals SET kind='invite',revision=revision+1 WHERE id='c-principal'");
  f.store.run("UPDATE web_guest_retention SET state='protected' WHERE principal_id='c-principal'");
  const publisher = new WebVerticalPublisher(f.store as WebStore, f.clock);
  const mediaScope = {
    principalId: f.scope.principalId,
    playerId: f.scope.playerId,
    worldId: f.scope.worldId,
    conversationId: f.scope.conversationId,
    characterId: f.scope.characterId,
  };
  assert.throws(() => publisher.readPublishedAudio(mediaScope, 'absent-media'), /WEB_PUBLISHED_AUDIO_NOT_FOUND/);
  f.store.run("UPDATE web_invite_grants SET revoked_at=? WHERE id='c-grant'", now);
  assert.throws(() => publisher.readPublishedAudio(mediaScope, 'absent-media'), /WEB_INVITE_ACCESS_REQUIRED/);
  assert.throws(() => f.ledger.reserve(f.input('speech', 0)), /WEB_INVITE_ACCESS_REQUIRED/);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_provider_attempts')?.n, 0);
});

test('remote budget await cannot bypass audio lease, input, scene, entitlement or abort fences', async (t) => {
  for (const changed of ['lease', 'input', 'scene', 'entitlement', 'abort'] as const)
    await t.test(changed, async (t) => {
      const f = audioFixture(t),
        controller = new AbortController();
      let enter!: () => void, proceed!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const continueReservation = new Promise<void>((resolve) => {
        proceed = resolve;
      });
      let calls = 0,
        holds = 0;
      const budget = new WebCloudBudgetClient({
        read: async () => undefined,
        settle: async () => {},
        reserve: async () => {
          holds++;
          enter();
          await continueReservation;
        },
      });
      const runner = f.makeRunner(async (wire) => {
        calls++;
        return { audio: syntheticTone(), receipt: {}, usageUnits: wire.billedTextBytes };
      }, budget);
      const claim = f.queue.claimAudio(f.coordinator, 'async-worker')!;
      const running = runner.runSpeech(claim, controller.signal);
      await entered;
      assert.equal(calls, 0);
      if (changed === 'lease') f.store.run("UPDATE web_operations SET lease_expires_at=? WHERE id='c-operation'", now);
      if (changed === 'input') f.store.run("UPDATE messages SET body='changed' WHERE id='c-input'");
      if (changed === 'scene')
        f.store.run(
          `INSERT INTO scene_states(world_id,conversation_id,character_id,revision,
      scene_json,updated_at,expires_at) VALUES ('c-world','c-conversation','c-character',1,?,?,NULL)`,
          JSON.stringify({ kind: 'remote', setting: null, plan: null, proximity: 'ordinary', speaking: 'normal' }),
          now,
        );
      if (changed === 'entitlement')
        f.store.run("UPDATE web_guest_retention SET expires_at=? WHERE principal_id='c-principal'", now);
      if (changed === 'abort') controller.abort();
      proceed();
      await assert.rejects(
        running,
        /WEB_PROVIDER_CLAIM_STALE|WEB_INPUT_SNAPSHOT_STALE|SCENE_CONTEXT_CHANGED|TRIAL_EXPIRED|WEB_PROVIDER_ABORTED/,
      );
      assert.equal(calls, 0);
      assert.equal(holds, 1);
      assert.equal(
        f.store.get<{ state: string }>("SELECT state FROM web_provider_attempts WHERE phase='speech'")?.state,
        'not_sent',
      );
    });
});

test('known local result plus failed remote settlement recovers the bill without resending speech', async (t) => {
  const f = audioFixture(t);
  let entry: CloudBudgetEntry | undefined,
    settlements = 0,
    calls = 0;
  const budget = new WebCloudBudgetClient({
    read: async () => entry,
    reserve: async (_id, provider, fingerprint, held_micros) => {
      entry = { provider, fingerprint, held_micros, charged_micros: null, receipt_hash: null };
    },
    settle: async (_id, _fingerprint, charge) => {
      settlements++;
      if (settlements === 1) throw new Error('OFFLINE_RPC_RESPONSE_LOST');
      entry!.charged_micros = charge;
    },
  });
  const fish = async (wire: Parameters<ConstructorParameters<typeof WebProviderRunner>[3]>[0]) => {
    calls++;
    return { audio: syntheticTone(), receipt: { offline: true }, usageUnits: wire.billedTextBytes };
  };
  let runner = f.makeRunner(fish, budget);
  const claim = f.queue.claimAudio(f.coordinator, 'async-worker')!;
  f.store.run("UPDATE web_operations SET lease_expires_at=? WHERE id='c-operation'", now + 10);
  await assert.rejects(runner.runSpeech(claim, new AbortController().signal), /OFFLINE_RPC_RESPONSE_LOST/);
  assert.equal(
    f.store.get<{ state: string }>("SELECT state FROM web_provider_attempts WHERE phase='speech'")?.state,
    'known',
  );
  assert.equal(entry!.charged_micros, null);
  assert.equal(calls, 1);
  runner = f.makeRunner(fish, budget);
  assert.throws(() => runner.publish(f.coordinator, 'c-operation'), /WEB_SHARED_RECOVERY_PENDING/);
  await runner.whenReady();
  assert.ok(entry!.charged_micros! > 0);
  assert.equal(settlements, 2);
  f.advance(now + 11);
  assert.deepEqual(f.recovery.recover(f.coordinator, f.recovery.fence('c-operation')), { status: 'audio_pending' });
  await runner.runSpeech(f.queue.claimAudio(f.coordinator, 'async-recovery')!, new AbortController().signal);
  assert.equal(calls, 1);
});

test('remote speech send gate rechecks the original claim after opening the private session', async (t) => {
  for (const changed of ['lease', 'input', 'scene', 'entitlement', 'abort'] as const)
    await t.test(changed, async (t) => {
      const f = audioFixture(t),
        controller = new AbortController();
      let calls = 0;
      const runner = f.makeRunner(async (wire, _signal, authorize) => {
        await Promise.resolve();
        if (changed === 'lease')
          f.store.run("UPDATE web_operations SET lease_expires_at=? WHERE id='c-operation'", now);
        if (changed === 'input') f.store.run("UPDATE messages SET body='changed' WHERE id='c-input'");
        if (changed === 'scene')
          f.store.run(
            `INSERT INTO scene_states(world_id,conversation_id,character_id,revision,
        scene_json,updated_at,expires_at) VALUES ('c-world','c-conversation','c-character',1,?,?,NULL)`,
            JSON.stringify({ kind: 'remote', setting: null, plan: null, proximity: 'ordinary', speaking: 'normal' }),
            now,
          );
        if (changed === 'entitlement')
          f.store.run("UPDATE web_guest_retention SET expires_at=? WHERE principal_id='c-principal'", now);
        if (changed === 'abort') controller.abort();
        assert.ok(authorize);
        await authorize();
        calls++;
        return { audio: syntheticTone(), receipt: {}, usageUnits: wire.billedTextBytes };
      });
      await assert.rejects(
        runner.runSpeech(f.queue.claimAudio(f.coordinator, 'rpc-worker')!, controller.signal),
        /WEB_PROVIDER_CLAIM_STALE|WEB_INPUT_SNAPSHOT_STALE|SCENE_CONTEXT_CHANGED|TRIAL_EXPIRED|WEB_PROVIDER_ABORTED/,
      );
      assert.equal(calls, 0);
      // The durable send intent is uncertain, not a permission to refund or resend.
      assert.equal(
        f.store.get<{ state: string }>("SELECT state FROM web_provider_attempts WHERE phase='speech'")?.state,
        'unknown',
      );
    });
});

test('known rejected Fish audio settles the bill, survives lost settlement and never regenerates', async (t) => {
  for (const mode of ['local-invalid', 'rpc-known-failure', 'post-transport-invalid'] as const)
    await t.test(mode, async (t) => {
      const f = audioFixture(t);
      // This lower-level fixture skips admission; install its matching quota reservation.
      f.store.run("UPDATE web_ip_windows SET reserved=1 WHERE id='c-window'");
      f.store.run("UPDATE web_principals SET trial_reserved=1 WHERE id='c-principal'");
      f.store.run(
        "INSERT INTO web_ip_lifetime_quota(ip_hash,key_fingerprint,used_total,reserved_total) VALUES ('c-ip','offline',0,1)",
      );
      let entry: CloudBudgetEntry | undefined,
        calls = 0,
        settlements = 0;
      const budget = new WebCloudBudgetClient({
        read: async () => entry,
        reserve: async (_id, provider, fingerprint, held_micros) => {
          entry = { provider, fingerprint, held_micros, charged_micros: null, receipt_hash: null };
        },
        settle: async (_id, _hash, charge) => {
          if (++settlements === 1) throw Error('OFFLINE_SETTLEMENT_LOST');
          entry!.charged_micros = charge;
        },
      });
      const local = fishTransport(
        new FishAudio({
          apiKey: 'offline-only',
          fetch: async () => {
            calls++;
            return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/wav' } });
          },
        }),
      );
      const fish: ConstructorParameters<typeof WebProviderRunner>[3] =
        mode === 'local-invalid'
          ? local
          : async (wire) => {
              calls++;
              if (mode === 'post-transport-invalid')
                return { audio: new Uint8Array([1, 2, 3]), receipt: {}, usageUnits: wire.billedTextBytes };
              throw new SpeechFailure('SILENT_AUDIO_RESPONSE', {
                provider: 'fish',
                model: wire.model,
                elapsedMs: 1,
                requestId: 'offline-rpc',
                inputCharacters: [...wire.speech.text].length,
                inputUTF8Bytes: wire.billedTextBytes,
                billedAmount: null,
              });
            };
      const claim = f.queue.claimAudio(f.coordinator, 'known-failure')!;
      await assert.rejects(
        f.makeRunner(fish, budget).runSpeech(claim, new AbortController().signal),
        /OFFLINE_SETTLEMENT_LOST/,
      );
      const row = f.store.get<{ state: string; outcome: string; charged_micros: number }>(
        "SELECT state,outcome,charged_micros FROM web_provider_attempts WHERE phase='speech'",
      )!;
      assert.equal(row.state, 'known');
      assert.equal(row.outcome, 'failed');
      assert.ok(row.charged_micros > 0);
      assert.equal(entry!.charged_micros, null);
      assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_provider_outputs')!.n, 0);
      const recovered = f.makeRunner(fish, budget);
      await recovered.whenReady();
      assert.equal(entry!.charged_micros, row.charged_micros);
      assert.equal(settlements, 2);
      assert.deepEqual(
        {
          ...f.store.get<{ status: string; quota_state: string }>(
            "SELECT status,quota_state FROM web_operations WHERE id='c-operation'",
          ),
        },
        { status: 'failed', quota_state: 'released' },
      );
      await assert.rejects(recovered.runSpeech(claim, new AbortController().signal), /WEB_PROVIDER_CLAIM_STALE/);
      assert.equal(calls, 1);
    });
});

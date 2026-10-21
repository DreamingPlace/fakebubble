import { installWebCharacterDeletion } from '../../../apps/server/characters/web-character-deletion-schema.ts';
import { WebAccountAdmin } from '../../../apps/server/admin/web-account-admin.ts';
import type { WebRuntimeStore } from '../../../apps/server/platform/web-store-contract.ts';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import test, { type TestContext } from 'node:test';
import { Store } from '../../../apps/server/platform/store.ts';
import { WebProviderOffline } from '../../../apps/server/generation/web-provider-offline.ts';
import { migrateWebProviderOffline } from '../../../apps/server/generation/web-provider-migration.ts';
import { syntheticTone } from '../../../apps/server/platform/web-local-fake.ts';
import {
  acceptedAuditEnvelope,
  draftEnvelope,
  draftPresentation,
  draftWire,
  textRequest,
} from '../../text-fixtures.ts';
import { protocolFingerprint } from '../../../apps/server/generation/accepted-text-protocol.ts';
import { textPromptHash } from '../../../apps/server/generation/accepted-text-prompt.ts';
import { freezeInputSnapshot } from '../../../apps/server/generation/web-input-snapshot.ts';
import type { WebStore } from '../../../apps/server/platform/store.ts';
import { WebStageQueue } from '../../../apps/server/admission/web-stage-queue.ts';
import { WebVerticalPublisher } from '../../../apps/server/conversation/web-vertical-publisher.ts';
import { sceneState } from '../../../apps/server/conversation/scenes.ts';
import { userStore } from '../../../apps/server/platform/store-boundary.ts';
import { DeepSeekTextGenerator } from '../../../apps/server/generation/deepseek.ts';
import { fishTransport, WebProviderRunner } from '../../../apps/server/generation/web-provider-runner.ts';
import { WebDispatchLedger } from '../../../apps/server/budget/web-dispatch-ledger.ts';
import { fishSpeechRequest } from '../../../workers/audio/fish.ts';
import { FishAudio } from '../../../workers/audio/fish.ts';
import { WebProviderExecutor } from '../../../apps/server/generation/web-provider-executor.ts';
import { PROVIDER_PRICES, renewProviderPrices } from '../../../apps/server/generation/web-provider-configuration.ts';
import { WebCloudBudgetClient } from '../../../apps/server/cloudflare/web-budget-client.ts';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const now = 1_700_000_000_000;

test('explicit Fish transport preserves prepared wire and observed byte usage without network', async () => {
  let sends = 0;
  const speech = {
    jobId: 'offline-0',
    text: '合成',
    expression: 'neutral' as const,
    speed: 1,
    voice: { profileId: 'synthetic-profile', referenceId: 'synthetic-reference', version: 1 },
    model: 's2.1-pro' as const,
  };
  const prepared = fishSpeechRequest(speech, 's2.1-pro');
  const adapter = fishTransport(
    new FishAudio({
      apiKey: 'offline-only',
      fetch: async (_url, init) => {
        sends++;
        assert.equal(init?.body, prepared.body);
        return new Response(Uint8Array.from(syntheticTone()).buffer, { headers: { 'content-type': 'audio/wav' } });
      },
    }),
  );
  const input = {
    body: prepared.body,
    wireRequestHash: prepared.requestHash,
    billedTextBytes: prepared.bytes,
    model: 's2.1-pro' as const,
    speech,
  };
  await assert.rejects(adapter({ ...input, body: '{}' }, new AbortController().signal), /WEB_PROVIDER_WIRE_MISMATCH/);
  assert.equal(sends, 0);
  const result = await adapter(input, new AbortController().signal);
  assert.equal(result.usageUnits, prepared.bytes);
  assert.equal(result.audio.length, syntheticTone().length);
  assert.equal(sends, 1);
});

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

test('explicit memory-only 112→113 preserves old synthetic constraints and denies repeat migration', (t) => {
  const f = fixture(t);
  assert.equal(f.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 113);
  assert.throws(() => migrateWebProviderOffline(f.store), /WEB_PROVIDER_MIGRATION_REQUIRED/);
  assert.match(
    f.store.get<{ sql: string }>(`SELECT sql FROM sqlite_master WHERE name='web_v7_candidates'`)!.sql,
    /synthetic_test/,
  );
  assert.match(
    f.store.get<{ sql: string }>(`SELECT sql FROM sqlite_master WHERE name='web_private_audio_assets'`)!.sql,
    /synthetic_test/,
  );
});

test('provider scheduler does not start with implicit spending or capacity', (t) => {
  const f = fixture(t),
    clock = { now: () => now };
  const text = new DeepSeekTextGenerator({
    apiKey: 'offline-only',
    fetch: async () => {
      throw new Error('unexpected fetch');
    },
  });
  const runner = new WebProviderRunner(f.store, clock, text, async () => {
    throw new Error('unexpected speech');
  });
  const executor = new WebProviderExecutor(f.store, clock, runner);
  assert.throws(() => executor.start(), /WEB_PROVIDER_NOT_CONFIGURED/);
  assert.throws(() => f.ledger.configureBudget('deepseek', null), /WEB_PROVIDER_BUDGET_INVALID/);
  assert.throws(() => f.ledger.configureBudget('deepseek', 3_000_001), /WEB_PROVIDER_BUDGET_INVALID/);
  assert.equal(
    f.store.get<{ coordinator_token: string | null }>(
      'SELECT coordinator_token FROM web_scheduler_state WHERE singleton=1',
    )?.coordinator_token,
    null,
  );
});

test('USD upper holds are atomic, scoped and idempotent; UNKNOWN remains held until known receipt', (t) => {
  const f = fixture(t);
  f.price('fake-deepseek', 'draft');
  f.price('fake-deepseek', 'review');
  const draft = f.input('draft');
  assert.throws(() => f.ledger.reserve({ ...draft, provider: 'unpriced' }), /WEB_PROVIDER_PRICE_REQUIRED/);
  assert.throws(
    () => f.ledger.reserve({ ...draft, worldId: 'other' }),
    /WEB_RETENTION_SCOPE_INVALID|WEB_PROVIDER_SCOPE_INVALID/,
  );
  assert.throws(() => f.ledger.reserve({ ...draft, maxUnits: 3001 }), /WEB_PROVIDER_BUDGET_EXHAUSTED/);
  assert.equal(
    f.store.get<{ held_micros: number }>("SELECT held_micros FROM web_provider_spending WHERE provider='fake-deepseek'")
      ?.held_micros,
    0,
  );
  assert.deepEqual(f.ledger.reserve(draft), { duplicate: false, heldMicros: 1_000_000 });
  assert.deepEqual(f.ledger.reserve(draft), { duplicate: true, heldMicros: 1_000_000 });
  assert.throws(
    () => f.ledger.reserve({ ...draft, wireRequestHash: hash('changed') }),
    /WEB_PROVIDER_ATTEMPT_CONFLICT/,
  );
  const review = f.input('review');
  f.ledger.reserve(review);
  assert.throws(() => f.ledger.reserve({ ...review, ordinal: 0 }), /WEB_PROVIDER_RESERVATION_INVALID/);
  f.ledger.markSent(draft, f.scope);
  f.ledger.markUnknown(draft, f.scope);
  assert.equal(
    f.store.get<{ held_micros: number }>("SELECT held_micros FROM web_provider_spending WHERE provider='fake-deepseek'")
      ?.held_micros,
    2_000_000,
  );
  assert.throws(
    () =>
      f.ledger.confirm(
        draft,
        { ...f.scope, playerId: 'other' },
        { outcome: 'succeeded', receipt: {}, usageUnits: 10, output: { mode: 'casual' } },
      ),
    /WEB_PROVIDER_SCOPE_INVALID/,
  );
  const receipt = {
    outcome: 'succeeded' as const,
    receipt: { requestId: 'fake' },
    usageUnits: 10,
    output: { mode: 'casual' },
  };
  assert.deepEqual(f.ledger.confirm(draft, f.scope, receipt), { duplicate: false, chargedMicros: 10_000 });
  assert.deepEqual(f.ledger.confirm(draft, f.scope, receipt), { duplicate: true, chargedMicros: 10_000 });
  assert.deepEqual(f.ledger.readKnown(draft, f.scope), receipt.output);
  assert.throws(() => f.ledger.readKnown(draft, { ...f.scope, worldId: 'other' }), /WEB_PROVIDER_OUTPUT_UNAVAILABLE/);
  assert.deepEqual(
    {
      ...f.store.get<{ held_micros: number; spent_micros: number }>(
        "SELECT held_micros,spent_micros FROM web_provider_spending WHERE provider='fake-deepseek'",
      )!,
    },
    { held_micros: 1_000_000, spent_micros: 10_000 },
  );
});

test('known review and speech output pass pre-publication gate only with exact scope/version', (t) => {
  const f = fixture(t);
  const draft = draftWire(f.request);
  const spokenText = draftPresentation(f.request).bubbles[0]!.text;
  const review = {
    decision: 'accept',
    replacementBubbles: [],
    factOps: [],
    topics: [],
    coverage: { input: { status: 'answered', supportQuote: spokenText, missingInformation: '' } },
    sceneUpdate: null,
  };
  for (const phase of ['draft', 'review'] as const) {
    f.price('fake-deepseek', phase);
    const key = f.input(phase);
    f.ledger.reserve(key);
    f.ledger.markSent(key, f.scope);
    f.ledger.confirm(key, f.scope, {
      outcome: 'succeeded',
      receipt: { phase },
      usageUnits: 3,
      output: phase === 'draft' ? draft : review,
    });
  }
  f.price('fake-fish', 'speech');
  const speech = f.input('speech', 0);
  f.ledger.reserve(speech);
  f.ledger.markSent(speech, f.scope);
  assert.throws(
    () => f.ledger.validatePublication('operation', f.scope, [0], f.voiceVersion),
    /WEB_PROVIDER_PUBLICATION_INVALID/,
  );
  const bytes = syntheticTone();
  f.ledger.confirm(speech, f.scope, {
    outcome: 'succeeded',
    receipt: { phase: 'speech' },
    usageUnits: 3,
    output: bytes,
    spokenText,
  });
  assert.equal(f.ledger.validatePublication('operation', f.scope, [0], f.voiceVersion), true);
  assert.throws(
    () => f.ledger.validatePublication('operation', f.scope, [0], 'other'),
    /WEB_PROVIDER_PUBLICATION_INVALID/,
  );
  assert.throws(
    () => f.ledger.validatePublication('operation', { ...f.scope, principalId: 'other' }, [0], f.voiceVersion),
    /WEB_PROVIDER_PUBLICATION_INVALID/,
  );
});

test('failed pre-dispatch releases hold, while sent or UNKNOWN attempts cannot be released or resent', (t) => {
  const f = fixture(t);
  f.price('fake-deepseek', 'draft');
  f.price('fake-deepseek', 'review');
  const draft = f.input('draft'),
    review = f.input('review');
  f.ledger.reserve(draft);
  f.ledger.releaseUnsent(draft, f.scope);
  assert.equal(
    f.store.get<{ held_micros: number }>("SELECT held_micros FROM web_provider_spending WHERE provider='fake-deepseek'")
      ?.held_micros,
    0,
  );
  assert.throws(() => f.ledger.markSent(draft, f.scope), /WEB_PROVIDER_SCOPE_INVALID/);
  assert.throws(() => f.ledger.readKnown(draft, f.scope), /WEB_PROVIDER_OUTPUT_UNAVAILABLE/);
  f.ledger.reserve(review);
  f.ledger.markSent(review, f.scope);
  f.ledger.markUnknown(review, f.scope);
  assert.throws(() => f.ledger.releaseUnsent(review, f.scope), /WEB_PROVIDER_ATTEMPT_STALE/);
  assert.throws(() => f.ledger.markSent(review, f.scope), /WEB_PROVIDER_SCOPE_INVALID/);
  assert.deepEqual(f.ledger.reserve(review), { duplicate: true, heldMicros: 1_000_000 });
  assert.equal(
    f.store.get<{ held_micros: number }>("SELECT held_micros FROM web_provider_spending WHERE provider='fake-deepseek'")
      ?.held_micros,
    1_000_000,
  );
});

test('worst-case USD hold rejects competing reservations and price mutation', (t) => {
  const f = fixture(t);
  f.price('fake-deepseek', 'draft');
  f.price('fake-deepseek', 'review');
  f.ledger.reserve({ ...f.input('draft'), maxUnits: 2500 });
  assert.throws(() => f.ledger.reserve(f.input('review')), /WEB_PROVIDER_BUDGET_EXHAUSTED/);
  assert.equal(
    f.store.get<{ held_micros: number }>("SELECT held_micros FROM web_provider_spending WHERE provider='fake-deepseek'")
      ?.held_micros,
    2_500_000,
  );
  assert.throws(
    () => f.store.run("UPDATE web_provider_prices SET upper_micros_per_unit=1 WHERE id='fake-deepseek-draft-v1'"),
    /WEB_PROVIDER_PRICE_IMMUTABLE/,
  );
  assert.throws(
    () =>
      f.store.run(`INSERT INTO web_provider_prices VALUES
    ('bad','fake-deepseek','fake-model','draft','EUR','token',1,0,1,2)`),
    /constraint failed/i,
  );
});

test('identical Fish wire bodies are separate scoped ordinal attempts, never shared outputs', (t) => {
  const f = fixture(t);
  f.price('fake-fish', 'speech');
  const first = f.input('speech', 0);
  const second = { ...f.input('speech', 1), wireRequestHash: first.wireRequestHash };
  assert.deepEqual(f.ledger.reserve(first), { duplicate: false, heldMicros: 1_000_000 });
  assert.deepEqual(f.ledger.reserve(second), { duplicate: false, heldMicros: 1_000_000 });
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) AS n FROM web_provider_attempts')?.n, 2);
  assert.throws(
    () => f.ledger.reserve({ ...second, voiceVersion: 'changed' }),
    /WEB_PROVIDER_SCOPE_INVALID|WEB_PROVIDER_ATTEMPT_CONFLICT/,
  );
  f.ledger.markSent(first, f.scope);
  f.ledger.confirm(first, f.scope, {
    outcome: 'succeeded',
    receipt: { id: 'first' },
    usageUnits: 1,
    output: syntheticTone(),
    spokenText: '第一段',
  });
  assert.throws(() => f.ledger.readKnown(second, f.scope), /WEB_PROVIDER_OUTPUT_UNAVAILABLE/);
});

test('publication rejects opaque draft/review even with known WAV receipt', (t) => {
  const f = fixture(t);
  for (const phase of ['draft', 'review'] as const) {
    f.price('fake-deepseek', phase);
    const key = f.input(phase);
    f.ledger.reserve(key);
    f.ledger.markSent(key, f.scope);
    f.ledger.confirm(key, f.scope, {
      outcome: 'succeeded',
      receipt: { phase },
      usageUnits: 1,
      output: { invalid: true },
    });
  }
  f.price('fake-fish', 'speech');
  const speech = f.input('speech', 0);
  f.ledger.reserve(speech);
  f.ledger.markSent(speech, f.scope);
  f.ledger.confirm(speech, f.scope, {
    outcome: 'succeeded',
    receipt: { id: 'speech' },
    usageUnits: 1,
    output: syntheticTone(),
    spokenText: '随便说',
  });
  assert.throws(() => f.ledger.validatePublication('operation', f.scope, [0], f.voiceVersion), /INVALID_DRAFT_SCHEMA/);
});

test('publication derives complete speech ordinals and exact spoken text from accepted review', (t) => {
  const f = fixture(t);
  const draft = draftWire(f.request);
  const bubbles = [
    { text: '第一段合成语音。', expression: 'neutral' },
    { text: '第二段合成语音。', expression: 'neutral' },
  ];
  const review = {
    decision: 'accept',
    replacementBubbles: bubbles,
    factOps: [],
    topics: [],
    coverage: { input: { status: 'answered', supportQuote: bubbles[0]!.text, missingInformation: '' } },
    sceneUpdate: null,
  };
  for (const phase of ['draft', 'review'] as const) {
    f.price('fake-deepseek', phase);
    const key = f.input(phase);
    f.ledger.reserve(key);
    f.ledger.markSent(key, f.scope);
    f.ledger.confirm(key, f.scope, {
      outcome: 'succeeded',
      receipt: { phase },
      usageUnits: 1,
      output: phase === 'draft' ? draft : review,
    });
  }
  f.price('fake-fish', 'speech');
  const first = f.input('speech', 0);
  f.ledger.reserve(first);
  f.ledger.markSent(first, f.scope);
  f.ledger.confirm(first, f.scope, {
    outcome: 'succeeded',
    receipt: { id: 'first' },
    usageUnits: 1,
    output: syntheticTone(),
    spokenText: bubbles[0]!.text,
  });
  assert.throws(
    () => f.ledger.validatePublication('operation', f.scope, [0], f.voiceVersion),
    /WEB_PROVIDER_PUBLICATION_INVALID/,
  );
  const second = f.input('speech', 1);
  f.ledger.reserve(second);
  f.ledger.markSent(second, f.scope);
  f.ledger.confirm(second, f.scope, {
    outcome: 'succeeded',
    receipt: { id: 'second' },
    usageUnits: 1,
    output: syntheticTone(),
    spokenText: '错误正文',
  });
  assert.throws(
    () => f.ledger.validatePublication('operation', f.scope, [0, 1], f.voiceVersion),
    /WEB_PROVIDER_PUBLICATION_INVALID/,
  );
  assert.throws(
    () =>
      f.ledger.confirm(second, f.scope, {
        outcome: 'succeeded',
        receipt: { id: 'second' },
        usageUnits: 1,
        output: syntheticTone(),
        spokenText: bubbles[1]!.text,
      }),
    /WEB_PROVIDER_RECEIPT_CONFLICT/,
  );
});

// Named exception (Part 22x): the legacy invite grant predicate is gone; the same assertion (the reservation re-reads the CURRENT
// same-scope access rule, so access ending between two reservations refuses the second and releases nothing) now runs on the
// remaining rule, the guest's retention expiry.
test('113 memory-only reservation reuses current same-scope access predicate', (t) => {
  const f = fixture(t);
  f.store.run("UPDATE web_guest_retention SET state='active',expires_at=? WHERE principal_id='principal'", now + 1000);
  f.price('fake-deepseek', 'draft');
  f.price('fake-deepseek', 'review');
  f.ledger.reserve(f.input('draft'));
  f.store.run("UPDATE web_guest_retention SET expires_at=? WHERE principal_id='principal'", now);
  assert.throws(() => f.ledger.reserve(f.input('review')), /TRIAL_EXPIRED/);
  assert.equal(
    f.store.get<{ held_micros: number }>("SELECT held_micros FROM web_provider_spending WHERE provider='fake-deepseek'")
      ?.held_micros,
    1_000_000,
  );
});

test('113 claim-bound monetary reservation rejects stale lease without consuming USD', (t) => {
  const f = fixture(t);
  f.price('fake-deepseek', 'draft');
  f.store.run(
    "INSERT INTO web_external_budgets(provider,stage,phase,capacity) VALUES ('fake-deepseek','text','draft',2)",
  );
  f.store.run(
    `UPDATE web_scheduler_state SET epoch=1,coordinator_token='coordinator',
    coordinator_expires_at=? WHERE singleton=1`,
    now + 1000,
  );
  f.store.run(
    `UPDATE web_operations SET status='text_running',stage_version=2,
    lease_epoch=1,lease_token='lease',lease_owner='worker',lease_expires_at=?
    WHERE id='operation'`,
    now + 1000,
  );
  const claim = {
    operationId: 'operation',
    stage: 'text' as const,
    stageVersion: 2,
    epoch: 1,
    token: 'lease',
    owner: 'worker',
    principalId: 'principal',
    worldId: 'world',
    conversationId: 'conversation',
    characterId: 'character',
    inputMessageId: 'input',
    deadlineAt: now + 100_000,
    leaseExpiresAt: now + 1000,
  };
  assert.throws(
    () => f.ledger.reserveForClaim({ ...claim, token: 'wrong' }, f.input('draft')),
    /WEB_PROVIDER_CLAIM_STALE/,
  );
  assert.equal(
    f.store.get<{ held_micros: number }>("SELECT held_micros FROM web_provider_spending WHERE provider='fake-deepseek'")
      ?.held_micros,
    0,
  );
  assert.equal(
    f.store.get<{ reserved: number }>(
      "SELECT reserved FROM web_external_budgets WHERE provider='fake-deepseek' AND phase='draft'",
    )?.reserved,
    0,
  );
  f.store.run("UPDATE web_external_budgets SET reserved=capacity WHERE provider='fake-deepseek' AND phase='draft'");
  assert.throws(() => f.ledger.reserveForClaim(claim, f.input('draft')), /WEB_EXTERNAL_CAPACITY_UNAVAILABLE/);
  assert.equal(
    f.store.get<{ held_micros: number }>("SELECT held_micros FROM web_provider_spending WHERE provider='fake-deepseek'")
      ?.held_micros,
    0,
  );
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) AS n FROM web_provider_attempts')?.n, 0);
  f.store.run("UPDATE web_external_budgets SET reserved=0 WHERE provider='fake-deepseek' AND phase='draft'");
  f.ledger.reserveForClaim(claim, f.input('draft'));
  assert.equal(
    f.store.get<{ reserved: number }>(
      "SELECT reserved FROM web_external_budgets WHERE provider='fake-deepseek' AND phase='draft'",
    )?.reserved,
    1,
  );
  assert.throws(
    () => f.ledger.markSentForClaim({ ...claim, token: 'wrong' }, f.input('draft'), f.scope),
    /WEB_PROVIDER_CLAIM_STALE/,
  );
  f.ledger.markSentForClaim(claim, f.input('draft'), f.scope);
});

test('accepted known stages freeze provider candidate and ordered voice segments before freeing text lease', (t) => {
  const f = fixture(t);
  const draft = draftWire(f.request);
  const speech = draftPresentation(f.request).bubbles[0]!.text;
  const review = {
    decision: 'accept',
    replacementBubbles: [],
    factOps: [],
    topics: [],
    coverage: { input: { status: 'answered', supportQuote: speech, missingInformation: '' } },
    sceneUpdate: null,
  };
  for (const phase of ['draft', 'review'] as const) {
    f.price('fake-deepseek', phase);
    const key = f.input(phase);
    f.ledger.reserve(key);
    f.ledger.markSent(key, f.scope);
    f.ledger.confirm(key, f.scope, {
      outcome: 'succeeded',
      receipt: { phase },
      usageUnits: 1,
      output: phase === 'draft' ? draft : review,
    });
  }
  f.store.run(
    `UPDATE web_scheduler_state SET epoch=1,coordinator_token='coordinator',
    coordinator_expires_at=? WHERE singleton=1`,
    now + 1000,
  );
  f.store.run(
    `UPDATE web_operations SET status='text_running',stage_version=2,
    lease_epoch=1,lease_token='lease',lease_owner='worker',lease_expires_at=?
    WHERE id='operation'`,
    now + 1000,
  );
  const claim = {
    operationId: 'operation',
    stage: 'text' as const,
    stageVersion: 2,
    epoch: 1,
    token: 'lease',
    owner: 'worker',
    principalId: 'principal',
    worldId: 'world',
    conversationId: 'conversation',
    characterId: 'character',
    inputMessageId: 'input',
    deadlineAt: now + 100_000,
    leaseExpiresAt: now + 1000,
  };
  assert.equal(f.ledger.commitReviewed(claim, f.scope).bubbles[0]!.text, speech);
  assert.equal(
    f.store.get<{ status: string }>("SELECT status FROM web_operations WHERE id='operation'")?.status,
    'text_ready',
  );
  assert.equal(
    f.store.get<{ text_digest: string }>(`SELECT text_digest FROM web_provider_voice_segments
    WHERE operation_id='operation' AND ordinal=0`)?.text_digest,
    hash(speech),
  );
  assert.throws(() => f.ledger.commitReviewed(claim, f.scope), /WEB_PROVIDER_CLAIM_STALE/);
  f.price('fake-fish', 'speech');
  f.store.run(
    "INSERT INTO web_external_budgets(provider,stage,phase,capacity) VALUES ('fake-fish','audio','speech',1)",
  );
  const queue = new WebStageQueue(f.store as WebStore, { now: () => now }, () => 'audio-lease');
  const audioClaim = queue.claimAudio(
    { epoch: 1, token: 'coordinator', owner: 'coordinator', expiresAt: now + 1000 },
    'audio-worker',
  )!;
  assert.equal(audioClaim.ordinal, 0);
  const key = f.input('speech', 0);
  f.ledger.reserveForClaim(audioClaim, key);
  f.ledger.markSentForClaim(audioClaim, key, f.scope);
  f.ledger.confirm(key, f.scope, {
    outcome: 'succeeded',
    receipt: { id: 'speech' },
    usageUnits: 1,
    output: syntheticTone(),
    spokenText: speech,
  });
  const mediaId = f.ledger.attachKnownSpeech(audioClaim, f.scope);
  assert.equal(
    f.store.get<{ media_id: string }>(`SELECT media_id FROM web_provider_media_assets
    WHERE operation_id='operation' AND ordinal=0`)?.media_id,
    mediaId,
  );
  assert.equal(
    f.store.get<{ status: string }>("SELECT status FROM web_operations WHERE id='operation'")?.status,
    'audio_pending',
  );
  f.store.run("UPDATE web_principals SET trial_used=2,kind='account',revision=revision+1 WHERE id='principal'");
  f.store.run("UPDATE web_guest_retention SET state='protected' WHERE principal_id='principal'");
  f.store.run(
    `INSERT INTO web_accounts(id,principal_id,username_norm,password_salt,password_tag,created_at)
    VALUES ('account','principal','synthetic-account',?,?,?)`,
    Buffer.alloc(16, 1),
    Buffer.alloc(32, 2),
    now,
  );
  f.store.run("UPDATE web_ip_windows SET used=2 WHERE id='window'");
  f.store.run("UPDATE web_ip_lifetime_quota SET used_total=2 WHERE ip_hash='ip'");
  let ids = 0;
  const publisher = new WebVerticalPublisher(f.store as WebStore, { now: () => now }, () => `published-${++ids}`);
  const publishClaim = publisher.claim(
    { epoch: 1, token: 'coordinator', owner: 'coordinator', expiresAt: now + 1000 },
    'operation',
    'publisher',
  );
  const published = publisher.publish(publishClaim);
  assert.equal(published.messageIds.length, 1);
  assert.equal(published.footerMessageId, null, 'upgrade before publication suppresses trial footer');
  assert.equal(
    f.store.get<{ status: string }>("SELECT status FROM web_operations WHERE id='operation'")?.status,
    'published',
  );
  assert.deepEqual(publisher.publish(publishClaim), published);
  assert.equal(
    publisher.readPublishedAudio(
      {
        principalId: 'principal',
        playerId: 'player',
        worldId: 'world',
        conversationId: 'conversation',
        characterId: 'character',
      },
      mediaId,
    ).length,
    syntheticTone().length,
  );
});

test('113 fake protocol runner completes scoped text, Fish WAV, publication and private read', async (t) => {
  let clockNow = now;
  const f = fixture(t),
    clock = { now: () => clockNow };
  let textCalls = 0,
    fishCalls = 0;
  const generator = new DeepSeekTextGenerator({
    apiKey: 'offline-only',
    fetch: async (_url, init) => {
      textCalls++;
      const tool = JSON.parse(String(init?.body)).tools[0].function.name;
      if (tool === 'submit_dialogue_draft') return Response.json(draftEnvelope(f.request));
      const envelope = acceptedAuditEnvelope(f.request);
      const call = envelope.choices[0]!.message.tool_calls[0]!.function;
      const audit = JSON.parse(call.arguments);
      audit.replacementBubbles = [
        { text: '第一段合成语音。', expression: 'neutral' },
        { text: '第二段合成语音。', expression: 'neutral' },
      ];
      audit.coverage.input.supportQuote = '第一段合成语音。';
      call.arguments = JSON.stringify(audit);
      return Response.json(envelope);
    },
  });
  const runner = new WebProviderRunner(f.store, clock, generator, async (request) => {
    fishCalls++;
    const text = fishCalls === 1 ? '第一段合成语音。' : '第二段合成语音。';
    const expected = fishSpeechRequest(
      {
        jobId: `operation-${fishCalls - 1}`,
        text,
        expression: 'neutral',
        speed: 1,
        voice: { profileId: 'synthetic-profile', referenceId: 'synthetic-reference', version: 1 },
        model: 's2.1-pro',
        deliveryStyle: 'conversational',
      },
      's2.1-pro',
    );
    assert.deepEqual(request, {
      body: expected.body,
      wireRequestHash: expected.requestHash,
      model: 's2.1-pro',
      billedTextBytes: expected.bytes,
      speech: {
        jobId: `operation-${fishCalls - 1}`,
        text,
        expression: 'neutral',
        speed: 1,
        voice: { profileId: 'synthetic-profile', referenceId: 'synthetic-reference', version: 1 },
        model: 's2.1-pro',
        deliveryStyle: 'conversational',
      },
    });
    if (fishCalls === 1) clockNow = now + 11;
    return { audio: syntheticTone(), receipt: { id: 'fake-fish' }, usageUnits: expected.bytes };
  });
  f.ledger.configureBudget('deepseek', 3_000_000);
  for (const phase of ['draft', 'review'] as const) {
    f.ledger.configurePrice({
      id: `deepseek-${phase}`,
      provider: 'deepseek',
      model: phase === 'draft' ? generator.model : generator.reviewModel,
      phase,
      currency: 'USD',
      unit: 'token',
      upperMicrosPerUnit: 1,
      validFrom: now - 1,
      validUntil: now + 1000,
      version: 1,
    });
    new WebDispatchLedger(f.store as WebStore, clock).configureBudget({
      provider: 'deepseek',
      stage: 'text',
      phase,
      capacity: 1,
    });
  }
  f.store.run(
    `UPDATE web_scheduler_state SET epoch=1,coordinator_token='coordinator',
    coordinator_expires_at=? WHERE singleton=1`,
    now + 1000,
  );
  f.store.run(
    `UPDATE web_operations SET status='text_running',stage_version=2,
    lease_epoch=1,lease_token='text-lease',lease_owner='text-worker',lease_expires_at=?
    WHERE id='operation'`,
    now + 1000,
  );
  const textClaim = {
    operationId: 'operation',
    stage: 'text' as const,
    stageVersion: 2,
    epoch: 1,
    token: 'text-lease',
    owner: 'text-worker',
    principalId: 'principal',
    worldId: 'world',
    conversationId: 'conversation',
    characterId: 'character',
    inputMessageId: 'input',
    deadlineAt: now + 100_000,
    leaseExpiresAt: now + 1000,
  };
  await runner.runText(textClaim, new AbortController().signal);
  assert.equal(textCalls, 2);
  for (const row of f.store.all<{ phase: string; max_units: number }>(`SELECT phase,max_units
    FROM web_provider_attempts WHERE operation_id='operation' AND phase IN ('draft','review')`))
    assert.ok(row.max_units < 1_048_576, `${row.phase} hold is bounded by wire bytes`);
  assert.equal(
    f.store.get<{ status: string }>("SELECT status FROM web_operations WHERE id='operation'")?.status,
    'text_ready',
  );
  f.ledger.configureBudget('fish', 3_000_000);
  f.ledger.configurePrice({
    id: 'fish-speech',
    provider: 'fish',
    model: 's2.1-pro',
    phase: 'speech',
    currency: 'USD',
    unit: 'byte',
    upperMicrosPerUnit: 1,
    validFrom: now - 1,
    validUntil: now + 1000,
    version: 1,
  });
  new WebDispatchLedger(f.store as WebStore, clock).configureBudget({
    provider: 'fish',
    stage: 'audio',
    phase: 'speech',
    capacity: 1,
  });
  f.ledger.configureVoice({
    characterId: 'character',
    voiceVersion: f.voiceVersion,
    voiceRevision: 1,
    profileId: 'synthetic-profile',
    referenceId: 'synthetic-reference',
    model: 's2.1-pro',
    approved: true,
  });
  const coordinator = { epoch: 1, token: 'coordinator', owner: 'coordinator', expiresAt: now + 1000 };
  const queue = new WebStageQueue(f.store as WebStore, clock, () => 'audio-lease');
  const audioClaim = queue.claimAudio(coordinator, 'audio-worker')!;
  f.store.run(
    `INSERT INTO scene_states(world_id,conversation_id,character_id,revision,
    scene_json,updated_at,expires_at) VALUES ('world','conversation','character',1,?,?,NULL)`,
    JSON.stringify({ kind: 'remote', setting: null, plan: null, proximity: 'ordinary', speaking: 'normal' }),
    now,
  );
  await assert.rejects(runner.runSpeech(audioClaim, new AbortController().signal), /SCENE_CONTEXT_CHANGED/);
  assert.equal(fishCalls, 0, 'scene drift must reject before transport');
  assert.equal(
    f.store.get<{ n: number }>(`SELECT count(*) n FROM web_provider_attempts
    WHERE operation_id='operation' AND phase='speech'`)?.n,
    0,
  );
  f.store.run(
    "DELETE FROM scene_states WHERE world_id='world' AND conversation_id='conversation' AND character_id='character'",
  );
  f.store.run("UPDATE web_operations SET lease_expires_at=? WHERE id='operation'", now + 10);
  await assert.rejects(runner.runSpeech(audioClaim, new AbortController().signal), /WEB_PROVIDER_CLAIM_STALE/);
  assert.equal(
    f.store.get<{ state: string }>(`SELECT state FROM web_provider_attempts
    WHERE operation_id='operation' AND phase='speech' AND ordinal=0`)?.state,
    'known',
  );
  const recovery = new WebDispatchLedger(f.store as WebStore, clock);
  assert.deepEqual(recovery.recover(coordinator, recovery.fence('operation')), { status: 'audio_pending' });
  const recoveredClaim = queue.claimAudio(coordinator, 'audio-worker')!;
  assert.equal(recoveredClaim.ordinal, 0);
  await runner.runSpeech(recoveredClaim, new AbortController().signal);
  assert.equal(fishCalls, 1, 'known WAV must attach without a second transport call');
  const secondAudioClaim = queue.claimAudio(coordinator, 'audio-worker')!;
  assert.equal(secondAudioClaim.ordinal, 1);
  await runner.runSpeech(secondAudioClaim, new AbortController().signal);
  assert.equal(fishCalls, 2);
  const footerMediaId = f.ledger.registerApprovedFooter({
    characterId: 'character',
    voiceVersion: f.voiceVersion,
    body: '有空一定要来找我呀～',
    wav: syntheticTone(),
    approved: true,
  });
  f.store.run("UPDATE web_principals SET trial_used=2,revision=revision+1 WHERE id='principal'");
  f.store.run("UPDATE web_ip_windows SET used=2 WHERE id='window'");
  f.store.run("UPDATE web_ip_lifetime_quota SET used_total=2 WHERE ip_hash='ip'");
  const receipt = runner.publish(coordinator, 'operation');
  assert.equal(receipt.messageIds.length, 2);
  assert.ok(receipt.footerMessageId);
  assert.deepEqual(runner.publish(coordinator, 'operation'), receipt);
  const publisher = new WebVerticalPublisher(f.store as WebStore, clock);
  const mediaId = f.store.get<{ media_id: string }>(`SELECT media_id FROM web_provider_media_assets
    WHERE operation_id='operation' AND ordinal=0`)!.media_id;
  assert.equal(
    publisher.readPublishedAudio(
      {
        principalId: 'principal',
        playerId: 'player',
        worldId: 'world',
        conversationId: 'conversation',
        characterId: 'character',
      },
      mediaId,
    ).length,
    syntheticTone().length,
  );
  assert.equal(
    publisher.readPublishedAudio(
      {
        principalId: 'principal',
        playerId: 'player',
        worldId: 'world',
        conversationId: 'conversation',
        characterId: 'character',
      },
      footerMediaId,
    ).length,
    syntheticTone().length,
  );
  assert.throws(
    () =>
      publisher.readPublishedAudio(
        {
          principalId: 'principal',
          playerId: 'other',
          worldId: 'world',
          conversationId: 'conversation',
          characterId: 'character',
        },
        mediaId,
      ),
    /WEB_PUBLISHED_AUDIO_NOT_FOUND/,
  );
  // Named exception (Part 22x): the invite upgrade and grant revocation that closed this test are gone with the legacy invite
  // system. The current-access rule is exercised on the remaining one: a live guest reads its audio, an expired one does not.
  assert.equal(
    publisher.readPublishedAudio(
      {
        principalId: 'principal',
        playerId: 'player',
        worldId: 'world',
        conversationId: 'conversation',
        characterId: 'character',
      },
      mediaId,
    ).length,
    syntheticTone().length,
  );
  f.store.run("UPDATE web_guest_retention SET expires_at=? WHERE principal_id='principal'", now);
  assert.throws(
    () =>
      publisher.readPublishedAudio(
        {
          principalId: 'principal',
          playerId: 'player',
          worldId: 'world',
          conversationId: 'conversation',
          characterId: 'character',
        },
        mediaId,
      ),
    /TRIAL_EXPIRED/,
  );
});

test('text phases await remote holds and known settlement before review and text-ready', async (t) => {
  const f = fixture(t),
    clock = { now: () => now };
  const steps: string[] = [];
  const pending = new Map<string, () => void>();
  const waitFor = async (name: string) => {
    for (let i = 0; i < 30 && !pending.has(name); i++) await new Promise((resolve) => setImmediate(resolve));
    assert.ok(pending.has(name), `missing ${name}: ${steps.join(',')}`);
  };
  const pause = async (name: string) => {
    const gate = new Promise<void>((resolve) => {
      pending.set(name, resolve);
    });
    steps.push(name);
    await gate;
  };
  const budget = new WebCloudBudgetClient({
    read: async () => undefined,
    reserve: async (id) => {
      await pause(`hold-${JSON.parse(id)[2]}`);
    },
    settle: async (id) => {
      await pause(`settle-${JSON.parse(id)[2]}`);
    },
  });
  const generator = new DeepSeekTextGenerator({
    apiKey: 'offline-only',
    fetch: async (_url, init) => {
      const draft = JSON.parse(String(init?.body)).tools[0].function.name === 'submit_dialogue_draft';
      steps.push(draft ? 'send-draft' : 'send-review');
      return Response.json(draft ? draftEnvelope(f.request) : acceptedAuditEnvelope(f.request));
    },
  });
  f.ledger.configureBudget('deepseek', 3_000_000);
  for (const phase of ['draft', 'review'] as const) {
    f.ledger.configurePrice({
      id: `async-${phase}`,
      provider: 'deepseek',
      model: phase === 'draft' ? generator.model : generator.reviewModel,
      phase,
      currency: 'USD',
      unit: 'token',
      upperMicrosPerUnit: 1,
      validFrom: now - 1,
      validUntil: now + 1000,
      version: 1,
    });
    new WebDispatchLedger(f.store as WebStore, clock).configureBudget({
      provider: 'deepseek',
      stage: 'text',
      phase,
      capacity: 1,
    });
  }
  f.store.run(
    "UPDATE web_scheduler_state SET epoch=1,coordinator_token='async-coordinator',coordinator_expires_at=? WHERE singleton=1",
    now + 1000,
  );
  f.store.run(
    `UPDATE web_operations SET status='text_running',stage_version=2,
    lease_epoch=1,lease_token='async-lease',lease_owner='async-worker',lease_expires_at=? WHERE id='operation'`,
    now + 1000,
  );
  const runner = new WebProviderRunner(
    f.store,
    clock,
    generator,
    async () => {
      throw Error('UNEXPECTED_SPEECH');
    },
    budget,
  );
  const run = runner.runText(
    {
      operationId: 'operation',
      stage: 'text',
      stageVersion: 2,
      epoch: 1,
      token: 'async-lease',
      owner: 'async-worker',
      principalId: 'principal',
      worldId: 'world',
      conversationId: 'conversation',
      characterId: 'character',
      inputMessageId: 'input',
      deadlineAt: now + 100_000,
      leaseExpiresAt: now + 1000,
    },
    new AbortController().signal,
  );
  for (const step of ['hold-draft', 'settle-draft', 'hold-review', 'settle-review']) {
    await waitFor(step);
    assert.equal(
      f.store.get<{ status: string }>("SELECT status FROM web_operations WHERE id='operation'")?.status,
      'text_running',
    );
    if (step === 'hold-draft') assert.deepEqual(steps, ['hold-draft']);
    if (step === 'settle-draft') assert.deepEqual(steps, ['hold-draft', 'send-draft', 'settle-draft']);
    if (step === 'hold-review') assert.ok(!steps.includes('send-review'));
    pending.get(step)!();
  }
  await run;
  assert.deepEqual(steps, ['hold-draft', 'send-draft', 'settle-draft', 'hold-review', 'send-review', 'settle-review']);
  assert.equal(
    f.store.get<{ status: string }>("SELECT status FROM web_operations WHERE id='operation'")?.status,
    'text_ready',
  );
});

test('113 runner resumes one confirmed draft with review-only fake request', async (t) => {
  const f = fixture(t),
    clock = { now: () => now };
  let calls = 0;
  const generator = new DeepSeekTextGenerator({
    apiKey: 'offline-only',
    fetch: async (_url, init) => {
      calls++;
      assert.equal(JSON.parse(String(init?.body)).tools[0].function.name, 'submit_dialogue_audit');
      return Response.json(acceptedAuditEnvelope(f.request));
    },
  });
  const runner = new WebProviderRunner(f.store, clock, generator, async () => {
    throw new Error('no speech in this test');
  });
  f.ledger.configureBudget('deepseek', 3_000_000);
  for (const phase of ['draft', 'review'] as const) {
    f.ledger.configurePrice({
      id: `deepseek-${phase}`,
      provider: 'deepseek',
      model: phase === 'draft' ? generator.model : generator.reviewModel,
      phase,
      currency: 'USD',
      unit: 'token',
      upperMicrosPerUnit: 1,
      validFrom: now - 1,
      validUntil: now + 1000,
      version: 1,
    });
    new WebDispatchLedger(f.store as WebStore, clock).configureBudget({
      provider: 'deepseek',
      stage: 'text',
      phase,
      capacity: 1,
    });
  }
  f.store.run(
    `UPDATE web_scheduler_state SET epoch=1,coordinator_token='coordinator',
    coordinator_expires_at=? WHERE singleton=1`,
    now + 1000,
  );
  f.store.run(
    `UPDATE web_operations SET status='text_running',stage_version=2,
    lease_epoch=1,lease_token='text-lease',lease_owner='text-worker',lease_expires_at=?
    WHERE id='operation'`,
    now + 1000,
  );
  const claim = {
    operationId: 'operation',
    stage: 'text' as const,
    stageVersion: 2,
    epoch: 1,
    token: 'text-lease',
    owner: 'text-worker',
    principalId: 'principal',
    worldId: 'world',
    conversationId: 'conversation',
    characterId: 'character',
    inputMessageId: 'input',
    deadlineAt: now + 100_000,
    leaseExpiresAt: now + 1000,
  };
  const key = {
    ...f.input('draft'),
    provider: 'deepseek',
    model: generator.model,
    policyHash: generator.policyHash,
    maxUnits: 1000,
  };
  f.ledger.reserveForClaim(claim, key);
  f.ledger.markSentForClaim(claim, key, f.scope);
  f.ledger.confirm(key, f.scope, {
    outcome: 'succeeded',
    receipt: { id: 'known-draft' },
    usageUnits: 15,
    output: draftWire(f.request),
    metadata: {
      stage: 'draft',
      model: generator.model,
      status: 'succeeded',
      requestId: 'known-draft',
      elapsedMs: 1,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    },
  });
  f.store.run("UPDATE web_operations SET lease_expires_at=? WHERE id='operation'", now);
  const recovered = new WebStageQueue(f.store as WebStore, clock, () => 'text-resume').resumeKnownText(
    { epoch: 1, token: 'coordinator', owner: 'coordinator', expiresAt: now + 1000 },
    'operation',
    'text-worker',
  );
  assert.equal(recovered.stageVersion, 3);
  await runner.runText(recovered, new AbortController().signal);
  assert.equal(calls, 1);
  assert.equal(
    f.store.get<{ status: string }>("SELECT status FROM web_operations WHERE id='operation'")?.status,
    'text_ready',
  );
});

test('113 runner does not resend an UNKNOWN text attempt', async (t) => {
  const f = fixture(t);
  f.price('fake-deepseek', 'draft');
  const key = f.input('draft');
  f.ledger.reserve(key);
  f.ledger.markSent(key, f.scope);
  f.ledger.markUnknown(key, f.scope);
  let calls = 0;
  const generator = new DeepSeekTextGenerator({
    apiKey: 'offline-only',
    fetch: async () => {
      calls++;
      throw new Error('must not resend');
    },
  });
  const runner = new WebProviderRunner(f.store, { now: () => now }, generator, async () => {
    throw new Error('must not synthesize');
  });
  await assert.rejects(
    () =>
      runner.runText(
        {
          operationId: 'operation',
          stage: 'text',
          stageVersion: 2,
          epoch: 1,
          token: 'lease',
          owner: 'worker',
          principalId: 'principal',
          worldId: 'world',
          conversationId: 'conversation',
          characterId: 'character',
          inputMessageId: 'input',
          deadlineAt: now + 100_000,
          leaseExpiresAt: now + 1000,
        },
        new AbortController().signal,
      ),
    /WEB_PROVIDER_RECOVERY_UNKNOWN/,
  );
  assert.equal(calls, 0);
  assert.equal(
    f.store.get<{ held_micros: number }>(`SELECT held_micros FROM web_provider_spending
    WHERE provider='fake-deepseek'`)?.held_micros,
    1_000_000,
  );
});

test('113 shared text queue freezes a fresh V7 request with approved synthetic voice binding', (t) => {
  const f = fixture(t);
  f.store.run("UPDATE web_operations SET status='failed',quota_state='released',stage_version=2 WHERE id='operation'");
  f.store.run(
    'UPDATE character_templates SET config_json=? WHERE id=?',
    JSON.stringify(f.request.character),
    'character',
  );
  f.ledger.configureVoice({
    characterId: 'character',
    voiceVersion: 'fixture-voice:v1',
    voiceRevision: 1,
    profileId: 'synthetic-profile',
    referenceId: 'synthetic-reference',
    model: 's2.1-pro',
    approved: true,
  });
  f.store.run(
    `INSERT INTO messages(id,world_id,conversation_id,author_kind,author_id,body,
    created_at,delivery,proactive) VALUES ('input-2','world','conversation','player','player',
    '合成第二轮',?,'text',0)`,
    now,
  );
  f.store.run(
    `INSERT INTO web_operations(id,principal_id,request_id,payload_hash,world_id,
    conversation_id,character_id,input_message_id,ip_window_id,status,quota_state,
    created_at,deadline_at,admission_seq,text_queued_at)
    VALUES ('operation-2','principal','request-2','payload-2','world','conversation',
      'character','input-2','window','queued','reserved',?,?,2,?)`,
    now,
    now + 100_000,
    now,
  );
  const queue = new WebStageQueue(f.store as WebStore, { now: () => now }, () => 'text-lease');
  const coordinator = queue.acquireCoordinator('coordinator');
  const claim = queue.claimText(coordinator, 'text-worker')!;
  assert.equal(claim.operationId, 'operation-2');
  const frozen = f.store.get<{ voice_version: string; request_json: string }>(
    "SELECT voice_version,request_json FROM web_v7_requests WHERE operation_id='operation-2'",
  )!;
  assert.equal(frozen.voice_version, 'fixture-voice:v1');
  assert.equal(JSON.parse(frozen.request_json).requiredMessageIds[0], 'input-2');
  assert.ok(f.store.get("SELECT 1 FROM web_input_snapshots WHERE operation_id='operation-2'"));
});

test('Node deletion migration backfills proof for preexisting known receipts without changing bills or immutable output protection', (t) => {
  const f = fixture(t);
  f.price('fake-fish', 'speech');
  const key = f.input('speech', 0);
  const result = {
    outcome: 'succeeded' as const,
    receipt: { id: 'old-receipt' },
    usageUnits: 1,
    output: syntheticTone(),
    spokenText: '旧版已知结果',
  };
  f.ledger.reserve(key);
  f.ledger.markSent(key, f.scope);
  f.ledger.confirm(key, f.scope, result);
  const before = f.store.all('SELECT * FROM web_provider_spending');
  const store = Object.assign(f.store, {
    webReceiptDigest: (kind: string, json: string) => hash(kind + ':offline-fixture:' + json),
  }) as unknown as WebRuntimeStore;
  new WebAccountAdmin(store, { now: () => now }, 'https://fixture.invalid');
  installWebCharacterDeletion(store);
  installWebCharacterDeletion(store);
  assert.equal(f.ledger.confirm(key, f.scope, result).duplicate, true);
  assert.throws(() => f.ledger.confirm(key, f.scope, { ...result, spokenText: 'changed' }), /RECEIPT_CONFLICT/);
  assert.deepEqual(f.store.all('SELECT * FROM web_provider_spending'), before);
  assert.throws(() => f.store.run('DELETE FROM web_provider_outputs'), /OUTPUT_IMMUTABLE/);
  f.store.all('DROP TRIGGER web_provider_outputs_no_delete');
  assert.throws(() => installWebCharacterDeletion(store), /SCHEMA_MISMATCH/);
});

// Part 18b: provider price renewal. The first price rows (30 days) are written once at initialization; renew-prices
// appends contiguous 90-day rows after them and never touches an existing row.
const DAY = 86_400_000;
// Part 21b NAMED EXCEPTION (the only edit to these renewal tests): PROVIDER_PRICES gained xAI and Gemini rows. A deployment
// initialized before this Part has initial prices for the providers below only, so the initial seeding stays exactly that
// and the assertions say what renew adds for the providers that had no rows yet (see the "no rows yet" test further down).
const INITIAL_PROVIDERS = new Set(['deepseek', 'fish']);
const NEW_PROVIDER_ROWS = PROVIDER_PRICES.filter((price) => !INITIAL_PROVIDERS.has(price.provider)).length;
const initialRows = <T extends { provider: string }>(rows: T[]) =>
  rows.filter((row) => INITIAL_PROVIDERS.has(row.provider));
function seedInitialPrices(f: ReturnType<typeof fixture>, validDays = 30) {
  for (const provider of INITIAL_PROVIDERS) f.ledger.configureBudget(provider, 3_000_000);
  for (const price of PROVIDER_PRICES.filter((item) => INITIAL_PROVIDERS.has(item.provider)))
    f.ledger.configurePrice({
      id: `${price.provider}-${price.model}-${price.phase}-${now}`,
      provider: price.provider,
      model: price.model,
      phase: price.phase,
      currency: 'USD',
      unit: price.unit,
      upperMicrosPerUnit: price.upper,
      validFrom: now,
      validUntil: now + validDays * DAY,
      version: 1,
    });
}
const priceRows = (f: ReturnType<typeof fixture>) =>
  f.store.all<{
    id: string;
    provider: string;
    phase: string;
    valid_from: number;
    valid_until: number;
    version: number;
  }>('SELECT * FROM web_provider_prices ORDER BY provider,phase,valid_from');

test('renew appends contiguous, non-overlapping rows, keeps the old rows byte for byte, and a retry adds nothing', (t) => {
  const f = fixture(t);
  seedInitialPrices(f);
  const before = priceRows(f);
  const first = renewProviderPrices(f.store as never, now + DAY);
  assert.deepEqual(
    first.map((r) => r.result),
    PROVIDER_PRICES.map(() => 'renewed'),
  );
  const after = priceRows(f);
  assert.equal(after.length, before.length * 2 + NEW_PROVIDER_ROWS);
  for (const row of before)
    assert.deepEqual(
      after.find((r) => r.id === row.id),
      row,
      'existing rows are untouched',
    );
  for (const old of initialRows(before)) {
    const next = after.find((r) => r.provider === old.provider && r.phase === old.phase && r.version === 2)!;
    assert.equal(next.valid_from, old.valid_until, 'contiguous');
    assert.equal(next.valid_until, old.valid_until + 90 * DAY);
    assert.match(next.id, new RegExp(`^${old.provider}-.+-${old.phase}-${next.valid_from}$`));
  }
  // A retry (even much later, still inside the new window) is not due and adds nothing.
  assert.deepEqual(
    renewProviderPrices(f.store as never, now + DAY).map((r) => r.result),
    PROVIDER_PRICES.map(() => 'not-due'),
  );
  assert.deepEqual(
    renewProviderPrices(f.store as never, now + 29 * DAY).map((r) => r.result),
    PROVIDER_PRICES.map(() => 'not-due'),
  );
  assert.deepEqual(priceRows(f), after);
});

test('renew does nothing for a price that still runs more than 60 days ahead', (t) => {
  const f = fixture(t);
  seedInitialPrices(f, 100);
  const before = priceRows(f);
  const result = renewProviderPrices(f.store as never, now);
  assert.ok(
    result
      .filter((r) => INITIAL_PROVIDERS.has(r.provider))
      .every((r) => r.result === 'not-due' && r.validFrom === null),
  );
  assert.deepEqual(initialRows(priceRows(f)), before);
  // At exactly 60 days left it is due.
  assert.ok(renewProviderPrices(f.store as never, now + 40 * DAY).every((r) => r.result === 'renewed'));
});

test('an already expired price gets a row that starts now, and the expired row is left as it was', (t) => {
  const f = fixture(t);
  seedInitialPrices(f);
  const before = priceRows(f);
  const later = now + 45 * DAY;
  assert.ok(renewProviderPrices(f.store as never, later).every((r) => r.result === 'renewed' && r.validFrom === later));
  const added = priceRows(f).filter((r) => r.version === 2);
  assert.equal(added.length, initialRows([...PROVIDER_PRICES]).length, 'one new version per seeded price');
  assert.ok(added.every((r) => r.valid_from === later && r.valid_until === later + 90 * DAY));
  assert.deepEqual(
    initialRows(priceRows(f)).filter((r) => r.version === 1),
    before,
  );
});

test('Part 21b: renew creates the spending bound, the capacity ticket and the first price rows for a model with no rows yet', (t) => {
  const f = fixture(t);
  seedInitialPrices(f);
  const before = priceRows(f);
  assert.equal(f.store.get("SELECT 1 FROM web_provider_spending WHERE provider='xai'"), undefined);
  renewProviderPrices(f.store as never, now + DAY);
  for (const price of PROVIDER_PRICES.filter((item) => !INITIAL_PROVIDERS.has(item.provider))) {
    const rows = priceRows(f).filter((r) => r.provider === price.provider && r.phase === price.phase);
    assert.equal(rows.length, 1, `${price.provider} ${price.phase}`);
    assert.equal(rows[0]!.version, 1);
    assert.equal(rows[0]!.valid_from, now + DAY, 'starts now: there was no row to continue from');
    assert.equal(rows[0]!.valid_until, now + DAY + 90 * DAY);
    assert.ok(f.store.get('SELECT 1 FROM web_provider_spending WHERE provider=?', price.provider));
    assert.ok(
      f.store.get(
        "SELECT 1 FROM web_external_budgets WHERE provider=? AND stage='text' AND phase=?",
        price.provider,
        price.phase,
      ),
    );
  }
  // The same bound policy as DeepSeek, and the first renewal left every existing row alone.
  assert.equal(
    f.store.get<{ limit_micros: number }>("SELECT limit_micros FROM web_provider_spending WHERE provider='gemini'")!
      .limit_micros,
    3_000_000,
  );
  for (const row of before)
    assert.deepEqual(
      priceRows(f).find((r) => r.id === row.id),
      row,
    );
  // And a second run adds nothing.
  const after = priceRows(f);
  renewProviderPrices(f.store as never, now + DAY);
  assert.deepEqual(priceRows(f), after);
});

test('a reply admitted just before the old row ends and one just after both price correctly; without renewal the later one fails', (t) => {
  const draft = PROVIDER_PRICES[0];
  const end = now + 50_000;
  const reserveAt = (time: number, renew: boolean) => {
    const f = fixture(t);
    for (const provider of ['deepseek', 'fish']) f.ledger.configureBudget(provider, 3_000_000);
    f.ledger.configurePrice({
      id: 'old-draft',
      provider: draft.provider,
      model: draft.model,
      phase: 'draft',
      currency: 'USD',
      unit: 'token',
      upperMicrosPerUnit: draft.upper,
      validFrom: now,
      validUntil: end,
      version: 1,
    });
    if (renew) renewProviderPrices(f.store as never, now + 10_000);
    new WebProviderOffline(f.store, { now: () => time }).reserve({
      ...f.input('draft'),
      provider: draft.provider,
      model: draft.model,
    });
    return f.store.get<{ price_id: string; held_micros: number }>(
      'SELECT price_id,held_micros FROM web_provider_attempts',
    )!;
  };
  const before = reserveAt(end - 1, true),
    after = reserveAt(end, true);
  assert.equal(before.price_id, 'old-draft');
  assert.match(after.price_id, new RegExp(`^deepseek-.+-draft-${end}$`));
  assert.equal(before.held_micros, after.held_micros, 'the renewed row carries the same upper price');
  // Without a renewal the price has simply ended: the same failure as before this Part.
  assert.throws(() => reserveAt(end, false), /WEB_PROVIDER_PRICE_REQUIRED/);
});

// ---- Part 21i: the Drama 3 ledger price (50 micros per byte from the day renew-prices installs it) ----------------------------

test('Part 21i: renew-prices installs drama-3 at 50 micros/byte as a NEW version from now; the 15 row is never edited; s2.1-pro stays 15', (t) => {
  const f = fixture(t);
  for (const provider of INITIAL_PROVIDERS) f.ledger.configureBudget(provider, 3_000_000);
  // A deployment whose drama-3 row (15) still runs 80 days: renewal is not due, but the price changed.
  f.ledger.configurePrice({
    id: 'fish-drama-3-speech-old',
    provider: 'fish',
    model: 'drama-3',
    phase: 'speech',
    currency: 'USD',
    unit: 'byte',
    upperMicrosPerUnit: 15,
    validFrom: now,
    validUntil: now + 80 * DAY,
    version: 1,
  });
  const old = priceRows(f).find((r) => r.id === 'fish-drama-3-speech-old')!;
  const deploy = now + 10_000;
  const result = renewProviderPrices(f.store as never, deploy);
  const drama = result.find((r) => r.model === 'drama-3')!;
  assert.deepEqual([drama.result, drama.validFrom], ['renewed', deploy]);
  assert.equal(drama.validUntil, deploy + 90 * DAY, 'it runs at least as long as the row it supersedes');
  assert.deepEqual(
    priceRows(f).find((r) => r.id === 'fish-drama-3-speech-old'),
    old,
    'the past row is byte for byte what it was',
  );
  const rows = f.store.all<{ id: string; upper_micros_per_unit: number; version: number }>(
    "SELECT * FROM web_provider_prices WHERE model='drama-3' ORDER BY version",
  );
  assert.deepEqual(
    rows.map((r) => [r.version, r.upper_micros_per_unit]),
    [
      [1, 15],
      [2, 50],
    ],
  );
  // A retry changes nothing.
  assert.equal(renewProviderPrices(f.store as never, deploy).find((r) => r.model === 'drama-3')!.result, 'not-due');
  assert.equal(f.store.all("SELECT 1 FROM web_provider_prices WHERE model='drama-3'").length, 2);

  // Reservations: before the deploy the old row prices it, from the deploy the new one; mixed ASCII/Chinese text is never understated.
  const text = '[soft and gentle, unhurried, tender] 你好呀，今天过得怎么样？ok';
  const bytes = Buffer.byteLength(text),
    characters = [...text].length;
  assert.ok(bytes > characters, 'the sample is mixed ASCII and Chinese');
  const reserve = (time: number, model: string, ordinal: number) => {
    new WebProviderOffline(f.store, { now: () => time }).reserve({
      ...f.input('speech', ordinal),
      provider: 'fish',
      model,
      maxUnits: bytes,
    });
    return f.store.get<{ price_id: string; held_micros: number }>(
      'SELECT price_id,held_micros FROM web_provider_attempts WHERE phase=? AND ordinal=?',
      'speech',
      ordinal,
    )!;
  };
  assert.equal(
    reserve(deploy - 1, 'drama-3', 0).held_micros,
    bytes * 15,
    'before the deploy the old row still prices it',
  );
  const after = reserve(deploy, 'drama-3', 1);
  assert.equal(after.held_micros, bytes * 50);
  assert.ok(after.held_micros >= 50 * characters, 'at least 50 per character');
  assert.match(after.price_id, new RegExp(`^fish-drama-3-speech-${deploy}$`));
  assert.equal(reserve(deploy, 's2.1-pro', 2).held_micros, bytes * 15, 's2.1-pro is unchanged');
});

test('Part 21i: a fresh deployment prices drama-3 at 50 from the first row; an overlapping row that is not a newer version is still refused', (t) => {
  const f = fixture(t);
  seedInitialPrices(f);
  const drama = priceRows(f).filter((r) => r.id.startsWith('fish-drama-3-speech'));
  assert.equal(drama.length, 1);
  assert.equal(PROVIDER_PRICES.find((p) => p.model === 'drama-3')!.upper, 50);
  assert.equal(
    f.store.get<{ u: number }>("SELECT upper_micros_per_unit u FROM web_provider_prices WHERE model='drama-3'")!.u,
    50,
  );
  const again = (version: number, from: number) => () =>
    f.ledger.configurePrice({
      id: `x-${version}-${from}`,
      provider: 'fish',
      model: 'drama-3',
      phase: 'speech',
      currency: 'USD',
      unit: 'byte',
      upperMicrosPerUnit: 60,
      validFrom: from,
      validUntil: from + DAY,
      version,
    });
  assert.throws(again(1, now + DAY), /PRICE_OVERLAP|UNIQUE|SQLITE|constraint/i, 'same version inside an existing row');
  again(2, now + DAY)();
});

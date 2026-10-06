import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WebAdmission } from '../../../apps/server/admission/web-admission.ts';
import { WebDispatchLedger } from '../../../apps/server/budget/web-dispatch-ledger.ts';
import { WebIdentity } from '../../../apps/server/identity/web-identity.ts';
import { WebStageQueue } from '../../../apps/server/admission/web-stage-queue.ts';
import { WebStore } from '../../../apps/server/platform/store.ts';

const candidate = {
  narrative: ['合成一', '合成二'],
  inputVersion: 'i1',
  characterVersion: 'c1',
  templateVersion: 't1',
  voiceVersion: 'v1',
  accessRevision: 1,
  usage: { fake: true },
};

function fixture(t: test.TestContext) {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'web-voice-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, 'instance'),
    instanceId = randomUUID();
  const store = new WebStore(root, { create: true, instanceId });
  t.after(() => store.close());
  store.migrateStages();
  store.migrateAdmissionOrder();
  store.migrateIdentity(randomUUID());
  store.migrateDispatchLedger();
  let now = 1_700_000_000_000,
    sequence = 0;
  const clock = { now: () => now },
    nextId = () => `voice-${++sequence}`;
  const admission = new WebAdmission(store, clock, nextId),
    queue = new WebStageQueue(store, clock, nextId);
  const ledger = new WebDispatchLedger(store, clock);
  store.run('INSERT INTO character_templates(id,version,config_json) VALUES (?,?,?)', 'character', 1, '{}');
  function guest(name: string) {
    const playerId = `player-${name}`,
      worldId = `world-${name}`,
      principalId = `principal-${name}`;
    store.transaction(() => {
      store.run('INSERT INTO api_players VALUES (?,?)', playerId, now);
      store.run('INSERT INTO worlds VALUES (?,?,?,?)', worldId, playerId, 'Asia/Singapore', '{}');
      store.run("INSERT INTO world_characters VALUES (?,?,'new')", worldId, 'character');
    });
    admission.registerGuest({ principalId, playerId, worldId });
    return principalId;
  }
  function admit(principalId: string, requestId: string) {
    return admission.admit({
      principalId,
      requestId,
      characterId: 'character',
      text: requestId,
      ipHash: principalId
        .padEnd(64, 'a')
        .slice(0, 64)
        .replace(/[^a-f0-9]/g, 'b'),
    });
  }
  return {
    store,
    root,
    instanceId,
    clock,
    admission,
    queue,
    ledger,
    guest,
    admit,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function completeFakeSegment(
  f: ReturnType<typeof fixture>,
  claim: NonNullable<ReturnType<WebStageQueue['claimAudio']>>,
  requestId: string,
) {
  const key = f.ledger.reserve(claim, {
    phase: 'speech',
    ordinal: claim.ordinal!,
    provider: 'fake',
    providerRequestId: requestId,
  });
  f.ledger.markSent(claim, key);
  return f.ledger.confirm(key, { outcome: 'succeeded', receipt: { synthetic: requestId }, usage: { fake: 1 } });
}

test('105 migration copies a terminal UNKNOWN attempt/budget and seeds a safe text-ready candidate', (t) => {
  const f = fixture(t),
    oldPrincipal = f.guest('old'),
    newPrincipal = f.guest('new');
  const old = f.admit(oldPrincipal, 'old');
  f.ledger.configureBudget({ provider: 'fake', stage: 'audio', phase: 'speech', capacity: 2 });
  const coordinator = f.queue.acquireCoordinator('coordinator');
  const oldText = f.queue.claimText(coordinator, 'text')!;
  f.queue.completeText(oldText, candidate);
  const oldAudio = f.queue.claimAudio(coordinator, 'audio')!;
  const key = f.ledger.reserve(oldAudio, {
    phase: 'speech',
    ordinal: 0,
    provider: 'fake',
    providerRequestId: 'prior-call',
  });
  f.ledger.markSent(oldAudio, key);
  f.ledger.terminate(coordinator, f.ledger.fence(old.operationId), oldPrincipal, 'cancelled', 'cancel');
  const prior = f.store.get<Record<string, unknown>>(
    'SELECT * FROM web_external_attempts WHERE operation_id=?',
    old.operationId,
  )!;
  const budget = f.store.get<{ reserved: number }>(
    "SELECT reserved FROM web_external_budgets WHERE stage='audio'",
  )!.reserved;
  const waiting = f.admit(newPrincipal, 'new');
  const newText = f.queue.claimText(coordinator, 'text')!;
  f.ledger.configureBudget({ provider: 'fake', stage: 'text', phase: 'draft', capacity: 2 });
  const draft = f.ledger.reserve(newText, {
    phase: 'draft',
    ordinal: -1,
    provider: 'fake',
    providerRequestId: 'known-call',
  });
  f.ledger.markSent(newText, draft);
  f.ledger.confirm(draft, {
    outcome: 'succeeded',
    receipt: { syntheticId: 'receipt-1' },
    usage: { syntheticTokens: 7 },
  });
  const known = f.store.get<Record<string, unknown>>(
    'SELECT * FROM web_external_attempts WHERE operation_id=?',
    waiting.operationId,
  )!;
  f.queue.completeText(newText, candidate);
  const before = f.store.get<{ audio_queued_at: number; deadline_at: number; ip_window_id: string }>(
    'SELECT audio_queued_at,deadline_at,ip_window_id FROM web_operations WHERE id=?',
    waiting.operationId,
  )!;
  f.store.migrateSyntheticVoiceQueue();
  assert.equal(f.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 105);
  assert.deepEqual(
    {
      ...f.store.get<Record<string, unknown>>(
        'SELECT * FROM web_external_attempts WHERE operation_id=?',
        old.operationId,
      ),
    },
    { ...prior },
  );
  assert.deepEqual(
    {
      ...f.store.get<Record<string, unknown>>(
        'SELECT * FROM web_external_attempts WHERE operation_id=?',
        waiting.operationId,
      ),
    },
    { ...known },
  );
  assert.equal(
    f.store.get<{ reserved: number }>("SELECT reserved FROM web_external_budgets WHERE stage='audio'")?.reserved,
    budget,
  );
  const after = f.store.get<{
    audio_wait_used_ms: number;
    audio_wait_started_at: number;
    deadline_at: number;
    ip_window_id: string;
  }>(
    'SELECT audio_wait_used_ms,audio_wait_started_at,deadline_at,ip_window_id FROM web_operations WHERE id=?',
    waiting.operationId,
  )!;
  assert.deepEqual(
    { ...after },
    {
      audio_wait_used_ms: 0,
      audio_wait_started_at: before.audio_queued_at,
      deadline_at: before.deadline_at,
      ip_window_id: before.ip_window_id,
    },
  );
  assert.deepEqual(
    f.store
      .all<{ ordinal: number; text_digest: string; voice_version: string }>(
        'SELECT ordinal,text_digest,voice_version FROM web_synthetic_voice_segments WHERE operation_id=? ORDER BY ordinal',
        waiting.operationId,
      )
      .map((row) => ({ ...row })),
    candidate.narrative.map((body, ordinal) => ({
      ordinal,
      text_digest: createHash('sha256').update(body).digest('hex'),
      voice_version: 'v1',
    })),
  );
  const reopened = new WebStore(f.root, { create: false, instanceId: f.instanceId });
  t.after(() => reopened.close());
  assert.equal(reopened.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 105);
  const identity = new WebIdentity(reopened, {
    origin: 'https://web.example.test',
    cookieName: '__Host-build_session',
    clock: f.clock,
    keys: { keyId: 'synthetic', sealKey: Buffer.alloc(32, 1), requestKey: Buffer.alloc(32, 2) },
  });
  assert.ok(identity.bootstrap().principalId);
  const nextPrincipal = f.guest('after');
  assert.equal(f.admit(nextPrincipal, 'after').status, 'queued');
  assert.ok(f.queue.claimText(coordinator, 'text-after'));
  assert.throws(() => f.admission.finalize(old.operationId, 'cancelled'), /WEB_DISPATCH_FENCE_REQUIRED/);
});

test('105 refuses unknown old audio wait or unexpected dependent schema and rolls back', (t) => {
  const f = fixture(t),
    principal = f.guest('a');
  f.admit(principal, 'first');
  const coordinator = f.queue.acquireCoordinator('coordinator');
  const text = f.queue.claimText(coordinator, 'text')!;
  f.queue.completeText(text, candidate);
  const audio = f.queue.claimAudio(coordinator, 'audio')!;
  assert.throws(() => f.store.migrateSyntheticVoiceQueue(), /WEB_SYNTHETIC_VOICE_MIGRATION_UNSAFE/);
  assert.equal(f.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 104);
  f.ledger.terminate(coordinator, f.ledger.fence(audio.operationId), principal, 'cancelled', 'cancel');
  f.store.run('CREATE VIEW unknown_attempt_reference AS SELECT * FROM web_external_attempts');
  assert.throws(() => f.store.migrateSyntheticVoiceQueue(), /WEB_SYNTHETIC_VOICE_UNRECOGNIZED_REFERENCE/);
  assert.equal(f.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 104);
  assert.equal(f.store.get('SELECT 1 FROM web_external_attempts LIMIT 1'), undefined);
});

test('105 DDL conflict rolls back added clocks and leaves original attempt schema intact', (t) => {
  const f = fixture(t);
  f.store.run('CREATE TABLE web_synthetic_voice_segments(x TEXT)');
  assert.throws(() => f.store.migrateSyntheticVoiceQueue(), /already exists/);
  assert.equal(f.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 104);
  assert.equal(
    f.store.get("SELECT 1 FROM pragma_table_info('web_operations') WHERE name='audio_wait_used_ms'"),
    undefined,
  );
  assert.ok(f.store.get("SELECT 1 FROM sqlite_master WHERE name='web_external_attempts'"));
  assert.equal(f.store.get("SELECT 1 FROM sqlite_master WHERE name='web_external_attempts_next'"), undefined);
});

test('105 refuses a mismatched external ticket without rewriting the old budget', (t) => {
  const f = fixture(t);
  f.ledger.configureBudget({ provider: 'fake', stage: 'audio', phase: 'speech', capacity: 2 });
  f.store.run("UPDATE web_external_budgets SET reserved=1 WHERE provider='fake'");
  assert.throws(() => f.store.migrateSyntheticVoiceQueue(), /WEB_SYNTHETIC_VOICE_BUDGET_MISMATCH/);
  assert.equal(f.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 104);
  assert.equal(f.store.get<{ reserved: number }>('SELECT reserved FROM web_external_budgets')?.reserved, 1);
});

test('105 first audio claim persists waiting time and reserves only its matching ordinal', (t) => {
  const f = fixture(t),
    principal = f.guest('a');
  const input = f.admit(principal, 'first');
  const coordinator = f.queue.acquireCoordinator('coordinator'),
    text = f.queue.claimText(coordinator, 'text')!;
  f.queue.completeText(text, candidate);
  f.store.migrateSyntheticVoiceQueue();
  f.ledger.configureBudget({ provider: 'fake', stage: 'audio', phase: 'speech', capacity: 1 });
  f.advance(20_000);
  const audio = f.queue.claimAudio(coordinator, 'audio')!;
  assert.equal(audio.ordinal, 0);
  assert.equal(audio.textDigest, createHash('sha256').update(candidate.narrative[0]!).digest('hex'));
  assert.equal(
    f.store.get<{ audio_wait_used_ms: number; audio_wait_started_at: number | null }>(
      'SELECT audio_wait_used_ms,audio_wait_started_at FROM web_operations WHERE id=?',
      input.operationId,
    )?.audio_wait_used_ms,
    20_000,
  );
  assert.throws(
    () => f.ledger.reserve(audio, { phase: 'speech', ordinal: 1, provider: 'fake', providerRequestId: 'wrong' }),
    /WEB_VOICE_SEGMENT_STALE/,
  );
  f.ledger.reserve(audio, { phase: 'speech', ordinal: 0, provider: 'fake', providerRequestId: 'correct' });
  assert.equal(f.queue.claimAudio(coordinator, 'audio'), null);
});

test('105 first-wait boundary expires at exactly sixty seconds without refreshing the original window', (t) => {
  const f = fixture(t),
    principal = f.guest('a');
  const input = f.admit(principal, 'first');
  const initial = f.queue.acquireCoordinator('first'),
    text = f.queue.claimText(initial, 'text')!;
  f.queue.completeText(text, candidate);
  f.store.migrateSyntheticVoiceQueue();
  const original = f.store.get<{ ip_window_id: string; deadline_at: number }>(
    'SELECT ip_window_id,deadline_at FROM web_operations WHERE id=?',
    input.operationId,
  )!;
  f.advance(60_000);
  const current = f.queue.acquireCoordinator('current');
  assert.equal(f.queue.claimAudio(current, 'audio'), null);
  assert.deepEqual(f.ledger.terminate(current, f.ledger.fence(input.operationId), principal, 'failed', 'expired'), {
    status: 'failed',
    duplicate: false,
  });
  assert.equal(
    f.store.get<{ reserved: number }>('SELECT reserved FROM web_ip_windows WHERE id=?', original.ip_window_id)
      ?.reserved,
    0,
  );
  assert.equal(
    f.store.get<{ deadline_at: number }>('SELECT deadline_at FROM web_operations WHERE id=?', input.operationId)
      ?.deadline_at,
    original.deadline_at,
  );
});

test('first segment may run seventy seconds; next segment uses remaining wait and all-fake completion stays private', (t) => {
  const f = fixture(t),
    principal = f.guest('a');
  const input = f.admit(principal, 'first');
  let coordinator = f.queue.acquireCoordinator('first');
  f.queue.completeText(f.queue.claimText(coordinator, 'text')!, candidate);
  f.store.migrateSyntheticVoiceQueue();
  f.ledger.configureBudget({ provider: 'fake', stage: 'audio', phase: 'speech', capacity: 2 });
  f.advance(1_000);
  const first = f.queue.claimAudio(coordinator, 'audio')!;
  const key = f.ledger.reserve(first, { phase: 'speech', ordinal: 0, provider: 'fake', providerRequestId: 'first' });
  f.ledger.markSent(first, key);
  for (let i = 0; i < 3; i++) {
    f.advance(20_000);
    coordinator = f.queue.renewCoordinator(coordinator);
  }
  f.advance(10_000);
  assert.deepEqual(f.ledger.confirm(key, { outcome: 'succeeded', receipt: { synthetic: 'first' }, usage: {} }), {
    duplicate: false,
  });
  const stageAfterFirst = f.store.get<{ stage_version: number }>(
    'SELECT stage_version FROM web_operations WHERE id=?',
    input.operationId,
  )!.stage_version;
  assert.deepEqual(f.ledger.confirm(key, { outcome: 'succeeded', receipt: { synthetic: 'first' }, usage: {} }), {
    duplicate: true,
  });
  assert.equal(
    f.store.get<{ stage_version: number }>('SELECT stage_version FROM web_operations WHERE id=?', input.operationId)
      ?.stage_version,
    stageAfterFirst,
  );
  assert.equal(
    f.store.get<{ state: string }>(
      'SELECT state FROM web_synthetic_voice_segments WHERE operation_id=? AND ordinal=0',
      input.operationId,
    )?.state,
    'synthetic_complete',
  );
  assert.equal(f.ledger.syntheticComplete(input.operationId), false);
  assert.equal(
    f.store.get<{ audio_wait_started_at: number }>(
      'SELECT audio_wait_started_at FROM web_operations WHERE id=?',
      input.operationId,
    )?.audio_wait_started_at,
    f.clock.now(),
  );
  f.advance(19_000);
  const second = f.queue.claimAudio(coordinator, 'audio')!;
  assert.equal(second.ordinal, 1);
  assert.equal(
    f.store.get<{ audio_wait_used_ms: number }>(
      'SELECT audio_wait_used_ms FROM web_operations WHERE id=?',
      input.operationId,
    )?.audio_wait_used_ms,
    20_000,
  );
  completeFakeSegment(f, second, 'second');
  assert.deepEqual(
    f.store
      .all<{ ordinal: number; state: string }>(
        'SELECT ordinal,state FROM web_synthetic_voice_segments WHERE operation_id=? ORDER BY ordinal',
        input.operationId,
      )
      .map((row) => ({ ...row })),
    [
      { ordinal: 0, state: 'synthetic_complete' },
      { ordinal: 1, state: 'synthetic_complete' },
    ],
  );
  assert.deepEqual(
    {
      ...f.store.get<{ status: string; audio_wait_started_at: number | null }>(
        'SELECT status,audio_wait_started_at FROM web_operations WHERE id=?',
        input.operationId,
      ),
    },
    { status: 'audio_pending', audio_wait_started_at: null },
  );
  assert.equal(f.ledger.syntheticComplete(input.operationId), true);
  assert.equal(f.queue.claimAudio(coordinator, 'audio'), null);
  f.admit(principal, 'next');
  assert.equal(
    f.queue.claimText(coordinator, 'text'),
    null,
    'unfinished synthetic round still owns the active pipeline',
  );
  assert.equal(f.store.get<{ n: number }>("SELECT count(*) n FROM messages WHERE author_kind='character'")?.n, 0);
});

test('synthetic completion and known external receipt roll back together on segment write failure', (t) => {
  const f = fixture(t),
    principal = f.guest('a');
  const input = f.admit(principal, 'first');
  const coordinator = f.queue.acquireCoordinator('coordinator');
  f.queue.completeText(f.queue.claimText(coordinator, 'text')!, candidate);
  f.store.migrateSyntheticVoiceQueue();
  f.ledger.configureBudget({ provider: 'fake', stage: 'audio', phase: 'speech', capacity: 1 });
  const claim = f.queue.claimAudio(coordinator, 'audio')!;
  const key = f.ledger.reserve(claim, { phase: 'speech', ordinal: 0, provider: 'fake', providerRequestId: 'first' });
  f.ledger.markSent(claim, key);
  f.store.db.exec(`CREATE TRIGGER synthetic_fail BEFORE UPDATE OF state ON web_synthetic_voice_segments
    WHEN NEW.state='synthetic_complete' BEGIN SELECT RAISE(ABORT,'synthetic completion failure'); END`);
  assert.throws(
    () => f.ledger.confirm(key, { outcome: 'succeeded', receipt: {}, usage: {} }),
    /synthetic completion failure/,
  );
  assert.equal(
    f.store.get<{ dispatch_state: string }>('SELECT dispatch_state FROM web_external_attempts')?.dispatch_state,
    'sent',
  );
  assert.equal(f.store.get<{ reserved: number }>('SELECT reserved FROM web_external_budgets')?.reserved, 1);
  assert.equal(
    f.store.get<{ state: string }>(
      'SELECT state FROM web_synthetic_voice_segments WHERE operation_id=? AND ordinal=0',
      input.operationId,
    )?.state,
    'running',
  );
  assert.equal(
    f.store.get<{ status: string }>('SELECT status FROM web_operations WHERE id=?', input.operationId)?.status,
    'audio_running',
  );
  f.store.db.exec('DROP TRIGGER synthetic_fail');
  f.ledger.confirm(key, { outcome: 'succeeded', receipt: {}, usage: {} });
  assert.equal(f.store.get<{ reserved: number }>('SELECT reserved FROM web_external_budgets')?.reserved, 0);
});

test('tampered segment digest cannot be sent or completed, while a late receipt never revives terminal work', (t) => {
  const f = fixture(t),
    principal = f.guest('a');
  const input = f.admit(principal, 'first');
  const coordinator = f.queue.acquireCoordinator('coordinator');
  f.queue.completeText(f.queue.claimText(coordinator, 'text')!, candidate);
  f.store.migrateSyntheticVoiceQueue();
  f.ledger.configureBudget({ provider: 'fake', stage: 'audio', phase: 'speech', capacity: 1 });
  const claim = f.queue.claimAudio(coordinator, 'audio')!;
  const key = f.ledger.reserve(claim, { phase: 'speech', ordinal: 0, provider: 'fake', providerRequestId: 'first' });
  f.store.run(
    "UPDATE web_synthetic_voice_segments SET text_digest='tampered' WHERE operation_id=? AND ordinal=0",
    input.operationId,
  );
  assert.throws(() => f.ledger.markSent(claim, key), /WEB_VOICE_SEGMENT_STALE/);
  assert.equal(
    f.store.get<{ dispatch_state: string }>('SELECT dispatch_state FROM web_external_attempts')?.dispatch_state,
    'not_sent',
  );
  f.store.run(
    'UPDATE web_synthetic_voice_segments SET text_digest=? WHERE operation_id=? AND ordinal=0',
    claim.textDigest!,
    input.operationId,
  );
  f.ledger.markSent(claim, key);
  f.ledger.terminate(coordinator, f.ledger.fence(input.operationId), principal, 'cancelled', 'cancel');
  assert.deepEqual(f.ledger.confirm(key, { outcome: 'succeeded', receipt: {}, usage: {} }), { duplicate: false });
  assert.equal(
    f.store.get<{ status: string }>('SELECT status FROM web_operations WHERE id=?', input.operationId)?.status,
    'cancelled',
  );
  assert.equal(
    f.store.get<{ state: string }>(
      'SELECT state FROM web_synthetic_voice_segments WHERE operation_id=? AND ordinal=0',
      input.operationId,
    )?.state,
    'running',
  );
  assert.equal(f.ledger.syntheticComplete(input.operationId), false);
});

test('two audio waits totaling sixty seconds expire even though running time is excluded', (t) => {
  const f = fixture(t),
    principal = f.guest('a');
  const input = f.admit(principal, 'first');
  let coordinator = f.queue.acquireCoordinator('first');
  f.queue.completeText(f.queue.claimText(coordinator, 'text')!, candidate);
  f.store.migrateSyntheticVoiceQueue();
  f.ledger.configureBudget({ provider: 'fake', stage: 'audio', phase: 'speech', capacity: 1 });
  f.advance(20_000);
  coordinator = f.queue.renewCoordinator(coordinator);
  f.advance(15_000);
  const first = f.queue.claimAudio(coordinator, 'audio')!;
  const key = f.ledger.reserve(first, { phase: 'speech', ordinal: 0, provider: 'fake', providerRequestId: 'first' });
  f.ledger.markSent(first, key);
  f.advance(10_000);
  coordinator = f.queue.renewCoordinator(coordinator);
  f.advance(25_000);
  f.ledger.confirm(key, { outcome: 'succeeded', receipt: {}, usage: {} });
  assert.equal(
    f.store.get<{ audio_wait_used_ms: number }>(
      'SELECT audio_wait_used_ms FROM web_operations WHERE id=?',
      input.operationId,
    )?.audio_wait_used_ms,
    35_000,
  );
  coordinator = f.queue.renewCoordinator(coordinator);
  f.advance(25_000);
  assert.equal(f.queue.claimAudio(coordinator, 'audio'), null);
  assert.deepEqual(f.ledger.terminate(coordinator, f.ledger.fence(input.operationId), principal, 'failed', 'expired'), {
    status: 'failed',
    duplicate: false,
  });
  assert.equal(f.store.get<{ reserved: number }>('SELECT reserved FROM web_ip_windows')?.reserved, 0);
});

test('completed first segment survives reconnect and epoch; sent second segment becomes UNKNOWN without re-send', (t) => {
  const f = fixture(t),
    principal = f.guest('a');
  const input = f.admit(principal, 'first');
  const initial = f.queue.acquireCoordinator('initial');
  f.queue.completeText(f.queue.claimText(initial, 'text')!, candidate);
  f.store.migrateSyntheticVoiceQueue();
  f.ledger.configureBudget({ provider: 'fake', stage: 'audio', phase: 'speech', capacity: 1 });
  const first = f.queue.claimAudio(initial, 'audio')!;
  f.advance(10_000);
  completeFakeSegment(f, first, 'first');
  const otherStore = new WebStore(f.root, { create: false, instanceId: f.instanceId });
  t.after(() => otherStore.close());
  const otherQueue = new WebStageQueue(otherStore, f.clock, randomUUID);
  const otherLedger = new WebDispatchLedger(otherStore, f.clock);
  f.advance(21_000);
  const next = otherQueue.acquireCoordinator('next');
  const second = otherQueue.claimAudio(next, 'audio')!;
  assert.equal(second.ordinal, 1);
  assert.equal(
    otherStore.get<{ state: string }>(
      'SELECT state FROM web_synthetic_voice_segments WHERE operation_id=? AND ordinal=0',
      input.operationId,
    )?.state,
    'synthetic_complete',
  );
  const key = otherLedger.reserve(second, {
    phase: 'speech',
    ordinal: 1,
    provider: 'fake',
    providerRequestId: 'second',
  });
  otherLedger.markSent(second, key);
  const fence = otherLedger.fence(input.operationId);
  f.advance(31_000);
  const takeover = otherQueue.acquireCoordinator('takeover');
  assert.equal(otherLedger.recover(takeover, fence).status, 'unknown');
  assert.equal(otherStore.get<{ reserved: number }>('SELECT reserved FROM web_external_budgets')?.reserved, 1);
  assert.equal(
    otherStore.get<{ state: string }>(
      'SELECT state FROM web_synthetic_voice_segments WHERE operation_id=? AND ordinal=0',
      input.operationId,
    )?.state,
    'synthetic_complete',
  );
  assert.equal(
    otherStore.get<{ n: number }>(
      'SELECT count(*) n FROM web_external_attempts WHERE operation_id=?',
      input.operationId,
    )?.n,
    2,
  );
  f.advance(238_000);
  const final = otherQueue.acquireCoordinator('final');
  otherLedger.terminate(final, otherLedger.fence(input.operationId), principal, 'failed', 'expired');
  assert.equal(otherStore.get<{ reserved: number }>('SELECT reserved FROM web_external_budgets')?.reserved, 1);
  assert.equal(otherStore.get<{ reserved: number }>('SELECT reserved FROM web_ip_windows')?.reserved, 0);
});

test('registration during synthetic generation preserves original operation and quota, without footer or publication', async (t) => {
  const f = fixture(t);
  const identity = new WebIdentity(f.store, {
    origin: 'https://web.example.test',
    cookieName: '__Host-build_session',
    clock: f.clock,
    keys: { keyId: 'synthetic', sealKey: Buffer.alloc(32, 1), requestKey: Buffer.alloc(32, 2) },
  });
  const guest = identity.bootstrap(),
    token = guest.issuedToken!;
  const worldId = f.store.get<{ world_id: string }>(
    'SELECT world_id FROM web_principals WHERE id=?',
    guest.principalId,
  )!.world_id;
  f.store.run("INSERT INTO world_characters VALUES (?,'character','new')", worldId);
  const input = f.admit(guest.principalId, 'first');
  const before = f.store.get<{
    principal_id: string;
    world_id: string;
    ip_window_id: string;
    input_message_id: string;
    deadline_at: number;
  }>('SELECT * FROM web_operations WHERE id=?', input.operationId)!;
  const coordinator = f.queue.acquireCoordinator('coordinator');
  f.queue.completeText(f.queue.claimText(coordinator, 'text')!, candidate);
  f.store.migrateSyntheticVoiceQueue();
  f.ledger.configureBudget({ provider: 'fake', stage: 'audio', phase: 'speech', capacity: 1 });
  const audio = f.queue.claimAudio(coordinator, 'audio')!;
  const key = f.ledger.reserve(audio, {
    phase: 'speech',
    ordinal: 0,
    provider: 'fake',
    providerRequestId: 'before-upgrade',
  });
  f.ledger.markSent(audio, key);
  await identity.register(token, guest.csrf, 'https://web.example.test', {
    requestId: 'register',
    username: 'SyntheticUser',
    password: 'synthetic-password-only',
  });
  f.ledger.confirm(key, { outcome: 'succeeded', receipt: { synthetic: true }, usage: {} });
  const after = f.store.get<typeof before>('SELECT * FROM web_operations WHERE id=?', input.operationId)!;
  assert.deepEqual(
    {
      principal_id: after.principal_id,
      world_id: after.world_id,
      ip_window_id: after.ip_window_id,
      input_message_id: after.input_message_id,
      deadline_at: after.deadline_at,
    },
    {
      principal_id: before.principal_id,
      world_id: before.world_id,
      ip_window_id: before.ip_window_id,
      input_message_id: before.input_message_id,
      deadline_at: before.deadline_at,
    },
  );
  assert.equal(
    f.store.get<{ kind: string; trial_reserved: number }>(
      'SELECT kind,trial_reserved FROM web_principals WHERE id=?',
      guest.principalId,
    )?.kind,
    'account',
  );
  assert.equal(
    f.store.get<{ trial_reserved: number }>('SELECT trial_reserved FROM web_principals WHERE id=?', guest.principalId)
      ?.trial_reserved,
    1,
  );
  assert.equal(f.store.get<{ reserved: number }>('SELECT reserved FROM web_ip_windows')?.reserved, 1);
  assert.equal(f.store.get<{ n: number }>("SELECT count(*) n FROM messages WHERE author_kind='character'")?.n, 0);
  assert.throws(() => f.admission.finalize(input.operationId, 'failed'), /WEB_DISPATCH_FENCE_REQUIRED/);
});

test('four audio slots are independent of text; completing one lets the next principal run first', (t) => {
  const f = fixture(t);
  const principals = ['a', 'b', 'c', 'd', 'e'].map(f.guest);
  for (const [index, principal] of principals.entries()) f.admit(principal, `r${index}`);
  const coordinator = f.queue.acquireCoordinator('coordinator');
  for (let i = 0; i < principals.length; i++) f.queue.completeText(f.queue.claimText(coordinator, 'text')!, candidate);
  f.store.migrateSyntheticVoiceQueue();
  f.ledger.configureBudget({ provider: 'fake', stage: 'audio', phase: 'speech', capacity: 4 });
  const claims = Array.from({ length: 4 }, () => f.queue.claimAudio(coordinator, 'audio')!);
  assert.deepEqual(
    claims.map((claim) => claim.principalId),
    principals.slice(0, 4),
  );
  assert.equal(f.queue.claimAudio(coordinator, 'audio'), null);
  completeFakeSegment(f, claims[0]!, 'first');
  assert.equal(f.queue.claimAudio(coordinator, 'audio')?.principalId, principals[4]);
  assert.equal(f.store.get<{ n: number }>("SELECT count(*) n FROM web_operations WHERE status='audio_running'")?.n, 4);
});

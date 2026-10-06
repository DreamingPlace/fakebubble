import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { constants as sqliteConstants, type DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { WebAdmission } from '../../../apps/server/admission/web-admission.ts';
import { WebDispatchLedger } from '../../../apps/server/budget/web-dispatch-ledger.ts';
import { WebIdentity } from '../../../apps/server/identity/web-identity.ts';
import { WebStageQueue } from '../../../apps/server/admission/web-stage-queue.ts';
import { WebStore } from '../../../apps/server/platform/store.ts';

const base = 1_700_000_000_000;
const candidate = {
  narrative: ['合成甲', '合成乙', '合成丙'],
  inputVersion: 'input-v1',
  characterVersion: 'character-v1',
  templateVersion: 'template-v1',
  voiceVersion: 'voice-v1',
  accessRevision: 1,
  usage: { synthetic: true },
};
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const ip = (n: number) => n.toString(16).padStart(64, '0');

function fixture(t: test.TestContext) {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'web-c-b1a-'));
  const root = join(parent, 'web'),
    instanceId = randomUUID();
  const store = new WebStore(root, { create: true, instanceId });
  t.after(() => {
    store.close();
    rmSync(parent, { recursive: true, force: true });
  });
  store.migrateStages();
  store.migrateAdmissionOrder();
  store.migrateIdentity(randomUUID());
  store.migrateDispatchLedger();
  let now = base;
  const clock = { now: () => now };
  const admission = new WebAdmission(store, clock, randomUUID);
  const queue = new WebStageQueue(store, clock, randomUUID);
  const ledger = new WebDispatchLedger(store, clock);
  store.run('INSERT INTO character_templates(id,version,config_json) VALUES (?,?,?)', 'character', 1, '{}');
  function guest(name: string) {
    const playerId = `player-${name}`,
      worldId = `world-${name}`,
      principalId = `principal-${name}`;
    store.transaction(() => {
      store.run('INSERT INTO api_players VALUES (?,?)', playerId, now);
      store.run('INSERT INTO worlds VALUES (?,?,?,?)', worldId, playerId, 'UTC', '{}');
      store.run("INSERT INTO world_characters VALUES (?,?,'new')", worldId, 'character');
    });
    admission.registerGuest({ principalId, playerId, worldId });
    return principalId;
  }
  function admit(principalId: string, requestId: string, number = 1) {
    return admission.admit({ principalId, requestId, characterId: 'character', text: requestId, ipHash: ip(number) });
  }
  return {
    root,
    instanceId,
    store,
    clock,
    admission,
    queue,
    ledger,
    guest,
    admit,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}

function assert104(f: ReturnType<typeof fixture>) {
  assert.equal(f.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 104);
  assert.equal(
    f.store.get("SELECT 1 FROM pragma_table_info('web_operations') WHERE name='audio_wait_used_ms'"),
    undefined,
  );
  assert.equal(f.store.get("SELECT 1 FROM sqlite_master WHERE name='web_synthetic_voice_segments'"), undefined);
  assert.equal(f.store.get("SELECT 1 FROM sqlite_master WHERE name='web_external_attempts_next'"), undefined);
}

test('C-B1a 105 migration preserves every known/UNKNOWN attempt column, external ticket, scoped input and account', async (t) => {
  const f = fixture(t),
    origin = 'https://verify.example.test';
  const keys = { keyId: 'synthetic', sealKey: Buffer.alloc(32, 3), requestKey: Buffer.alloc(32, 4) };
  const identity = new WebIdentity(f.store, { origin, cookieName: '__Host-verify_session', keys, clock: f.clock });
  const bootstrap = identity.bootstrap(),
    guestToken = bootstrap.issuedToken!;
  const principal = bootstrap.principalId;
  const world = f.store.get<{ world_id: string }>(
    'SELECT world_id FROM web_principals WHERE id=?',
    principal,
  )!.world_id;
  f.store.run("INSERT INTO world_characters VALUES (?,?,'new')", world, 'character');
  const op = f.admit(principal, 'input-b1a', 7);
  const other = f.guest('other'),
    op2 = f.admit(other, 'input-other', 8);
  const registration = { requestId: 'register-b1a', username: 'owner_b1a', password: 'synthetic-password' };
  const account = await identity.register(guestToken, bootstrap.csrf, origin, registration);
  const coordinator = f.queue.acquireCoordinator('coordinator');
  f.ledger.configureBudget({ provider: 'fake', stage: 'text', phase: 'draft', capacity: 2 });
  const first = f.queue.claimText(coordinator, 'text-1')!;
  const knownKey = f.ledger.reserve(first, {
    phase: 'draft',
    ordinal: -1,
    provider: 'fake',
    providerRequestId: 'known-b1a',
  });
  f.ledger.markSent(first, knownKey);
  f.ledger.confirm(knownKey, { outcome: 'succeeded', receipt: { receipt: 'known' }, usage: { tokens: 7 } });
  f.queue.completeText(first, candidate);
  const second = f.queue.claimText(coordinator, 'text-2')!;
  const unknownKey = f.ledger.reserve(second, {
    phase: 'draft',
    ordinal: -1,
    provider: 'fake',
    providerRequestId: 'unknown-b1a',
  });
  f.ledger.markSent(second, unknownKey);
  f.ledger.terminate(coordinator, f.ledger.fence(op2.operationId), other, 'cancelled', 'cancel');
  const beforeAttempts = f.store
    .all<Record<string, unknown>>('SELECT * FROM web_external_attempts ORDER BY operation_id')
    .map((row) => ({ ...row }));
  const beforeBudgets = f.store
    .all<Record<string, unknown>>('SELECT * FROM web_external_budgets')
    .map((row) => ({ ...row }));
  const beforeOperations = f.store
    .all<Record<string, unknown>>('SELECT * FROM web_operations ORDER BY id')
    .map((row) => ({ ...row }));
  const beforeInputs = f.store
    .all<Record<string, unknown>>(
      'SELECT * FROM messages WHERE id IN (?,?) ORDER BY id',
      op.inputMessageId,
      op2.inputMessageId,
    )
    .map((row) => ({ ...row }));
  const beforeWindows = f.store
    .all<Record<string, unknown>>('SELECT * FROM web_ip_windows ORDER BY id')
    .map((row) => ({ ...row }));
  const beforeSession = f.store.get<Record<string, unknown>>(
    'SELECT * FROM web_sessions WHERE account_id IS NOT NULL',
  )!;
  const ordinary = new WebStore(f.root, { create: false, instanceId: f.instanceId });
  assert.equal(ordinary.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 104);
  ordinary.close();
  f.store.migrateSyntheticVoiceQueue();
  assert.equal(f.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 105);
  assert.deepEqual(
    f.store
      .all<Record<string, unknown>>('SELECT * FROM web_external_attempts ORDER BY operation_id')
      .map((row) => ({ ...row })),
    beforeAttempts,
  );
  assert.deepEqual(
    f.store.all<Record<string, unknown>>('SELECT * FROM web_external_budgets').map((row) => ({ ...row })),
    beforeBudgets,
  );
  const afterOperations = f.store
    .all<Record<string, unknown>>('SELECT * FROM web_operations ORDER BY id')
    .map((row) => ({ ...row }));
  assert.deepEqual(
    afterOperations.map((row) =>
      Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith('audio_wait_'))),
    ),
    beforeOperations,
  );
  assert.deepEqual(
    f.store
      .all<Record<string, unknown>>(
        'SELECT * FROM messages WHERE id IN (?,?) ORDER BY id',
        op.inputMessageId,
        op2.inputMessageId,
      )
      .map((row) => ({ ...row })),
    beforeInputs,
  );
  assert.deepEqual(
    f.store.all<Record<string, unknown>>('SELECT * FROM web_ip_windows ORDER BY id').map((row) => ({ ...row })),
    beforeWindows,
  );
  assert.deepEqual(
    { ...f.store.get<Record<string, unknown>>('SELECT * FROM web_sessions WHERE account_id IS NOT NULL') },
    { ...beforeSession },
  );
  assert.deepEqual(identity.authenticate(account.issuedToken).principalId, principal);
  const segmentRows = f.store.all<{ ordinal: number; text_digest: string; voice_version: string }>(
    'SELECT ordinal,text_digest,voice_version FROM web_synthetic_voice_segments WHERE operation_id=? ORDER BY ordinal',
    op.operationId,
  );
  assert.deepEqual(
    segmentRows.map((row) => ({ ...row })),
    candidate.narrative.map((text, ordinal) => ({
      ordinal,
      text_digest: digest(text),
      voice_version: candidate.voiceVersion,
    })),
  );
  assert.throws(() => f.admission.finalize(op.operationId, 'failed'), /WEB_DISPATCH_FENCE_REQUIRED/);
});

test('C-B1a later migration trigger failure rolls back old attempts, clocks and version', (t) => {
  const f = fixture(t),
    principal = f.guest('trigger'),
    op = f.admit(principal, 'input');
  f.ledger.configureBudget({ provider: 'fake', stage: 'text', phase: 'draft', capacity: 1 });
  const coordinator = f.queue.acquireCoordinator('coordinator'),
    claim = f.queue.claimText(coordinator, 'text')!;
  const key = f.ledger.reserve(claim, {
    phase: 'draft',
    ordinal: -1,
    provider: 'fake',
    providerRequestId: 'trigger-request',
  });
  f.ledger.markSent(claim, key);
  f.ledger.terminate(coordinator, f.ledger.fence(op.operationId), principal, 'cancelled', 'cancel');
  const before = f.store.get<Record<string, unknown>>('SELECT * FROM web_external_attempts')!;
  f.store.run(`CREATE TRIGGER reject_voice_wait BEFORE UPDATE OF audio_wait_used_ms ON web_operations
    BEGIN SELECT RAISE(ABORT,'injected late migration failure'); END`);
  // A terminal old row has no wait clock update, so use a new text-ready row as the late failure point.
  const ready = f.admit(principal, 'ready');
  const text = f.queue.claimText(coordinator, 'text-ready')!;
  assert.equal(text.operationId, ready.operationId);
  f.queue.completeText(text, candidate);
  assert.throws(() => f.store.migrateSyntheticVoiceQueue(), /injected late migration failure/);
  assert104(f);
  assert.deepEqual({ ...f.store.get<Record<string, unknown>>('SELECT * FROM web_external_attempts') }, { ...before });
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_reviewed_candidates')?.n, 1);
  assert.equal(f.store.get<{ reserved: number }>('SELECT reserved FROM web_external_budgets')?.reserved, 1);
});

test('C-B1a unsafe running, missing wait origin, unexpected reference and bad ticket all refuse without erasure', (t) => {
  const f = fixture(t),
    principal = f.guest('unsafe'),
    op = f.admit(principal, 'input');
  const coordinator = f.queue.acquireCoordinator('coordinator'),
    text = f.queue.claimText(coordinator, 'text')!;
  f.queue.completeText(text, candidate);
  const audio = f.queue.claimAudio(coordinator, 'audio')!;
  assert.throws(() => f.store.migrateSyntheticVoiceQueue(), /WEB_SYNTHETIC_VOICE_MIGRATION_UNSAFE/);
  assert104(f);
  f.ledger.terminate(coordinator, f.ledger.fence(op.operationId), principal, 'cancelled', 'cancel');
  const ready = f.admit(principal, 'ready'),
    newText = f.queue.claimText(coordinator, 'text-2')!;
  f.queue.completeText(newText, candidate);
  f.store.run('UPDATE web_operations SET audio_queued_at=audio_queued_at+1 WHERE id=?', ready.operationId);
  assert.throws(() => f.store.migrateSyntheticVoiceQueue(), /WEB_SYNTHETIC_VOICE_MIGRATION_UNSAFE/);
  assert104(f);
  f.store.run('UPDATE web_operations SET audio_queued_at=audio_queued_at-1 WHERE id=?', ready.operationId);
  f.store.run('CREATE VIEW unexpected_reference AS SELECT operation_id FROM web_external_attempts');
  assert.throws(() => f.store.migrateSyntheticVoiceQueue(), /WEB_SYNTHETIC_VOICE_UNRECOGNIZED_REFERENCE/);
  assert104(f);
  f.store.run('DROP VIEW unexpected_reference');
  f.ledger.configureBudget({ provider: 'fake', stage: 'audio', phase: 'speech', capacity: 2 });
  f.store.run("UPDATE web_external_budgets SET reserved=1 WHERE provider='fake'");
  assert.throws(() => f.store.migrateSyntheticVoiceQueue(), /WEB_SYNTHETIC_VOICE_BUDGET_MISMATCH/);
  assert104(f);
  assert.equal(f.store.get<{ reserved: number }>('SELECT reserved FROM web_external_budgets')?.reserved, 1);
  assert.ok(audio);
});

test('C-B1a persistent wait, remaining deadline clamp, spoofed claim and ordinal do not dispatch', (t) => {
  const f = fixture(t),
    principal = f.guest('wait'),
    op = f.admit(principal, 'input');
  const coordinator = f.queue.acquireCoordinator('coordinator'),
    text = f.queue.claimText(coordinator, 'text')!;
  f.queue.completeText(text, candidate);
  f.store.migrateSyntheticVoiceQueue();
  f.ledger.configureBudget({ provider: 'fake', stage: 'audio', phase: 'speech', capacity: 1 });
  f.store.run('UPDATE web_operations SET deadline_at=? WHERE id=?', base + 90_000, op.operationId);
  f.advance(59_999);
  const reopened = new WebStore(f.root, { create: false, instanceId: f.instanceId });
  t.after(() => reopened.close());
  const afterRestart = new WebStageQueue(reopened, f.clock, randomUUID);
  const renewed = afterRestart.acquireCoordinator('restarted');
  const claim = afterRestart.claimAudio(renewed, 'audio')!;
  assert.equal(claim.operationId, op.operationId);
  assert.equal(claim.ordinal, 0);
  assert.equal(claim.textDigest, digest(candidate.narrative[0]!));
  assert.equal(claim.voiceVersion, candidate.voiceVersion);
  assert.equal(claim.deadlineAt, base + 90_000);
  assert.equal(claim.leaseExpiresAt, Math.min(f.now() + 120_000, claim.deadlineAt));
  assert.equal(
    reopened.get<{ audio_wait_used_ms: number; audio_wait_started_at: number | null }>(
      'SELECT audio_wait_used_ms,audio_wait_started_at FROM web_operations WHERE id=?',
      op.operationId,
    )?.audio_wait_used_ms,
    59_999,
  );
  assert.equal(
    reopened.get<{ audio_wait_started_at: number | null }>(
      'SELECT audio_wait_started_at FROM web_operations WHERE id=?',
      op.operationId,
    )?.audio_wait_started_at,
    null,
  );
  const afterLedger = new WebDispatchLedger(reopened, f.clock);
  const spoof = { ...claim, textDigest: digest('wrong') };
  assert.throws(
    () => afterLedger.reserve(spoof, { phase: 'speech', ordinal: 0, provider: 'fake', providerRequestId: 'spoof' }),
    /WEB_VOICE_SEGMENT_STALE/,
  );
  assert.throws(
    () => afterLedger.reserve(claim, { phase: 'speech', ordinal: 1, provider: 'fake', providerRequestId: 'ordinal' }),
    /WEB_VOICE_SEGMENT_STALE/,
  );
  assert.throws(
    () =>
      afterLedger.reserve(
        { ...claim, token: 'wrong' },
        { phase: 'speech', ordinal: 0, provider: 'fake', providerRequestId: 'token' },
      ),
    /WEB_STAGE_STALE/,
  );
  assert.equal(reopened.get<{ n: number }>('SELECT count(*) n FROM web_external_attempts')?.n, 0);
  assert.equal(reopened.get<{ reserved: number }>('SELECT reserved FROM web_external_budgets')?.reserved, 0);
  const key = afterLedger.reserve(claim, {
    phase: 'speech',
    ordinal: 0,
    provider: 'fake',
    providerRequestId: 'correct',
  });
  assert.throws(() => afterLedger.markSent(spoof, key), /WEB_VOICE_SEGMENT_STALE/);
  assert.equal(
    reopened.get<{ dispatch_state: string }>('SELECT dispatch_state FROM web_external_attempts')?.dispatch_state,
    'not_sent',
  );
  afterLedger.markSent(claim, key);
});

test('C-B1a four audio slots are independent of queued same-principal admission', (t) => {
  const f = fixture(t),
    principals = Array.from({ length: 5 }, (_, i) => f.guest(`slot-${i}`));
  const operations = principals.map((principal, i) => f.admit(principal, `input-${i}`, i + 1));
  const coordinator = f.queue.acquireCoordinator('coordinator');
  for (let i = 0; i < 5; i++) {
    const text = f.queue.claimText(coordinator, `text-${i}`)!;
    assert.ok(text);
    f.queue.completeText(text, candidate);
  }
  f.store.migrateSyntheticVoiceQueue();
  const extra = f.admit(principals[0]!, 'queued-behind-audio', 9);
  assert.equal(extra.status, 'queued');
  const claims = Array.from({ length: 4 }, (_, i) => f.queue.claimAudio(coordinator, `audio-${i}`)!);
  assert.equal(claims.filter(Boolean).length, 4);
  assert.equal(new Set(claims.map((claim) => claim.principalId)).size, 4);
  assert.equal(f.queue.claimAudio(coordinator, 'fifth'), null);
  assert.equal(f.store.get<{ n: number }>("SELECT count(*) n FROM web_operations WHERE status='audio_running'")?.n, 4);
  assert.equal(
    f.store.get<{ status: string }>('SELECT status FROM web_operations WHERE id=?', extra.operationId)?.status,
    'queued',
  );
  assert.ok(operations.some((op) => claims.some((claim) => claim.operationId === op.operationId)));
});

test('C-B1a exactly sixty seconds of audio wait expires after restart without a new window', (t) => {
  const f = fixture(t),
    principal = f.guest('boundary'),
    op = f.admit(principal, 'input');
  const old = f.queue.acquireCoordinator('first'),
    text = f.queue.claimText(old, 'text')!;
  f.queue.completeText(text, candidate);
  f.store.migrateSyntheticVoiceQueue();
  const original = f.ledger.fence(op.operationId);
  f.advance(60_000);
  const reopened = new WebStore(f.root, { create: false, instanceId: f.instanceId });
  t.after(() => reopened.close());
  const newQueue = new WebStageQueue(reopened, f.clock, randomUUID);
  const newLedger = new WebDispatchLedger(reopened, f.clock);
  const coordinator = newQueue.acquireCoordinator('second');
  assert.equal(newQueue.claimAudio(coordinator, 'audio'), null);
  assert.deepEqual(newLedger.terminate(coordinator, newLedger.fence(op.operationId), principal, 'failed', 'expired'), {
    status: 'failed',
    duplicate: false,
  });
  assert.equal(
    reopened.get<{ reserved: number }>('SELECT reserved FROM web_ip_windows WHERE id=?', original.ipWindowId)?.reserved,
    0,
  );
  assert.equal(
    reopened.get<{ deadline_at: number }>('SELECT deadline_at FROM web_operations WHERE id=?', op.operationId)
      ?.deadline_at,
    original.deadlineAt,
  );
});

test('C-B1a denied DROP of old attempt table rolls back copied table and added clocks', (t) => {
  const f = fixture(t),
    db = (f.store as unknown as { db: DatabaseSync }).db;
  db.setAuthorizer((action, name) =>
    action === sqliteConstants.SQLITE_DROP_TABLE && name === 'web_external_attempts'
      ? sqliteConstants.SQLITE_DENY
      : sqliteConstants.SQLITE_OK,
  );
  try {
    assert.throws(() => f.store.migrateSyntheticVoiceQueue(), /not authorized/);
  } finally {
    db.setAuthorizer(null);
  }
  assert104(f);
  assert.ok(f.store.get("SELECT 1 FROM sqlite_master WHERE name='web_external_attempts'"));
});

test('C-B1a denied rename after DROP rolls the original attempt table back into place', (t) => {
  const f = fixture(t),
    db = (f.store as unknown as { db: DatabaseSync }).db;
  db.setAuthorizer((action, schema, table) =>
    action === sqliteConstants.SQLITE_ALTER_TABLE && schema === 'main' && table === 'web_external_attempts_next'
      ? sqliteConstants.SQLITE_DENY
      : sqliteConstants.SQLITE_OK,
  );
  try {
    assert.throws(() => f.store.migrateSyntheticVoiceQueue(), /not authorized/);
  } finally {
    db.setAuthorizer(null);
  }
  assert104(f);
  assert.ok(f.store.get("SELECT 1 FROM sqlite_master WHERE name='web_external_attempts'"));
});

test('C-B1a foreign-key audit failure after rename rolls the replacement table back', (t) => {
  const f = fixture(t),
    db = (f.store as unknown as { db: DatabaseSync }).db;
  f.ledger.configureBudget({ provider: 'fake', stage: 'text', phase: 'draft', capacity: 1 });
  db.exec('PRAGMA foreign_keys=OFF');
  f.store.run(
    `INSERT INTO web_external_attempts(operation_id,stage,phase,ordinal,provider,provider_request_id,
    dispatch_state,stage_version,lease_epoch,lease_token,principal_id,world_id,conversation_id,input_message_id,created_at,sent_at)
    VALUES ('missing-operation','text','draft',-1,'fake','orphan-request','sent',1,1,'token','principal','world',
    'conversation','message',?,?)`,
    base,
    base,
  );
  f.store.run("UPDATE web_external_budgets SET reserved=1 WHERE provider='fake'");
  assert.throws(() => f.store.migrateSyntheticVoiceQueue(), /WEB_SYNTHETIC_VOICE_FOREIGN_KEY_INVALID/);
  assert104(f);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_external_attempts')?.n, 1);
  assert.equal(f.store.get<{ reserved: number }>('SELECT reserved FROM web_external_budgets')?.reserved, 1);
});

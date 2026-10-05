import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WebAdmission } from '../../../apps/server/web-admission.ts';
import { WebDispatchLedger } from '../../../apps/server/web-dispatch-ledger.ts';
import { WebIdentity } from '../../../apps/server/web-identity.ts';
import { WebStageQueue } from '../../../apps/server/web-stage-queue.ts';
import { WebStore } from '../../../apps/server/store.ts';

function fixture(t: test.TestContext) {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'web-snapshot-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, 'instance'),
    instanceId = randomUUID();
  const store = new WebStore(root, { create: true, instanceId });
  t.after(() => store.close());
  store.migrateStages();
  store.migrateAdmissionOrder();
  store.migrateIdentity(randomUUID());
  store.migrateDispatchLedger();
  store.migrateSyntheticVoiceQueue();
  let now = 1_700_000_000_000,
    sequence = 0;
  const clock = { now: () => now },
    nextId = () => `snap-${++sequence}`;
  const admission = new WebAdmission(store, clock, nextId);
  const queue = new WebStageQueue(store, clock, nextId);
  const ledger = new WebDispatchLedger(store, clock);
  store.run('INSERT INTO character_templates VALUES (\'character\',1,\'{"name":"synthetic"}\')');
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
  function admit(principalId: string, requestId: string, text = requestId) {
    return admission.admit({ principalId, requestId, characterId: 'character', text, ipHash: 'a'.repeat(64) });
  }
  return {
    store,
    root,
    instanceId,
    clock,
    nextId,
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

function scope(claim: NonNullable<ReturnType<WebStageQueue['claimText']>>) {
  return {
    operation_id: claim.operationId,
    principal_id: claim.principalId,
    world_id: claim.worldId,
    conversation_id: claim.conversationId,
    character_id: claim.characterId,
    input_message_id: claim.inputMessageId,
  };
}

test('106 freezes only the claimed input, checks scope, and reopens unchanged', (t) => {
  const f = fixture(t),
    principal = f.guest('a');
  const first = f.admit(principal, 'first', '先发输入');
  f.admit(principal, 'later', '后排队输入');
  f.store.migrateInputSnapshot();
  assert.equal(f.admit(principal, 'third', '106新输入').status, 'queued');
  const coordinator = f.queue.acquireCoordinator('coordinator');
  const claim = f.queue.claimText(coordinator, 'worker')!;
  assert.equal(claim.operationId, first.operationId);
  const frozen = f.queue.inputSnapshot(scope(claim));
  assert.equal(frozen.capability, 'input-snapshot-only');
  assert.equal(frozen.input_body, '先发输入');
  assert.equal(frozen.template_version, 1);
  assert.equal(frozen.access_revision, 4, 'all three admissions incremented principal revision');
  assert.equal(frozen.frozen_at, f.clock.now());
  assert.equal(frozen.input_digest.length, 64);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_input_snapshots')?.n, 1);
  assert.throws(
    () => f.store.run('UPDATE web_input_snapshots SET input_body=? WHERE operation_id=?', 'later', claim.operationId),
    /WEB_INPUT_SNAPSHOT_IMMUTABLE/,
  );
  for (const bad of [
    { principal_id: 'principal-other' },
    { world_id: 'world-other' },
    { conversation_id: 'conversation-other' },
    { character_id: 'other' },
    { input_message_id: 'later' },
  ])
    assert.throws(() => f.queue.inputSnapshot({ ...scope(claim), ...bad }), /WEB_INPUT_SNAPSHOT_NOT_FOUND/);
  const reopened = new WebStore(f.root, { create: false, instanceId: f.instanceId });
  t.after(() => reopened.close());
  const otherQueue = new WebStageQueue(reopened, f.clock, f.nextId);
  assert.deepEqual({ ...otherQueue.inputSnapshot(scope(claim)) }, { ...frozen });
  const identity = new WebIdentity(reopened, {
    origin: 'https://web.example.test',
    cookieName: '__Host-snapshot_session',
    clock: f.clock,
    keys: { keyId: 'fake', sealKey: Buffer.alloc(32, 1), requestKey: Buffer.alloc(32, 2) },
  });
  assert.ok(identity.bootstrap().principalId);
});

test('106 text dispatch and fake candidate require current source and matching digest', (t) => {
  const f = fixture(t),
    principal = f.guest('a');
  f.admit(principal, 'first');
  f.store.migrateInputSnapshot();
  const coordinator = f.queue.acquireCoordinator('coordinator');
  const claim = f.queue.claimText(coordinator, 'worker')!;
  const frozen = f.queue.inputSnapshot(scope(claim));
  f.ledger.configureBudget({ provider: 'fake', stage: 'text', phase: 'draft', capacity: 2 });
  const fake = {
    narrative: ['合成候选'],
    inputVersion: frozen.input_digest,
    characterVersion: String(frozen.template_version),
    templateVersion: frozen.template_digest,
    voiceVersion: 'synthetic-voice',
    accessRevision: frozen.access_revision,
    usage: { fake: true },
  };
  assert.throws(() => f.queue.completeText(claim, { ...fake, inputVersion: 'i1' }), /WEB_CANDIDATE_SNAPSHOT_MISMATCH/);
  const key = f.ledger.reserve(claim, { phase: 'draft', ordinal: -1, provider: 'fake', providerRequestId: 'fake-1' });
  f.ledger.markSent(claim, key);
  f.ledger.confirm(key, { outcome: 'succeeded', receipt: { fake: 1 }, usage: { fake: 1 } });
  f.queue.completeText(claim, fake);
  assert.equal(
    f.store.get<{ input_version: string }>(
      'SELECT input_version FROM web_reviewed_candidates WHERE operation_id=?',
      claim.operationId,
    )?.input_version,
    frozen.input_digest,
  );
  f.ledger.configureBudget({ provider: 'fake', stage: 'audio', phase: 'speech', capacity: 1 });
  const audio = f.queue.claimAudio(coordinator, 'audio-worker')!;
  const speech = f.ledger.reserve(audio, {
    phase: 'speech',
    ordinal: 0,
    provider: 'fake',
    providerRequestId: 'fake-audio',
  });
  f.ledger.markSent(audio, speech);
  f.ledger.confirm(speech, { outcome: 'succeeded', receipt: { fake: true }, usage: { fake: 1 } });
  assert.equal(f.ledger.syntheticComplete(claim.operationId), true);
});

test('106 stale message/template blocks dispatch but upgrade does not rewrite or automatically cancel snapshot', (t) => {
  const f = fixture(t),
    principal = f.guest('a');
  f.admit(principal, 'first');
  f.store.migrateInputSnapshot();
  const claim = f.queue.claimText(f.queue.acquireCoordinator('coordinator'), 'worker')!;
  const frozen = f.queue.inputSnapshot(scope(claim));
  f.ledger.configureBudget({ provider: 'fake', stage: 'text', phase: 'draft', capacity: 2 });
  f.store.run("UPDATE web_principals SET kind='account',revision=revision+1 WHERE id=?", principal);
  assert.deepEqual({ ...f.queue.inputSnapshot(scope(claim)) }, { ...frozen });
  const key = f.ledger.reserve(claim, { phase: 'draft', ordinal: -1, provider: 'fake', providerRequestId: 'fake-1' });
  f.store.run("UPDATE messages SET body='mutated' WHERE id=?", claim.inputMessageId);
  assert.throws(() => f.ledger.markSent(claim, key), /WEB_INPUT_SNAPSHOT_STALE/);
  f.store.run('UPDATE messages SET body=? WHERE id=?', frozen.input_body, claim.inputMessageId);
  f.store.run("UPDATE character_templates SET version=2,config_json='{}' WHERE id='character'");
  assert.throws(() => f.ledger.markSent(claim, key), /WEB_INPUT_SNAPSHOT_STALE/);
  f.store.run(
    'UPDATE character_templates SET version=?,config_json=? WHERE id=?',
    frozen.template_version,
    frozen.template_json,
    claim.characterId,
  );
  f.ledger.markSent(claim, key);
  f.ledger.confirm(key, { outcome: 'succeeded', receipt: { fake: true }, usage: { fake: 1 } });
  f.store.run("UPDATE character_templates SET version=2,config_json='{}' WHERE id='character'");
  assert.throws(
    () =>
      f.queue.completeText(claim, {
        narrative: ['fake'],
        inputVersion: frozen.input_digest,
        characterVersion: String(frozen.template_version),
        templateVersion: frozen.template_digest,
        voiceVersion: 'fake',
        accessRevision: frozen.access_revision,
        usage: { fake: 1 },
      }),
    /WEB_INPUT_SNAPSHOT_STALE/,
  );
  assert.deepEqual({ ...f.queue.inputSnapshot(scope(claim)) }, { ...frozen });
});

test('106 missing snapshot or wrong original message cannot dispatch', (t) => {
  const f = fixture(t),
    principal = f.guest('a');
  f.admit(principal, 'first');
  f.store.migrateInputSnapshot();
  const claim = f.queue.claimText(f.queue.acquireCoordinator('coordinator'), 'worker')!;
  f.ledger.configureBudget({ provider: 'fake', stage: 'text', phase: 'draft', capacity: 1 });
  f.store.run('DROP TRIGGER web_input_snapshots_no_delete');
  f.store.run('DELETE FROM web_input_snapshots WHERE operation_id=?', claim.operationId);
  assert.throws(
    () => f.ledger.reserve(claim, { phase: 'draft', ordinal: -1, provider: 'fake', providerRequestId: 'not-sent' }),
    /WEB_INPUT_SNAPSHOT_NOT_FOUND/,
  );
  assert.throws(
    () =>
      f.queue.completeText(claim, {
        narrative: ['fake'],
        inputVersion: 'fake',
        characterVersion: '1',
        templateVersion: 'fake',
        voiceVersion: 'fake',
        accessRevision: 1,
        usage: { fake: 1 },
      }),
    /WEB_INPUT_SNAPSHOT_NOT_FOUND/,
  );
  assert.equal(
    f.store.get<{ reserved: number }>("SELECT reserved FROM web_external_budgets WHERE provider='fake'")?.reserved,
    0,
  );
});

test('106 audio dispatch also refuses changed frozen source without erasing candidate', (t) => {
  const f = fixture(t),
    principal = f.guest('a');
  f.admit(principal, 'first');
  f.store.migrateInputSnapshot();
  const coordinator = f.queue.acquireCoordinator('coordinator');
  const text = f.queue.claimText(coordinator, 'text-worker')!;
  const frozen = f.queue.inputSnapshot(scope(text));
  f.queue.completeText(text, {
    narrative: ['synthetic'],
    inputVersion: frozen.input_digest,
    characterVersion: String(frozen.template_version),
    templateVersion: frozen.template_digest,
    voiceVersion: 'fake',
    accessRevision: frozen.access_revision,
    usage: { fake: 1 },
  });
  const audio = f.queue.claimAudio(coordinator, 'audio-worker')!;
  f.ledger.configureBudget({ provider: 'fake', stage: 'audio', phase: 'speech', capacity: 1 });
  f.store.run("UPDATE character_templates SET version=2,config_json='{}' WHERE id='character'");
  assert.throws(
    () => f.ledger.reserve(audio, { phase: 'speech', ordinal: 0, provider: 'fake', providerRequestId: 'not-sent' }),
    /WEB_INPUT_SNAPSHOT_STALE/,
  );
  assert.equal(
    f.store.get<{ reserved: number }>("SELECT reserved FROM web_external_budgets WHERE provider='fake'")?.reserved,
    0,
  );
  assert.equal(
    f.store.get('SELECT 1 FROM web_reviewed_candidates WHERE operation_id=?', text.operationId) !== undefined,
    true,
  );
});

test('106 refuses a claim whose original player message no longer belongs to its scope', (t) => {
  const f = fixture(t),
    principal = f.guest('a'),
    operation = f.admit(principal, 'first');
  f.store.migrateInputSnapshot();
  const coordinator = f.queue.acquireCoordinator('coordinator');
  f.store.run("UPDATE messages SET author_id='other-player' WHERE id=?", operation.inputMessageId);
  assert.throws(() => f.queue.claimText(coordinator, 'worker'), /WEB_INPUT_SNAPSHOT_SOURCE_INVALID/);
  assert.equal(
    f.store.get<{ status: string }>('SELECT status FROM web_operations WHERE id=?', operation.operationId)?.status,
    'queued',
  );
  assert.equal(f.store.get('SELECT 1 FROM web_input_snapshots WHERE operation_id=?', operation.operationId), undefined);
  f.store.run("UPDATE messages SET author_id='player-a' WHERE id=?", operation.inputMessageId);
  assert.equal(f.queue.claimText(coordinator, 'worker')?.operationId, operation.operationId);
});

test('106 migration rejects unsafe active state and DDL failure rolls back without changing 105', (t) => {
  const f = fixture(t),
    principal = f.guest('a');
  f.admit(principal, 'first');
  const coordinator = f.queue.acquireCoordinator('coordinator');
  const claim = f.queue.claimText(coordinator, 'worker')!;
  assert.throws(() => f.store.migrateInputSnapshot(), /WEB_INPUT_SNAPSHOT_MIGRATION_UNSAFE/);
  assert.equal(f.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 105);
  f.ledger.terminate(coordinator, f.ledger.fence(claim.operationId), principal, 'cancelled', 'cancel');
  f.store.run('CREATE TABLE web_input_snapshots(x TEXT)');
  assert.throws(() => f.store.migrateInputSnapshot(), /already exists/);
  assert.equal(f.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 105);
  assert.equal(
    f.store.get<{ status: string }>('SELECT status FROM web_operations WHERE id=?', claim.operationId)?.status,
    'cancelled',
  );
});

test('106 late DDL collision rolls back a table created earlier in the same migration', (t) => {
  const f = fixture(t),
    principal = f.guest('a'),
    operation = f.admit(principal, 'first');
  f.store.run(`CREATE TRIGGER web_input_snapshots_no_update BEFORE UPDATE ON web_operations
    BEGIN SELECT 1; END`);
  assert.throws(() => f.store.migrateInputSnapshot(), /already exists/);
  assert.equal(f.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 105);
  assert.equal(f.store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_input_snapshots'"), undefined);
  assert.equal(
    f.store.get<{ status: string }>('SELECT status FROM web_operations WHERE id=?', operation.operationId)?.status,
    'queued',
  );
});

for (const [name, trigger] of [
  [
    'snapshot insert',
    `CREATE TRIGGER fail_claim BEFORE INSERT ON web_input_snapshots
    BEGIN SELECT RAISE(ABORT,'INJECTED_SNAPSHOT_FAILURE'); END`,
  ],
  [
    'operation CAS',
    `CREATE TRIGGER fail_claim BEFORE UPDATE OF status ON web_operations
    WHEN NEW.status='text_running' BEGIN SELECT RAISE(ABORT,'INJECTED_CAS_FAILURE'); END`,
  ],
  [
    'rotation cursor',
    `CREATE TRIGGER fail_claim BEFORE UPDATE OF text_last_principal_id ON web_scheduler_state
    BEGIN SELECT RAISE(ABORT,'INJECTED_CURSOR_FAILURE'); END`,
  ],
] as const)
  test(`106 ${name} failure rolls back snapshot, lease and cursor together`, (t) => {
    const f = fixture(t),
      principal = f.guest('a'),
      operation = f.admit(principal, 'first');
    f.store.migrateInputSnapshot();
    const coordinator = f.queue.acquireCoordinator('coordinator');
    f.store.run(trigger);
    assert.throws(() => f.queue.claimText(coordinator, 'worker'), /INJECTED_.*_FAILURE/);
    assert.equal(
      f.store.get('SELECT 1 FROM web_input_snapshots WHERE operation_id=?', operation.operationId),
      undefined,
    );
    assert.equal(
      f.store.get<{ status: string; stage_version: number }>(
        'SELECT status,stage_version FROM web_operations WHERE id=?',
        operation.operationId,
      )?.status,
      'queued',
    );
    assert.equal(
      f.store.get<{ text_last_principal_id: string | null }>(
        'SELECT text_last_principal_id FROM web_scheduler_state WHERE singleton=1',
      )?.text_last_principal_id,
      null,
    );
    f.store.run('DROP TRIGGER fail_claim');
    assert.equal(f.queue.claimText(coordinator, 'worker')?.operationId, operation.operationId);
  });

test('106 terminal UNKNOWN external receipt and budgets survive migration without backfilled snapshot', (t) => {
  const f = fixture(t),
    principal = f.guest('a'),
    operation = f.admit(principal, 'first');
  const coordinator = f.queue.acquireCoordinator('coordinator');
  const claim = f.queue.claimText(coordinator, 'worker')!;
  f.ledger.configureBudget({ provider: 'fake', stage: 'text', phase: 'draft', capacity: 1 });
  const key = f.ledger.reserve(claim, { phase: 'draft', ordinal: -1, provider: 'fake', providerRequestId: 'old' });
  f.ledger.markSent(claim, key);
  f.ledger.terminate(coordinator, f.ledger.fence(operation.operationId), principal, 'cancelled', 'cancel');
  const before = f.store.get<Record<string, unknown>>(
    'SELECT * FROM web_external_attempts WHERE operation_id=?',
    operation.operationId,
  )!;
  const budget = f.store.get<{ reserved: number }>(
    "SELECT reserved FROM web_external_budgets WHERE provider='fake'",
  )!.reserved;
  f.store.migrateInputSnapshot();
  assert.deepEqual(
    {
      ...f.store.get<Record<string, unknown>>(
        'SELECT * FROM web_external_attempts WHERE operation_id=?',
        operation.operationId,
      ),
    },
    { ...before },
  );
  assert.equal(
    f.store.get<{ reserved: number }>("SELECT reserved FROM web_external_budgets WHERE provider='fake'")?.reserved,
    budget,
  );
  assert.equal(f.store.get('SELECT 1 FROM web_input_snapshots WHERE operation_id=?', operation.operationId), undefined);
});

test('106 current sent draft failure settles both ledgers once and unblocks next queued input', (t) => {
  const f = fixture(t),
    principal = f.guest('a');
  const first = f.admit(principal, 'first'),
    next = f.admit(principal, 'next');
  f.store.migrateInputSnapshot();
  const coordinator = f.queue.acquireCoordinator('coordinator');
  const claim = f.queue.claimText(coordinator, 'worker')!;
  f.ledger.configureBudget({ provider: 'fake', stage: 'text', phase: 'draft', capacity: 1 });
  const key = f.ledger.reserve(claim, {
    phase: 'draft',
    ordinal: -1,
    provider: 'fake',
    providerRequestId: 'failure-1',
  });
  f.ledger.markSent(claim, key);
  const secondConnection = new WebStore(f.root, { create: false, instanceId: f.instanceId });
  t.after(() => secondConnection.close());
  const other = new WebDispatchLedger(secondConnection, f.clock);
  const receipt = { outcome: 'failed' as const, receipt: { fake: 'failed' }, usage: { fake: 3 } };
  assert.deepEqual(other.confirm(key, receipt), { duplicate: false });
  assert.deepEqual(f.ledger.confirm(key, receipt), { duplicate: true });
  assert.throws(
    () => f.ledger.confirm(key, { ...receipt, receipt: { fake: 'conflict' } }),
    /WEB_DISPATCH_RECEIPT_CONFLICT/,
  );
  const terminal = f.store.get<{
    status: string;
    quota_state: string;
    stage_version: number;
    lease_token: string | null;
  }>('SELECT status,quota_state,stage_version,lease_token FROM web_operations WHERE id=?', first.operationId)!;
  assert.deepEqual(
    { ...terminal },
    { status: 'failed', quota_state: 'released', stage_version: claim.stageVersion + 1, lease_token: null },
  );
  assert.equal(f.store.get<{ reserved: number }>('SELECT reserved FROM web_external_budgets')?.reserved, 0);
  assert.equal(
    f.store.get<{ reserved: number }>(
      'SELECT reserved FROM web_ip_windows WHERE id=(SELECT ip_window_id FROM web_operations WHERE id=?)',
      first.operationId,
    )?.reserved,
    1,
    'the next operation retains its own IP reservation',
  );
  assert.equal(
    f.store.get<{ trial_reserved: number }>('SELECT trial_reserved FROM web_principals WHERE id=?', principal)
      ?.trial_reserved,
    1,
  );
  assert.equal(f.queue.claimText(coordinator, 'next-worker')?.operationId, next.operationId);
  assert.equal(f.store.get<{ n: number }>("SELECT count(*) n FROM messages WHERE author_kind='character'")?.n, 0);
});

test('106 review failure and later audio failure preserve known successes and private candidate', (t) => {
  const f = fixture(t),
    principal = f.guest('a');
  f.admit(principal, 'review');
  f.store.migrateInputSnapshot();
  const coordinator = f.queue.acquireCoordinator('coordinator');
  const claim = f.queue.claimText(coordinator, 'worker')!;
  for (const phase of ['draft', 'review'] as const)
    f.ledger.configureBudget({ provider: 'fake', stage: 'text', phase, capacity: 1 });
  const draft = f.ledger.reserve(claim, { phase: 'draft', ordinal: -1, provider: 'fake', providerRequestId: 'draft' });
  f.ledger.markSent(claim, draft);
  f.ledger.confirm(draft, { outcome: 'succeeded', receipt: { fake: 1 }, usage: { fake: 1 } });
  const review = f.ledger.reserve(claim, {
    phase: 'review',
    ordinal: -1,
    provider: 'fake',
    providerRequestId: 'review',
  });
  f.ledger.markSent(claim, review);
  f.ledger.confirm(review, { outcome: 'failed', receipt: { fake: 2 }, usage: { fake: 2 } });
  assert.equal(
    f.store.get<{ status: string }>('SELECT status FROM web_operations WHERE id=?', claim.operationId)?.status,
    'failed',
  );
  assert.equal(
    f.store.get<{ outcome: string }>(
      "SELECT outcome FROM web_external_attempts WHERE operation_id=? AND phase='draft'",
      claim.operationId,
    )?.outcome,
    'succeeded',
  );
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_external_budgets WHERE reserved=0')?.n, 2);

  const next = f.admit(principal, 'audio');
  const text = f.queue.claimText(coordinator, 'worker2')!;
  assert.equal(text.operationId, next.operationId);
  const frozen = f.queue.inputSnapshot(scope(text));
  f.queue.completeText(text, {
    narrative: ['first', 'second'],
    inputVersion: frozen.input_digest,
    characterVersion: String(frozen.template_version),
    templateVersion: frozen.template_digest,
    voiceVersion: 'fake',
    accessRevision: frozen.access_revision,
    usage: { fake: 1 },
  });
  f.ledger.configureBudget({ provider: 'fake', stage: 'audio', phase: 'speech', capacity: 1 });
  const audio0 = f.queue.claimAudio(coordinator, 'audio0')!;
  const speech0 = f.ledger.reserve(audio0, {
    phase: 'speech',
    ordinal: 0,
    provider: 'fake',
    providerRequestId: 'speech0',
  });
  f.ledger.markSent(audio0, speech0);
  f.ledger.confirm(speech0, { outcome: 'succeeded', receipt: { fake: 3 }, usage: { fake: 3 } });
  const audio1 = f.queue.claimAudio(coordinator, 'audio1')!;
  const speech1 = f.ledger.reserve(audio1, {
    phase: 'speech',
    ordinal: 1,
    provider: 'fake',
    providerRequestId: 'speech1',
  });
  f.ledger.markSent(audio1, speech1);
  f.ledger.confirm(speech1, { outcome: 'failed', receipt: { fake: 4 }, usage: { fake: 4 } });
  assert.equal(
    f.store.get<{ status: string }>('SELECT status FROM web_operations WHERE id=?', next.operationId)?.status,
    'failed',
  );
  assert.deepEqual(
    f.store
      .all<{ ordinal: number; state: string }>(
        'SELECT ordinal,state FROM web_synthetic_voice_segments WHERE operation_id=? ORDER BY ordinal',
        next.operationId,
      )
      .map((row) => ({ ...row })),
    [
      { ordinal: 0, state: 'synthetic_complete' },
      { ordinal: 1, state: 'running' },
    ],
  );
  assert.ok(f.store.get('SELECT 1 FROM web_reviewed_candidates WHERE operation_id=?', next.operationId));
  assert.equal(f.store.get<{ n: number }>("SELECT count(*) n FROM messages WHERE author_kind='character'")?.n, 0);
});

test('106 late quota write failure rolls back known receipt, provider ticket and business release', (t) => {
  const f = fixture(t),
    principal = f.guest('a'),
    operation = f.admit(principal, 'first');
  f.store.migrateInputSnapshot();
  const claim = f.queue.claimText(f.queue.acquireCoordinator('coordinator'), 'worker')!;
  f.ledger.configureBudget({ provider: 'fake', stage: 'text', phase: 'draft', capacity: 1 });
  const key = f.ledger.reserve(claim, { phase: 'draft', ordinal: -1, provider: 'fake', providerRequestId: 'failure' });
  f.ledger.markSent(claim, key);
  f.store.run(`CREATE TRIGGER fail_principal_release BEFORE UPDATE OF trial_reserved ON web_principals
    WHEN NEW.trial_reserved<OLD.trial_reserved BEGIN SELECT RAISE(ABORT,'INJECTED_LATE_RELEASE'); END`);
  const receipt = { outcome: 'failed' as const, receipt: { fake: true }, usage: { fake: 1 } };
  assert.throws(() => f.ledger.confirm(key, receipt), /INJECTED_LATE_RELEASE/);
  assert.equal(
    f.store.get<{ dispatch_state: string }>(
      'SELECT dispatch_state FROM web_external_attempts WHERE operation_id=?',
      operation.operationId,
    )?.dispatch_state,
    'sent',
  );
  assert.equal(f.store.get<{ reserved: number }>('SELECT reserved FROM web_external_budgets')?.reserved, 1);
  assert.equal(
    f.store.get<{ status: string; quota_state: string }>(
      'SELECT status,quota_state FROM web_operations WHERE id=?',
      operation.operationId,
    )?.status,
    'text_running',
  );
  assert.equal(
    f.store.get<{ reserved: number }>(
      'SELECT reserved FROM web_ip_windows WHERE id=(SELECT ip_window_id FROM web_operations WHERE id=?)',
      operation.operationId,
    )?.reserved,
    1,
  );
  assert.equal(
    f.store.get<{ trial_reserved: number }>('SELECT trial_reserved FROM web_principals WHERE id=?', principal)
      ?.trial_reserved,
    1,
  );
  f.store.run('DROP TRIGGER fail_principal_release');
  assert.deepEqual(f.ledger.confirm(key, receipt), { duplicate: false });
  assert.equal(
    f.store.get<{ status: string }>('SELECT status FROM web_operations WHERE id=?', operation.operationId)?.status,
    'failed',
  );
});

test('106 timely failed receipt releases original expired IP window, not a newer reservation', (t) => {
  const f = fixture(t),
    early = f.guest('early'),
    principal = f.guest('a'),
    later = f.guest('later');
  const earlyOperation = f.admit(early, 'early');
  const coordinator = f.queue.acquireCoordinator('coordinator');
  f.ledger.terminate(coordinator, f.ledger.fence(earlyOperation.operationId), early, 'cancelled', 'cancel');
  f.advance(24 * 60 * 60_000 - 1_000);
  const current = f.admit(principal, 'current');
  f.store.migrateInputSnapshot();
  // The original coordinator expired during the clock jump; a new epoch claims this operation.
  const fresh = f.queue.acquireCoordinator('fresh');
  const claim = f.queue.claimText(fresh, 'worker')!;
  f.ledger.configureBudget({ provider: 'fake', stage: 'text', phase: 'draft', capacity: 1 });
  const key = f.ledger.reserve(claim, { phase: 'draft', ordinal: -1, provider: 'fake', providerRequestId: 'failed' });
  f.ledger.markSent(claim, key);
  const originalWindow = f.store.get<{ ip_window_id: string }>(
    'SELECT ip_window_id FROM web_operations WHERE id=?',
    current.operationId,
  )!.ip_window_id;
  f.store.run('UPDATE web_ip_windows SET used=1 WHERE id=?', originalWindow);
  f.advance(2_000);
  const newer = f.admit(later, 'later');
  const newWindow = f.store.get<{ ip_window_id: string }>(
    'SELECT ip_window_id FROM web_operations WHERE id=?',
    newer.operationId,
  )!.ip_window_id;
  assert.notEqual(originalWindow, newWindow);
  f.ledger.confirm(key, { outcome: 'failed', receipt: { fake: true }, usage: { fake: 1 } });
  assert.equal(
    f.store.get<{ reserved: number; used: number }>(
      'SELECT reserved,used FROM web_ip_windows WHERE id=?',
      originalWindow,
    )?.reserved,
    0,
  );
  assert.equal(
    f.store.get<{ reserved: number; used: number }>(
      'SELECT reserved,used FROM web_ip_windows WHERE id=?',
      originalWindow,
    )?.used,
    1,
  );
  assert.deepEqual(
    {
      ...f.store.get<{ reserved: number; used: number }>(
        'SELECT reserved,used FROM web_ip_windows WHERE id=?',
        newWindow,
      ),
    },
    { reserved: 1, used: 0 },
  );
});

test('106 cancelled and old-epoch failed receipts settle external ticket but never revive business', (t) => {
  const f = fixture(t),
    a = f.guest('a'),
    b = f.guest('b');
  const first = f.admit(a, 'first'),
    second = f.admit(b, 'second');
  f.store.migrateInputSnapshot();
  const coordinator = f.queue.acquireCoordinator('coordinator');
  const claimA = f.queue.claimText(coordinator, 'a')!,
    claimB = f.queue.claimText(coordinator, 'b')!;
  f.ledger.configureBudget({ provider: 'fake', stage: 'text', phase: 'draft', capacity: 2 });
  const keyA = f.ledger.reserve(claimA, { phase: 'draft', ordinal: -1, provider: 'fake', providerRequestId: 'a' });
  const keyB = f.ledger.reserve(claimB, { phase: 'draft', ordinal: -1, provider: 'fake', providerRequestId: 'b' });
  f.ledger.markSent(claimA, keyA);
  f.ledger.markSent(claimB, keyB);
  f.ledger.terminate(coordinator, f.ledger.fence(first.operationId), a, 'cancelled', 'cancel');
  f.ledger.confirm(keyA, { outcome: 'failed', receipt: { fake: 'a' }, usage: { fake: 1 } });
  assert.equal(
    f.store.get<{ status: string }>('SELECT status FROM web_operations WHERE id=?', first.operationId)?.status,
    'cancelled',
  );
  f.advance(30_000);
  f.queue.acquireCoordinator('new-epoch');
  f.ledger.confirm(keyB, { outcome: 'failed', receipt: { fake: 'b' }, usage: { fake: 1 } });
  assert.equal(
    f.store.get<{ status: string }>('SELECT status FROM web_operations WHERE id=?', second.operationId)?.status,
    'text_running',
  );
  assert.equal(f.store.get<{ reserved: number }>('SELECT reserved FROM web_external_budgets')?.reserved, 0);
  assert.equal(
    f.store.get<{ trial_reserved: number }>('SELECT trial_reserved FROM web_principals WHERE id=?', b)?.trial_reserved,
    1,
  );
});

test('106 real internal registration keeps the original operation and failed receipt releases its reservation', async (t) => {
  const f = fixture(t),
    origin = 'https://web.example.test';
  const identity = new WebIdentity(f.store, {
    origin,
    cookieName: '__Host-failure_session',
    clock: f.clock,
    keys: { keyId: 'synthetic', sealKey: Buffer.alloc(32, 1), requestKey: Buffer.alloc(32, 2) },
  });
  const guest = identity.bootstrap(),
    token = guest.issuedToken!;
  const player = identity.authenticate(token);
  f.store.run("INSERT INTO world_characters VALUES (?,?,'new')", player.world_id, 'character');
  const operation = f.admit(guest.principalId, 'first');
  f.store.migrateInputSnapshot();
  const coordinator = f.queue.acquireCoordinator('coordinator');
  const claim = f.queue.claimText(coordinator, 'worker')!;
  f.ledger.configureBudget({ provider: 'fake', stage: 'text', phase: 'draft', capacity: 1 });
  const key = f.ledger.reserve(claim, { phase: 'draft', ordinal: -1, provider: 'fake', providerRequestId: 'failure' });
  f.ledger.markSent(claim, key);
  const frozen = f.queue.inputSnapshot(scope(claim));
  await identity.register(token, guest.csrf, origin, {
    requestId: 'registration',
    username: 'synthetic_user',
    password: 'synthetic-password-only',
  });
  assert.deepEqual({ ...f.queue.inputSnapshot(scope(claim)) }, { ...frozen });
  f.ledger.confirm(key, { outcome: 'failed', receipt: { synthetic: true }, usage: { fake: 1 } });
  assert.equal(
    f.store.get<{ status: string; quota_state: string }>(
      'SELECT status,quota_state FROM web_operations WHERE id=?',
      operation.operationId,
    )?.status,
    'failed',
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
    0,
  );
  assert.equal(
    f.store.get<{ used: number; reserved: number }>(
      'SELECT used,reserved FROM web_ip_windows WHERE id=(SELECT ip_window_id FROM web_operations WHERE id=?)',
      operation.operationId,
    )?.reserved,
    0,
  );
});

test('106 failed receipt at exact stage lease boundary settles external only', (t) => {
  const f = fixture(t),
    principal = f.guest('a'),
    operation = f.admit(principal, 'first');
  f.store.migrateInputSnapshot();
  let coordinator = f.queue.acquireCoordinator('coordinator');
  const claim = f.queue.claimText(coordinator, 'worker')!;
  f.ledger.configureBudget({ provider: 'fake', stage: 'text', phase: 'draft', capacity: 1 });
  const key = f.ledger.reserve(claim, { phase: 'draft', ordinal: -1, provider: 'fake', providerRequestId: 'late' });
  f.ledger.markSent(claim, key);
  for (let i = 0; i < 3; i++) {
    f.advance(29_999);
    coordinator = f.queue.renewCoordinator(coordinator);
  }
  f.advance(3);
  assert.equal(f.clock.now(), claim.leaseExpiresAt);
  f.ledger.confirm(key, { outcome: 'failed', receipt: { fake: true }, usage: { fake: 1 } });
  assert.equal(
    f.store.get<{ status: string; quota_state: string }>(
      'SELECT status,quota_state FROM web_operations WHERE id=?',
      operation.operationId,
    )?.status,
    'text_running',
  );
  assert.equal(
    f.store.get<{ trial_reserved: number }>('SELECT trial_reserved FROM web_principals WHERE id=?', principal)
      ?.trial_reserved,
    1,
  );
  assert.equal(f.store.get<{ reserved: number }>('SELECT reserved FROM web_external_budgets')?.reserved, 0);
});

test('106 failed receipt at original total deadline settles external only', (t) => {
  const f = fixture(t),
    principal = f.guest('a'),
    operation = f.admit(principal, 'first');
  f.store.migrateInputSnapshot();
  const claim = f.queue.claimText(f.queue.acquireCoordinator('coordinator'), 'worker')!;
  f.ledger.configureBudget({ provider: 'fake', stage: 'text', phase: 'draft', capacity: 1 });
  const key = f.ledger.reserve(claim, { phase: 'draft', ordinal: -1, provider: 'fake', providerRequestId: 'deadline' });
  f.ledger.markSent(claim, key);
  f.store.run('UPDATE web_operations SET deadline_at=? WHERE id=?', f.clock.now() + 1, operation.operationId);
  f.advance(1);
  f.ledger.confirm(key, { outcome: 'failed', receipt: { fake: true }, usage: { fake: 1 } });
  assert.equal(
    f.store.get<{ status: string }>('SELECT status FROM web_operations WHERE id=?', operation.operationId)?.status,
    'text_running',
  );
  assert.equal(
    f.store.get<{ trial_reserved: number }>('SELECT trial_reserved FROM web_principals WHERE id=?', principal)
      ?.trial_reserved,
    1,
  );
  assert.equal(f.store.get<{ reserved: number }>('SELECT reserved FROM web_external_budgets')?.reserved, 0);
});

test('106 old known-failed replay does not retroactively terminalize an operation', (t) => {
  const f = fixture(t),
    principal = f.guest('a'),
    operation = f.admit(principal, 'first');
  f.store.migrateInputSnapshot();
  const claim = f.queue.claimText(f.queue.acquireCoordinator('coordinator'), 'worker')!;
  f.ledger.configureBudget({ provider: 'fake', stage: 'text', phase: 'draft', capacity: 1 });
  const key = f.ledger.reserve(claim, { phase: 'draft', ordinal: -1, provider: 'fake', providerRequestId: 'old' });
  f.ledger.markSent(claim, key);
  f.store.transaction(() => {
    f.store.run(
      `UPDATE web_external_attempts SET dispatch_state='known',outcome='failed',
      receipt_json=?,usage_json=?,settled_at=? WHERE operation_id=? AND stage='text' AND phase='draft'`,
      JSON.stringify({ old: true }),
      JSON.stringify({ fake: 1 }),
      f.clock.now(),
      operation.operationId,
    );
    f.store.run(
      "UPDATE web_external_budgets SET reserved=reserved-1 WHERE provider='fake' AND stage='text' AND phase='draft'",
    );
  });
  assert.deepEqual(f.ledger.confirm(key, { outcome: 'failed', receipt: { old: true }, usage: { fake: 1 } }), {
    duplicate: true,
  });
  assert.equal(
    f.store.get<{ status: string }>('SELECT status FROM web_operations WHERE id=?', operation.operationId)?.status,
    'text_running',
  );
  assert.equal(
    f.store.get<{ trial_reserved: number }>('SELECT trial_reserved FROM web_principals WHERE id=?', principal)
      ?.trial_reserved,
    1,
  );
});

test('105 known-failed receipt retains old external-only behavior', (t) => {
  const f = fixture(t),
    principal = f.guest('a'),
    operation = f.admit(principal, 'first');
  const claim = f.queue.claimText(f.queue.acquireCoordinator('coordinator'), 'worker')!;
  f.ledger.configureBudget({ provider: 'fake', stage: 'text', phase: 'draft', capacity: 1 });
  const key = f.ledger.reserve(claim, { phase: 'draft', ordinal: -1, provider: 'fake', providerRequestId: 'old' });
  f.ledger.markSent(claim, key);
  f.ledger.confirm(key, { outcome: 'failed', receipt: { old: true }, usage: { fake: 1 } });
  assert.equal(
    f.store.get<{ status: string }>('SELECT status FROM web_operations WHERE id=?', operation.operationId)?.status,
    'text_running',
  );
  assert.equal(
    f.store.get<{ trial_reserved: number }>('SELECT trial_reserved FROM web_principals WHERE id=?', principal)
      ?.trial_reserved,
    1,
  );
  assert.equal(f.store.get<{ reserved: number }>('SELECT reserved FROM web_external_budgets')?.reserved, 0);
});

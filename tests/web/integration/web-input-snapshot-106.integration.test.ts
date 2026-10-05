import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WebAdmission } from '../../../apps/server/web-admission.ts';
import { WebDispatchLedger } from '../../../apps/server/web-dispatch-ledger.ts';
import { WebIdentity } from '../../../apps/server/web-identity.ts';
import { WebStageQueue, type WebStageClaim } from '../../../apps/server/web-stage-queue.ts';
import { WebStore } from '../../../apps/server/store.ts';

const base = 1_700_000_000_000;
const ip = (n: number) => n.toString(16).padStart(64, '0');
const oldCandidate = { narrative: ['合成旧片'], inputVersion: 'old', characterVersion: 'old',
  templateVersion: 'old', voiceVersion: 'old-voice', accessRevision: 1, usage: { synthetic: true } };

function fixture(t: test.TestContext) {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'web-c-snapshot-'));
  const root = join(parent, 'web'), instanceId = randomUUID();
  const store = new WebStore(root, { create: true, instanceId });
  t.after(() => { store.close(); rmSync(parent, { recursive: true, force: true }); });
  store.migrateStages(); store.migrateAdmissionOrder(); store.migrateIdentity(randomUUID());
  store.migrateDispatchLedger(); store.migrateSyntheticVoiceQueue();
  let now = base;
  const clock = { now: () => now };
  const admission = new WebAdmission(store, clock, randomUUID);
  const queue = new WebStageQueue(store, clock, randomUUID);
  const ledger = new WebDispatchLedger(store, clock);
  store.run('INSERT INTO character_templates(id,version,config_json) VALUES (?,?,?)', 'character', 1, '{"name":"synthetic"}');
  function guest(name: string) {
    const playerId = `player-${name}`, worldId = `world-${name}`, principalId = `principal-${name}`;
    store.transaction(() => {
      store.run('INSERT INTO api_players VALUES (?,?)', playerId, now);
      store.run('INSERT INTO worlds VALUES (?,?,?,?)', worldId, playerId, 'UTC', '{}');
      store.run("INSERT INTO world_characters VALUES (?,?,'new')", worldId, 'character');
    });
    admission.registerGuest({ principalId, playerId, worldId });
    return principalId;
  }
  function admit(principalId: string, requestId: string, text = requestId, number = 1) {
    return admission.admit({ principalId, requestId, characterId: 'character', text, ipHash: ip(number) });
  }
  function scope(claim: WebStageClaim) {
    return { operation_id: claim.operationId, principal_id: claim.principalId, world_id: claim.worldId,
      conversation_id: claim.conversationId, character_id: claim.characterId, input_message_id: claim.inputMessageId };
  }
  return { root, instanceId, store, clock, admission, queue, ledger, guest, admit, scope,
    advance: (ms: number) => { now += ms; }, now: () => now };
}

function assert105(f: ReturnType<typeof fixture>) {
  assert.equal(f.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 105);
  assert.equal(f.store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_input_snapshots'"), undefined);
}

test('C-S3-003 safe 105→106 migration retains terminal known/UNKNOWN, old audio, scope and queued order', t => {
  const f = fixture(t), one = f.guest('known'), two = f.guest('unknown'), three = f.guest('queued');
  const old = f.admit(one, 'old', '旧输入', 1), unknown = f.admit(two, 'unknown', '未知回执输入', 2);
  const coordinator = f.queue.acquireCoordinator('coordinator');
  const oldText = f.queue.claimText(coordinator, 'text-old')!;
  f.queue.completeText(oldText, oldCandidate);
  f.ledger.configureBudget({ provider: 'fake', stage: 'audio', phase: 'speech', capacity: 1 });
  const audio = f.queue.claimAudio(coordinator, 'audio-old')!;
  const oldKey = f.ledger.reserve(audio, { phase: 'speech', ordinal: 0, provider: 'fake', providerRequestId: 'old-audio' });
  f.ledger.markSent(audio, oldKey);
  f.ledger.confirm(oldKey, { outcome: 'succeeded', receipt: { id: 'old' }, usage: { tokens: 7 } });
  f.ledger.terminate(coordinator, f.ledger.fence(old.operationId), one, 'cancelled', 'cancel');
  const unknownText = f.queue.claimText(coordinator, 'text-unknown')!;
  f.ledger.configureBudget({ provider: 'fake', stage: 'text', phase: 'draft', capacity: 1 });
  const unknownKey = f.ledger.reserve(unknownText, { phase: 'draft', ordinal: -1, provider: 'fake', providerRequestId: 'old-unknown' });
  f.ledger.markSent(unknownText, unknownKey);
  f.ledger.terminate(coordinator, f.ledger.fence(unknown.operationId), two, 'cancelled', 'cancel');
  const waiting = f.admit(three, 'waiting', '106前已排队', 3);
  const tables = ['web_operations', 'web_external_attempts', 'web_external_budgets',
    'web_reviewed_candidates', 'web_synthetic_voice_segments', 'web_ip_windows', 'web_principals', 'messages'];
  const before = Object.fromEntries(tables.map(table => [table, f.store.all<Record<string, unknown>>(`SELECT * FROM ${table} ORDER BY rowid`).map(row => ({ ...row }))]));
  const reopened105 = new WebStore(f.root, { create: false, instanceId: f.instanceId });
  assert.equal(reopened105.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 105);
  reopened105.close();
  f.store.migrateInputSnapshot();
  assert.equal(f.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 106);
  for (const table of tables) assert.deepEqual(f.store.all<Record<string, unknown>>(`SELECT * FROM ${table} ORDER BY rowid`).map(row => ({ ...row })),
    before[table], table);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_input_snapshots')?.n, 0);
  assert.equal(f.ledger.syntheticComplete(old.operationId), true, 'terminal 105 audio metadata remains readable in 106');
  assert.equal(f.store.get<{ reserved: number }>("SELECT reserved FROM web_external_budgets WHERE stage='text'")?.reserved, 1);
  assert.equal(f.queue.claimText(coordinator, 'new-worker')?.operationId, waiting.operationId);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_input_snapshots')?.n, 1);
  assert.throws(() => f.admission.finalize(waiting.operationId, 'failed'), /WEB_DISPATCH_FENCE_REQUIRED/);
});

test('C-S3-003 unsafe active and queued-with-attempt refuse 106 without erasing old records', t => {
  const f = fixture(t), principal = f.guest('unsafe'), op = f.admit(principal, 'active');
  const coordinator = f.queue.acquireCoordinator('coordinator');
  const claim = f.queue.claimText(coordinator, 'worker')!;
  assert.throws(() => f.store.migrateInputSnapshot(), /WEB_INPUT_SNAPSHOT_MIGRATION_UNSAFE/);
  assert105(f);
  f.ledger.terminate(coordinator, f.ledger.fence(op.operationId), principal, 'cancelled', 'cancel');
  const queued = f.admit(principal, 'queued');
  f.store.run(`INSERT INTO web_stage_attempts(operation_id,stage,attempt,dispatch_state,provider_request_id,created_at)
    VALUES (?,'text',1,'sent','unsafe-old',?)`, queued.operationId, f.now());
  assert.throws(() => f.store.migrateInputSnapshot(), /WEB_INPUT_SNAPSHOT_MIGRATION_UNSAFE/);
  assert105(f);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_stage_attempts WHERE operation_id=?', queued.operationId)?.n, 1);
  assert.ok(claim);
});

test('C-S3-003 late DDL name conflict and final FK audit each roll 106 back to 105', t => {
  const f = fixture(t), principal = f.guest('rollback'), op = f.admit(principal, 'input');
  f.store.run(`CREATE TRIGGER web_input_snapshots_no_delete BEFORE UPDATE ON web_operations BEGIN SELECT 1; END`);
  assert.throws(() => f.store.migrateInputSnapshot(), /already exists/);
  assert105(f);
  f.store.run('DROP TRIGGER web_input_snapshots_no_delete');
  const db = (f.store as unknown as { db: { exec(sql: string): void } }).db;
  db.exec('PRAGMA foreign_keys=OFF');
  f.store.run('UPDATE messages SET conversation_id=? WHERE id=?', 'orphan-conversation', op.inputMessageId);
  assert.throws(() => f.store.migrateInputSnapshot(), /WEB_INPUT_SNAPSHOT_FOREIGN_KEY_INVALID/);
  assert105(f);
  assert.equal(f.store.get<{ conversation_id: string }>('SELECT conversation_id FROM messages WHERE id=?', op.inputMessageId)?.conversation_id,
    'orphan-conversation');
});

test('C-S3-003 claim/cursor fault rolls back snapshot; next input is excluded and scoped read stays frozen', t => {
  const f = fixture(t), principal = f.guest('owner');
  const first = f.admit(principal, 'first', '原始玩家输入');
  const later = f.admit(principal, 'later', '之后排队但未发布');
  f.store.migrateInputSnapshot();
  const coordinator = f.queue.acquireCoordinator('coordinator');
  f.store.run(`CREATE TRIGGER reject_cursor BEFORE UPDATE OF text_last_principal_id ON web_scheduler_state
    BEGIN SELECT RAISE(ABORT,'injected cursor failure'); END`);
  assert.throws(() => f.queue.claimText(coordinator, 'worker'), /injected cursor failure/);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_input_snapshots')?.n, 0);
  assert.equal(f.store.get<{ status: string }>('SELECT status FROM web_operations WHERE id=?', first.operationId)?.status, 'queued');
  assert.equal(f.store.get<{ text_last_principal_id: string | null }>(
    'SELECT text_last_principal_id FROM web_scheduler_state')?.text_last_principal_id, null);
  f.store.run('DROP TRIGGER reject_cursor');
  const claim = f.queue.claimText(coordinator, 'worker')!;
  assert.equal(claim.operationId, first.operationId);
  const snapshot = f.queue.inputSnapshot(f.scope(claim));
  assert.equal(snapshot.input_message_id, first.inputMessageId);
  assert.equal(snapshot.input_body, '原始玩家输入');
  assert.notEqual(snapshot.input_message_id, later.inputMessageId);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_input_snapshots')?.n, 1);
  for (const bad of [{ principal_id: 'wrong' }, { world_id: 'wrong' }, { conversation_id: 'wrong' },
    { character_id: 'wrong' }, { input_message_id: later.inputMessageId }])
    assert.throws(() => f.queue.inputSnapshot({ ...f.scope(claim), ...bad }), /WEB_INPUT_SNAPSHOT_NOT_FOUND/);
  assert.throws(() => f.store.run('UPDATE web_input_snapshots SET input_body=? WHERE operation_id=?',
    'forged', first.operationId), /WEB_INPUT_SNAPSHOT_IMMUTABLE/);
  assert.throws(() => f.store.run('DELETE FROM web_input_snapshots WHERE operation_id=?', first.operationId),
    /WEB_INPUT_SNAPSHOT_IMMUTABLE/);
  const reopened = new WebStore(f.root, { create: false, instanceId: f.instanceId });
  t.after(() => reopened.close());
  const other = new WebStageQueue(reopened, f.clock, randomUUID);
  assert.deepEqual({ ...other.inputSnapshot(f.scope(claim)) }, { ...snapshot });
});

for (const [name, trigger] of [
  ['snapshot insert', `CREATE TRIGGER reject_first_claim BEFORE INSERT ON web_input_snapshots
    BEGIN SELECT RAISE(ABORT,'injected snapshot failure'); END`],
  ['operation CAS', `CREATE TRIGGER reject_first_claim BEFORE UPDATE OF status ON web_operations
    WHEN NEW.status='text_running' BEGIN SELECT RAISE(ABORT,'injected CAS failure'); END`]
] as const) test(`C-S3-003 ${name} fault also rolls snapshot, claim and rotation back`, t => {
  const f = fixture(t), principal = f.guest('fault'), op = f.admit(principal, 'input');
  f.store.migrateInputSnapshot();
  const coordinator = f.queue.acquireCoordinator('coordinator');
  f.store.run(trigger);
  assert.throws(() => f.queue.claimText(coordinator, 'worker'), /injected .* failure/);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_input_snapshots')?.n, 0);
  assert.equal(f.store.get<{ status: string; stage_version: number }>(
    'SELECT status,stage_version FROM web_operations WHERE id=?', op.operationId)?.status, 'queued');
  assert.equal(f.store.get<{ text_last_principal_id: string | null }>(
    'SELECT text_last_principal_id FROM web_scheduler_state')?.text_last_principal_id, null);
  f.store.run('DROP TRIGGER reject_first_claim');
  assert.equal(f.queue.claimText(coordinator, 'worker')?.operationId, op.operationId);
});

test('C-S3-003 dispatch and candidate are fenced to original snapshot while actual account upgrade preserves it', async t => {
  const f = fixture(t), origin = 'https://verify.example.test';
  const identity = new WebIdentity(f.store, { origin, cookieName: '__Host-verify_session', clock: f.clock,
    keys: { keyId: 'synthetic', sealKey: Buffer.alloc(32, 7), requestKey: Buffer.alloc(32, 8) } });
  const bootstrap = identity.bootstrap(), principal = bootstrap.principalId;
  const world = f.store.get<{ world_id: string }>('SELECT world_id FROM web_principals WHERE id=?', principal)!.world_id;
  f.store.run("INSERT INTO world_characters VALUES (?,'character','new')", world);
  const op = f.admit(principal, 'original', '真实原输入'), later = f.admit(principal, 'later', '后排队输入');
  f.store.migrateInputSnapshot();
  const coordinator = f.queue.acquireCoordinator('coordinator'), claim = f.queue.claimText(coordinator, 'text')!;
  assert.equal(claim.operationId, op.operationId);
  const snapshot = f.queue.inputSnapshot(f.scope(claim));
  assert.equal(snapshot.input_body, '真实原输入');
  assert.notEqual(snapshot.input_message_id, later.inputMessageId);
  const account = await identity.register(bootstrap.issuedToken!, bootstrap.csrf, origin,
    { requestId: 'upgrade', username: 'snapshot_owner', password: 'synthetic-password' });
  assert.equal(identity.authenticate(account.issuedToken).principalId, principal);
  assert.deepEqual({ ...f.queue.inputSnapshot(f.scope(claim)) }, { ...snapshot });
  f.ledger.configureBudget({ provider: 'fake', stage: 'text', phase: 'draft', capacity: 1 });
  f.store.run('UPDATE messages SET body=? WHERE id=?', 'tampered', op.inputMessageId);
  assert.throws(() => f.ledger.reserve(claim, { phase: 'draft', ordinal: -1, provider: 'fake', providerRequestId: 'bad' }),
    /WEB_INPUT_SNAPSHOT_STALE/);
  assert.equal(f.store.get<{ reserved: number }>("SELECT reserved FROM web_external_budgets WHERE stage='text'")?.reserved, 0);
  assert.deepEqual({ ...f.queue.inputSnapshot(f.scope(claim)) }, { ...snapshot });
  f.store.run('UPDATE messages SET body=? WHERE id=?', snapshot.input_body, op.inputMessageId);
  const key = f.ledger.reserve(claim, { phase: 'draft', ordinal: -1, provider: 'fake', providerRequestId: 'good' });
  f.store.run('UPDATE character_templates SET version=2,config_json=? WHERE id=?', '{}', 'character');
  assert.throws(() => f.ledger.markSent(claim, key), /WEB_INPUT_SNAPSHOT_STALE/);
  assert.equal(f.store.get<{ dispatch_state: string }>('SELECT dispatch_state FROM web_external_attempts')?.dispatch_state, 'not_sent');
  f.store.run('UPDATE character_templates SET version=?,config_json=? WHERE id=?',
    snapshot.template_version, snapshot.template_json, 'character');
  f.ledger.markSent(claim, key);
  f.ledger.confirm(key, { outcome: 'succeeded', receipt: { synthetic: true }, usage: { tokens: 1 } });
  const candidate = { narrative: ['合成候选'], inputVersion: snapshot.input_digest,
    characterVersion: String(snapshot.template_version), templateVersion: snapshot.template_digest,
    voiceVersion: 'synthetic-voice', accessRevision: snapshot.access_revision, usage: { synthetic: true } };
  for (const wrong of [{ inputVersion: 'wrong' }, { characterVersion: 'wrong' },
    { templateVersion: 'wrong' }, { accessRevision: snapshot.access_revision + 1 }])
    assert.throws(() => f.queue.completeText(claim, { ...candidate, ...wrong }), /WEB_CANDIDATE_SNAPSHOT_MISMATCH/);
  assert.equal(f.store.get('SELECT 1 FROM web_reviewed_candidates WHERE operation_id=?', op.operationId), undefined);
  f.queue.completeText(claim, candidate);
  assert.equal(f.store.get<{ input_version: string }>('SELECT input_version FROM web_reviewed_candidates WHERE operation_id=?',
    op.operationId)?.input_version, snapshot.input_digest);
  const audio = f.queue.claimAudio(coordinator, 'audio')!;
  f.ledger.configureBudget({ provider: 'fake', stage: 'audio', phase: 'speech', capacity: 1 });
  f.store.run('UPDATE messages SET body=? WHERE id=?', 'tampered-again', op.inputMessageId);
  assert.throws(() => f.ledger.reserve(audio, { phase: 'speech', ordinal: 0, provider: 'fake', providerRequestId: 'audio-bad' }),
    /WEB_INPUT_SNAPSHOT_STALE/);
  f.store.run('UPDATE messages SET body=? WHERE id=?', snapshot.input_body, op.inputMessageId);
  const audioKey = f.ledger.reserve(audio, { phase: 'speech', ordinal: 0, provider: 'fake', providerRequestId: 'audio-good' });
  f.ledger.markSent(audio, audioKey);
  f.ledger.confirm(audioKey, { outcome: 'succeeded', receipt: { synthetic: true }, usage: { calls: 1 } });
  assert.equal(f.ledger.syntheticComplete(op.operationId), true);
  assert.equal(f.store.get<{ reserved: number }>('SELECT reserved FROM web_ip_windows WHERE id=?', f.ledger.fence(op.operationId).ipWindowId)?.reserved, 2);
  assert.equal(f.store.get<{ n: number }>("SELECT count(*) n FROM messages WHERE author_kind='character'")?.n, 0);
});

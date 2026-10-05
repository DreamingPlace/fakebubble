import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WebAdmission } from '../../../apps/server/web-admission.ts';
import { WebStageQueue } from '../../../apps/server/web-stage-queue.ts';
import { WebStore } from '../../../apps/server/store.ts';
import { WEB_LIMITS } from '../../../config/web-v1.ts';

const characterId = 'fixture-character';
const candidate = { narrative: ['合成文本'], inputVersion: 'input-v1', characterVersion: 'character-v1',
  templateVersion: 'template-v1', voiceVersion: 'voice-v1', accessRevision: 1, usage: { mockTokens: 3 } };
const ip = (i: number) => i.toString(16).padStart(64, '0');

function fixture(t: test.TestContext, admissionId: () => string = randomUUID) {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'web-c-s3-'));
  const root = join(parent, 'web'), instanceId = randomUUID();
  const store = new WebStore(root, { create: true, instanceId });
  t.after(() => { store.close(); rmSync(parent, { recursive: true, force: true }); });
  let now = 1_700_000_000_000;
  const clock = { now: () => now };
  const admission = new WebAdmission(store, clock, admissionId);
  const queue = new WebStageQueue(store, clock, randomUUID);
  store.run('INSERT INTO character_templates(id,version,config_json) VALUES (?,?,?)', characterId, 1, '{}');
  function guest(name: string) {
    const playerId = `player-${name}`, worldId = `world-${name}`, principalId = `principal-${name}`;
    store.transaction(() => {
      store.run('INSERT INTO api_players VALUES (?,?)', playerId, now);
      store.run('INSERT INTO worlds VALUES (?,?,?,?)', worldId, playerId, 'Asia/Singapore', '{}');
      store.run("INSERT INTO world_characters VALUES (?,?,'new')", worldId, characterId);
    });
    admission.registerGuest({ principalId, playerId, worldId });
    return principalId;
  }
  function admit(principalId: string, requestId: string, ipIndex: number) {
    return admission.admit({ principalId, requestId, characterId, text: requestId, ipHash: ip(ipIndex) });
  }
  return { parent, root, instanceId, store, clock, admission, queue, guest, admit, advance: (ms: number) => { now += ms; } };
}

function migrateCurrent(store: WebStore) { store.migrateStages(); store.migrateAdmissionOrder(); }

test('C-S3 explicit schema101/102 migrations are atomic and ordinary reopen never migrates', t => {
  const f = fixture(t);
  assert.equal(f.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 100);
  const ordinary = new WebStore(f.root, { create: false, instanceId: f.instanceId });
  assert.equal(ordinary.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 100);
  ordinary.close();
  f.store.run('CREATE TABLE web_scheduler_state (collision INTEGER)');
  assert.throws(() => f.store.migrateStages(), /already exists/);
  assert.equal(f.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 100);
  assert.equal(f.store.all<{ name: string }>('PRAGMA table_info(web_operations)').some(column => column.name === 'stage_version'), false,
    'earlier ALTERs must roll back when a later CREATE fails');
  f.store.run('DROP TABLE web_scheduler_state');
  f.store.migrateStages();
  assert.equal(f.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 101);
  assert.throws(() => f.store.migrateStages(), /WEB_STAGE_MIGRATION_REQUIRED/);
  const reopened = new WebStore(f.root, { create: false, instanceId: f.instanceId });
  try { assert.equal(reopened.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 101); }
  finally { reopened.close(); }
  assert.throws(() => f.queue.acquireCoordinator('old-schema'), /WEB_ADMISSION_ORDER_MIGRATION_REQUIRED/);
  f.store.migrateAdmissionOrder();
  assert.equal(f.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 102);
  assert.throws(() => f.store.migrateAdmissionOrder(), /WEB_ADMISSION_ORDER_MIGRATION_REQUIRED/);
});

test('C-S3 migration refuses a running old operation without modifying schema100', t => {
  const f = fixture(t), principal = f.guest('running');
  const operation = f.admit(principal, 'first', 1);
  f.store.run("UPDATE web_operations SET status='text_running' WHERE id=?", operation.operationId);
  assert.throws(() => f.store.migrateStages(), /WEB_STAGE_MIGRATION_UNSAFE/);
  assert.equal(f.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 100);
  assert.equal(f.store.get("SELECT 1 FROM sqlite_master WHERE name='web_scheduler_state'"), undefined);
});

test('C-S3 text/audio each cap at four while an audio continuation retains its one-user pipeline', t => {
  const f = fixture(t); migrateCurrent(f.store);
  const principals = Array.from({ length: 9 }, (_, i) => f.guest(String(i)));
  for (let i = 0; i < 9; i++) f.admit(principals[i]!, `r-${i}`, i + 1);
  f.admit(principals[0]!, 'second-for-first-user', 20);
  const lease = f.queue.acquireCoordinator('coordinator');
  const text = Array.from({ length: 4 }, () => f.queue.claimText(lease, 'text-worker')!);
  assert.equal(f.queue.claimText(lease, 'text-worker'), null);
  assert.equal(new Set(text.map(claim => claim.principalId)).size, 4);
  for (const claim of text) f.queue.completeText(claim, candidate);
  const audio = Array.from({ length: 4 }, () => f.queue.claimAudio(lease, 'audio-worker')!);
  assert.deepEqual(new Set(audio.map(claim => claim.operationId)), new Set(text.map(claim => claim.operationId)));
  assert.equal(f.queue.claimAudio(lease, 'audio-worker'), null);
  const nextText = Array.from({ length: 4 }, () => f.queue.claimText(lease, 'text-worker')!);
  assert.equal(nextText.length, 4, 'slow audio must not consume text capacity for other users');
  assert.equal(nextText.some(claim => claim.principalId === principals[0]), false, 'own queued input stays behind own audio pipeline');
  assert.equal(f.queue.claimText(lease, 'text-worker'), null);
});

test('C-S3 same-millisecond same-user inputs must claim in accepted input order, not random operation ID order', t => {
  const ids = ['window', 'conversation', 'message-first', 'z-operation-first', 'message-second', 'a-operation-second'];
  const f = fixture(t, () => ids.shift() ?? randomUUID()); migrateCurrent(f.store);
  const principal = f.guest('fifo');
  const first = f.admit(principal, 'first', 1);
  const second = f.admit(principal, 'second', 1);
  assert.equal(first.operationId, 'z-operation-first');
  assert.equal(second.operationId, 'a-operation-second');
  const lease = f.queue.acquireCoordinator('coordinator');
  assert.equal(f.queue.claimText(lease, 'worker')?.operationId, first.operationId,
    'same user/conversation cannot answer a later input before an earlier admitted input');
});

test('C-S3 moving running text into audio wait must not exceed the global waiting cap', t => {
  const f = fixture(t); migrateCurrent(f.store);
  for (let i = 0; i < WEB_LIMITS.maxGlobalReservedOperations; i++) f.admit(f.guest(`q${i}`), `r${i}`, i + 1);
  const lease = f.queue.acquireCoordinator('coordinator');
  const text = f.queue.claimText(lease, 'worker')!;
  const newcomer = f.guest('newcomer');
  try { f.admit(newcomer, 'new', 999); }
  catch (error) {
    // A conservative reservation may reject before the physical waiting count
    // reaches 128, because running text can later become audio waiting.
    assert.match(String(error), /QUEUE_FULL/);
  }
  f.queue.completeText(text, candidate);
  const waiting = f.store.get<{ n: number }>("SELECT count(*) n FROM web_operations WHERE status IN ('queued','text_ready','audio_pending')")!.n;
  assert.ok(waiting <= WEB_LIMITS.maxGlobalReservedOperations,
    `waiting=${waiting}, cap=${WEB_LIMITS.maxGlobalReservedOperations}`);
});

test('C-S3 stale lease token/epoch and fixed queue deadlines are checked after reconnect', t => {
  const f = fixture(t); migrateCurrent(f.store);
  const first = f.admit(f.guest('first'), 'first', 1);
  const coordinator = f.queue.acquireCoordinator('coordinator');
  const claim = f.queue.claimText(coordinator, 'worker')!;
  const reopened = new WebStore(f.root, { create: false, instanceId: f.instanceId });
  t.after(() => reopened.close());
  assert.equal(reopened.get<{ epoch: number }>('SELECT epoch FROM web_scheduler_state WHERE singleton=1')?.epoch, coordinator.epoch);
  const secondQueue = new WebStageQueue(reopened, f.clock, randomUUID);
  assert.throws(() => secondQueue.completeText({ ...claim, token: randomUUID() }, candidate), /WEB_STAGE_STALE/);
  f.advance(WEB_LIMITS.textLeaseMs);
  assert.throws(() => secondQueue.completeText(claim, candidate), /WEB_STAGE_STALE/);
  const before = f.store.get<{ created_at: number; deadline_at: number; text_queued_at: number }>(
    'SELECT created_at,deadline_at,text_queued_at FROM web_operations WHERE id=?', first.operationId)!;
  f.advance(WEB_LIMITS.coordinatorLeaseMs);
  const recovered = secondQueue.acquireCoordinator('recovered');
  assert.equal(recovered.epoch, coordinator.epoch + 1);
  assert.throws(() => f.queue.claimText(coordinator, 'old-worker'), /WEB_COORDINATOR_STALE/);
  assert.deepEqual({ ...f.store.get<typeof before>('SELECT created_at,deadline_at,text_queued_at FROM web_operations WHERE id=?', first.operationId) },
    { ...before }, 'recovery must not refresh the first queue/deadline clock');
});

test('C-S3 old schema101 needs explicit 102 migration that preserves existing operation and window facts', t => {
  const ids = ['window', 'conversation', 'message-first', 'z-operation-first', 'message-second', 'a-operation-second'];
  const f = fixture(t, () => ids.shift() ?? randomUUID()); f.store.migrateStages();
  const principal = f.guest('legacy');
  const first = f.admit(principal, 'first', 1), second = f.admit(principal, 'second', 1);
  const sql = 'SELECT id,input_message_id,ip_window_id,created_at,text_queued_at,deadline_at FROM web_operations ORDER BY rowid';
  const before = f.store.all<Record<string, string | number>>(sql);
  assert.deepEqual(before.map(row => row.id), [first.operationId, second.operationId]);
  const windowId = before[0]!.ip_window_id;
  assert.ok(typeof windowId === 'string');
  const windowBefore = f.store.get<Record<string, string | number>>('SELECT * FROM web_ip_windows WHERE id=?', windowId)!;
  const reopened = new WebStore(f.root, { create: false, instanceId: f.instanceId });
  try { assert.equal(reopened.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 101); }
  finally { reopened.close(); }
  assert.throws(() => f.queue.acquireCoordinator('before-explicit-upgrade'), /WEB_ADMISSION_ORDER_MIGRATION_REQUIRED/);
  f.store.migrateAdmissionOrder();
  assert.equal(f.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 102);
  assert.deepEqual(f.store.all<Record<string, string | number>>(sql), before);
  assert.deepEqual({ ...f.store.get<typeof windowBefore>('SELECT * FROM web_ip_windows WHERE id=?', windowId) }, { ...windowBefore });
  assert.deepEqual(f.store.all<{ id: string; admission_seq: number }>('SELECT id,admission_seq FROM web_operations ORDER BY admission_seq').map(row => ({ ...row })),
    [{ id: first.operationId, admission_seq: 1 }, { id: second.operationId, admission_seq: 2 }]);
  assert.equal(f.store.get<{ last_seq: number }>('SELECT last_seq FROM web_admission_counter')?.last_seq, 2);
  const third = f.admit(principal, 'third', 2);
  assert.equal(f.store.get<{ admission_seq: number }>('SELECT admission_seq FROM web_operations WHERE id=?', third.operationId)?.admission_seq, 3);
  const lease = f.queue.acquireCoordinator('after-explicit-upgrade');
  assert.equal(f.queue.claimText(lease, 'worker')?.operationId, first.operationId);
});

test('C-S3 interrupted 101→102 migration rolls back partial DDL and over-budget legacy data is refused', t => {
  const f = fixture(t); f.store.migrateStages();
  const operation = f.admit(f.guest('legacy'), 'old-input', 1);
  f.store.run('CREATE TABLE web_admission_counter (collision INTEGER)');
  assert.throws(() => f.store.migrateAdmissionOrder(), /already exists/);
  assert.equal(f.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 101);
  assert.equal(f.store.all<{ name: string }>('PRAGMA table_info(web_operations)').some(column => column.name === 'admission_seq'), false);
  assert.equal(f.store.get<{ id: string }>('SELECT id FROM web_operations WHERE id=?', operation.operationId)?.id, operation.operationId);
  f.store.run('DROP TABLE web_admission_counter');
  for (let i = 1; i < WEB_LIMITS.maxGlobalReservedOperations; i++) f.admit(f.guest(`old${i}`), `old${i}`, i + 1);
  f.admission.finalize(operation.operationId, 'cancelled');
  f.admit(f.guest('overflow'), 'overflow', 999);
  // Emulate an already-written schema101 snapshot from the old admission rule.
  f.store.run("UPDATE web_operations SET status='queued' WHERE id=?", operation.operationId);
  assert.equal(f.store.get<{ n: number }>("SELECT count(*) n FROM web_operations WHERE status NOT IN ('published','cancelled','failed')")?.n,
    WEB_LIMITS.maxGlobalReservedOperations + 1);
  assert.throws(() => f.store.migrateAdmissionOrder(), /WEB_GLOBAL_BUDGET_OVERFLOW/);
  assert.equal(f.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 101);
  assert.equal(f.store.all<{ name: string }>('PRAGMA table_info(web_operations)').some(column => column.name === 'admission_seq'), false);
});

test('C-S3 global budget rejects without side effects, replay remains idempotent, terminal releases one ticket', t => {
  const f = fixture(t); migrateCurrent(f.store);
  const firstPrincipal = f.guest('first');
  const first = f.admit(firstPrincipal, 'first', 1);
  for (let i = 1; i < WEB_LIMITS.maxGlobalReservedOperations; i++) f.admit(f.guest(`q${i}`), `q${i}`, i + 1);
  const newcomer = f.guest('newcomer');
  const before = f.store.get<{ n: number }>('SELECT count(*) n FROM web_ip_windows')!.n;
  assert.throws(() => f.admit(newcomer, 'new', 999), /QUEUE_FULL/);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_ip_windows')?.n, before);
  assert.equal(f.store.get('SELECT 1 FROM messages WHERE world_id=?', 'world-newcomer'), undefined);
  assert.deepEqual({ ...f.store.get<{ trial_character_id: string | null; trial_reserved: number }>(
    'SELECT trial_character_id,trial_reserved FROM web_principals WHERE id=?', newcomer) },
  { trial_character_id: null, trial_reserved: 0 });
  assert.deepEqual(f.admit(firstPrincipal, 'first', 1), { ...first, duplicate: true });
  f.admission.finalize(first.operationId, 'cancelled');
  assert.equal(f.store.get<{ trial_reserved: number }>('SELECT trial_reserved FROM web_principals WHERE id=?', firstPrincipal)?.trial_reserved, 0);
  assert.ok(f.admit(newcomer, 'new', 999).operationId);
  assert.equal(f.store.get<{ n: number }>("SELECT count(*) n FROM web_operations WHERE status NOT IN ('published','cancelled','failed')")?.n,
    WEB_LIMITS.maxGlobalReservedOperations);
});

test('C-S3 persistent cursor rotates across two connections without advancing coordinator epoch', t => {
  const f = fixture(t); migrateCurrent(f.store);
  const a = f.guest('a'), b = f.guest('b'), c = f.guest('c');
  const a1 = f.admit(a, 'a1', 1), a2 = f.admit(a, 'a2', 2);
  f.admit(b, 'b1', 3); f.admit(c, 'c1', 4);
  const lease = f.queue.acquireCoordinator('coordinator');
  assert.equal(f.queue.claimText(lease, 'worker-a')?.operationId, a1.operationId);
  f.admission.finalize(a1.operationId, 'cancelled');
  const reopened = new WebStore(f.root, { create: false, instanceId: f.instanceId });
  t.after(() => reopened.close());
  const other = new WebStageQueue(reopened, f.clock, randomUUID);
  assert.equal(reopened.get<{ epoch: number }>('SELECT epoch FROM web_scheduler_state')?.epoch, lease.epoch);
  assert.equal(other.claimText(lease, 'worker-b')?.principalId, b);
  assert.equal(f.queue.claimText(lease, 'worker-c')?.principalId, c);
  assert.equal(other.claimText(lease, 'worker-a2')?.operationId, a2.operationId);
  assert.throws(() => other.acquireCoordinator('other-coordinator'), /WEB_COORDINATOR_BUSY/);
});

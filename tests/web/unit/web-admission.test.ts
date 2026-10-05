import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WebAdmission } from '../../../apps/server/web-admission.ts';
import { WebStageQueue } from '../../../apps/server/web-stage-queue.ts';
import { WebStore } from '../../../apps/server/store.ts';

const ip = (digit: string) => digit.repeat(64);
const characterId = 'fixture-character';

function fixture(t: import('node:test').TestContext) {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'web-admission-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const store = new WebStore(join(parent, 'instance'), { create: true, instanceId: randomUUID() });
  t.after(() => store.close());
  let now = 1_700_000_000_000, sequence = 0;
  const nextId = () => `synthetic-${++sequence}`;
  const admission = new WebAdmission(store, { now: () => now }, nextId);
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
  return { store, admission, clock: { now: () => now }, nextId, guest, advance: (ms: number) => { now += ms; } };
}

test('first valid admission locks character and writes one scoped input, reservation and operation; replay is exact', t => {
  const { store, admission, guest } = fixture(t), principalId = guest('a');
  assert.throws(() => admission.admit({ principalId, requestId: 'bad', characterId, text: ' ', ipHash: ip('a') }), /INVALID_TEXT/);
  assert.equal(store.get<{ trial_character_id: string | null }>('SELECT trial_character_id FROM web_principals WHERE id=?', principalId)?.trial_character_id, null);
  const input = { principalId, requestId: 'r1', characterId, text: '你好', ipHash: ip('a') };
  const first = admission.admit(input);
  assert.equal(first.duplicate, false);
  assert.equal(first.status, 'queued');
  assert.deepEqual(admission.admit(input), { ...first, duplicate: true });
  assert.throws(() => admission.admit({ ...input, text: '不同内容' }), /IDEMPOTENCY_CONFLICT/);
  assert.equal(store.get<{ count: number }>('SELECT count(*) count FROM web_operations')?.count, 1);
  assert.equal(store.get<{ count: number }>('SELECT count(*) count FROM messages')?.count, 1);
  assert.equal(store.get<{ count: number }>('SELECT count(*) count FROM outbox')?.count, 1);
  assert.deepEqual({ ...store.get<{ trial_character_id: string; trial_reserved: number; trial_used: number }>(
    'SELECT trial_character_id,trial_reserved,trial_used FROM web_principals WHERE id=?', principalId) },
  { trial_character_id: characterId, trial_reserved: 1, trial_used: 0 });
  store.run("UPDATE web_operations SET status='unknown' WHERE id=?", first.operationId);
  assert.deepEqual(admission.admit(input), { ...first, status: 'unknown', duplicate: true });
  assert.equal(store.get<{ count: number }>('SELECT count(*) count FROM web_operations')?.count, 1);
});

test('explicit schema101 migration preserves an admitted input, original window and clocks', t => {
  const { store, admission, guest, advance } = fixture(t), principalId = guest('stage');
  const first = admission.admit({ principalId, requestId: 'before', characterId, text: '旧队列输入', ipHash: ip('1') });
  const before = store.get<{ input_message_id: string; ip_window_id: string; created_at: number; deadline_at: number }>(
    'SELECT input_message_id,ip_window_id,created_at,deadline_at FROM web_operations WHERE id=?', first.operationId)!;
  store.migrateStages();
  const migrated = store.get<typeof before & { text_queued_at: number; stage_version: number }>(
    'SELECT input_message_id,ip_window_id,created_at,deadline_at,text_queued_at,stage_version FROM web_operations WHERE id=?', first.operationId)!;
  assert.deepEqual({ input_message_id: migrated.input_message_id, ip_window_id: migrated.ip_window_id,
    created_at: migrated.created_at, deadline_at: migrated.deadline_at }, { ...before });
  assert.equal(migrated.text_queued_at, before.created_at);
  assert.equal(migrated.stage_version, 1);
  assert.equal(store.get<{ count: number }>('SELECT count(*) count FROM web_stage_attempts')?.count, 0);
  advance(10);
  const second = admission.admit({ principalId, requestId: 'after', characterId, text: '新队列输入', ipHash: ip('2') });
  const fresh = store.get<{ text_queued_at: number; created_at: number }>(
    'SELECT text_queued_at,created_at FROM web_operations WHERE id=?', second.operationId)!;
  assert.equal(fresh.text_queued_at, fresh.created_at);
  store.migrateAdmissionOrder();
  const orders = store.all<{ id: string; admission_seq: number }>('SELECT id,admission_seq FROM web_operations ORDER BY admission_seq');
  assert.deepEqual(orders.map(row => row.id), [first.operationId, second.operationId]);
  const third = admission.admit({ principalId, requestId: 'third', characterId, text: '同一时钟', ipHash: ip('3') });
  assert.equal(store.get<{ admission_seq: number }>('SELECT admission_seq FROM web_operations WHERE id=?', third.operationId)?.admission_seq, 3);
});

test('schema100 and existing101 backfill equal-clock opaque IDs once, then claim FIFO by durable ticket', t => {
  for (const startingSchema of [100, 101]) {
    const { store, clock, nextId, guest } = fixture(t), principalId = guest(`order-${startingSchema}`);
    if (startingSchema === 101) store.migrateStages();
    const ids = ['window', 'conversation', 'message-first', 'z-operation-first', 'message-second', 'a-operation-second'];
    const admission = new WebAdmission(store, clock, () => ids.shift()!);
    const input = { principalId, characterId, ipHash: ip('c') };
    const first = admission.admit({ ...input, requestId: 'first', text: 'first' });
    const second = admission.admit({ ...input, requestId: 'second', text: 'second' });
    assert.equal(first.operationId, 'z-operation-first');
    assert.equal(second.operationId, 'a-operation-second');
    if (startingSchema === 100) store.migrateStages();
    store.migrateAdmissionOrder();
    const rows = store.all<{ id: string; admission_seq: number }>('SELECT id,admission_seq FROM web_operations ORDER BY admission_seq');
    assert.deepEqual(rows.map(row => row.id), [first.operationId, second.operationId]);
    assert.deepEqual(rows.map(row => row.admission_seq), [1, 2]);
    const queue = new WebStageQueue(store, clock, nextId);
    const coordinator = queue.acquireCoordinator('coordinator');
    assert.equal(queue.claimText(coordinator, 'worker')?.operationId, first.operationId);
  }
});

test('same IP shares three slots across guests; changing IP does not reset one guest', t => {
  const { store, admission, guest } = fixture(t), a = guest('a'), b = guest('b');
  for (const [principalId, requestId] of [[a, 'a1'], [b, 'b1'], [a, 'a2']] as const) {
    admission.admit({ principalId, requestId, characterId, text: requestId, ipHash: ip('b') });
  }
  assert.throws(() => admission.admit({ principalId: b, requestId: 'b2', characterId, text: '再试', ipHash: ip('b') }), /TRIAL_EXHAUSTED/);
  assert.equal(store.get<{ count: number }>('SELECT count(*) count FROM messages WHERE world_id=?', 'world-b')?.count, 1);
  admission.admit({ principalId: a, requestId: 'a3', characterId, text: '换IP', ipHash: ip('c') });
  assert.throws(() => admission.admit({ principalId: a, requestId: 'a4', characterId, text: '再换IP', ipHash: ip('d') }), /TRIAL_EXHAUSTED/);
});

test('global queue boundary rejects before locking or reserving the next guest', t => {
  const { store, admission, guest } = fixture(t);
  for (let i = 0; i < 128; i++) {
    const principalId = guest(String(i));
    admission.admit({ principalId, requestId: `r${i}`, characterId, text: '你好', ipHash: i.toString(16).padStart(64, '0') });
  }
  const next = guest('next');
  assert.throws(() => admission.admit({ principalId: next, requestId: 'next', characterId, text: '你好', ipHash: ip('f') }), /QUEUE_FULL/);
  assert.equal(store.get<{ trial_character_id: string | null }>('SELECT trial_character_id FROM web_principals WHERE id=?', next)?.trial_character_id, null);
  assert.equal(store.get<{ count: number }>('SELECT count(*) count FROM web_ip_windows')?.count, 128);
});

test('global reserved-operation limit also counts reviewed audio waiters', t => {
  const { store, admission, guest } = fixture(t);
  for (let i = 0; i < 128; i++) {
    const principalId = guest(`stage-${i}`);
    admission.admit({ principalId, requestId: `stage${i}`, characterId, text: '合成', ipHash: i.toString(16).padStart(64, '0') });
  }
  store.migrateStages();
  store.run("UPDATE web_operations SET status='text_ready',audio_queued_at=created_at WHERE request_id='stage0'");
  const next = guest('overflow');
  assert.throws(() => admission.admit({ principalId: next, requestId: 'overflow', characterId,
    text: '你好', ipHash: ip('f') }), /QUEUE_FULL/);
  assert.equal(store.get<{ count: number }>('SELECT count(*) count FROM web_ip_windows')?.count, 128);
});

test('existing101 over-budget state cannot silently enter schema102', t => {
  const { store, admission, guest } = fixture(t);
  for (let i = 0; i < 128; i++) {
    const principalId = guest(`legacy-${i}`);
    admission.admit({ principalId, requestId: `legacy${i}`, characterId, text: '合成', ipHash: i.toString(16).padStart(64, '0') });
  }
  store.migrateStages();
  store.run("UPDATE web_operations SET status='published' WHERE request_id='legacy0'");
  const next = guest('legacy-next');
  admission.admit({ principalId: next, requestId: 'next', characterId, text: '合成', ipHash: ip('f') });
  store.run("UPDATE web_operations SET status='queued' WHERE request_id='legacy0'");
  assert.throws(() => store.migrateAdmissionOrder(), /WEB_GLOBAL_BUDGET_OVERFLOW/);
  assert.equal(store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 101);
});

test('failed transaction rolls back first-character lock, window, conversation and input', t => {
  const { store, guest } = fixture(t), principalId = guest('rollback');
  const admission = new WebAdmission(store, { now: () => 1_700_000_000_000 }, () => { throw new Error('synthetic ID failure'); });
  assert.throws(() => admission.admit({ principalId, requestId: 'r1', characterId, text: '你好', ipHash: ip('a') }), /synthetic ID failure/);
  for (const table of ['web_ip_windows', 'web_operations', 'conversations', 'messages', 'outbox']) {
    assert.equal(store.get<{ count: number }>(`SELECT count(*) count FROM ${table}`)?.count, 0, table);
  }
  assert.equal(store.get<{ trial_character_id: string | null }>('SELECT trial_character_id FROM web_principals WHERE id=?', principalId)?.trial_character_id, null);
});

test('window rollover within operation deadline releases only the original reservation', t => {
  const { store, admission, guest, advance } = fixture(t), a = guest('a'), b = guest('b');
  const seed = admission.admit({ principalId: a, requestId: 'seed', characterId, text: '建立窗口', ipHash: ip('e') });
  assert.deepEqual(admission.finalize(seed.operationId, 'failed'), { status: 'failed', duplicate: false });
  advance(24 * 60 * 60_000 - 120_000);
  const first = admission.admit({ principalId: a, requestId: 'a1', characterId, text: '临近窗口到期', ipHash: ip('e') });
  const firstWindow = store.get<{ ip_window_id: string }>('SELECT ip_window_id FROM web_operations WHERE id=?', first.operationId)!.ip_window_id;
  advance(120_001);
  const second = admission.admit({ principalId: b, requestId: 'b1', characterId, text: '新窗口', ipHash: ip('e') });
  const secondWindow = store.get<{ ip_window_id: string }>('SELECT ip_window_id FROM web_operations WHERE id=?', second.operationId)!.ip_window_id;
  assert.notEqual(firstWindow, secondWindow);
  const firstDeadline = store.get<{ deadline_at: number }>('SELECT deadline_at FROM web_operations WHERE id=?', first.operationId)!.deadline_at;
  assert.ok(firstDeadline > 1_700_000_000_000 + 24 * 60 * 60_000 + 1);
  assert.deepEqual({ ...store.get<{ used: number; reserved: number }>('SELECT used,reserved FROM web_ip_windows WHERE id=?', firstWindow) }, { used: 0, reserved: 1 });
  assert.deepEqual(admission.finalize(first.operationId, 'cancelled'), { status: 'cancelled', duplicate: false });
  assert.deepEqual(admission.finalize(first.operationId, 'cancelled'), { status: 'cancelled', duplicate: true });
  assert.deepEqual({ ...store.get<{ used: number; reserved: number }>('SELECT used,reserved FROM web_ip_windows WHERE id=?', firstWindow) }, { used: 0, reserved: 0 });
  assert.deepEqual({ ...store.get<{ used: number; reserved: number }>('SELECT used,reserved FROM web_ip_windows WHERE id=?', secondWindow) }, { used: 0, reserved: 1 });
  assert.deepEqual(admission.finalize(second.operationId, 'cancelled'), { status: 'cancelled', duplicate: false });
  assert.deepEqual(admission.finalize(second.operationId, 'cancelled'), { status: 'cancelled', duplicate: true });
  assert.deepEqual({ ...store.get<{ used: number; reserved: number }>('SELECT used,reserved FROM web_ip_windows WHERE id=?', secondWindow) }, { used: 0, reserved: 0 });
});

test('published settlement fails closed before the publisher exists, and expired termination releases only its original window', async t => {
  const { store, admission, guest, advance } = fixture(t), principalId = guest('deadline');
  const operation = admission.admit({ principalId, requestId: 'r1', characterId, text: '你好', ipHash: ip('f') });
  store.run("UPDATE web_operations SET status='ready_to_publish' WHERE id=?", operation.operationId);
  let callbackRan = false;
  const unsafeCall = admission.finalize.bind(admission) as (...args: unknown[]) => unknown;
  assert.throws(() => unsafeCall(operation.operationId, 'published', async () => { callbackRan = true; await Promise.resolve(); }), /WEB_PUBLICATION_NOT_READY/);
  await Promise.resolve();
  assert.equal(callbackRan, false);
  assert.deepEqual({ ...store.get<{ used: number; reserved: number }>('SELECT used,reserved FROM web_ip_windows') }, { used: 0, reserved: 1 });
  assert.equal(store.get<{ status: string }>('SELECT status FROM web_operations WHERE id=?', operation.operationId)?.status, 'ready_to_publish');

  advance(300_001);
  assert.throws(() => unsafeCall(operation.operationId, 'published', async () => { callbackRan = true; }), /OPERATION_EXPIRED/);
  assert.equal(callbackRan, false);
  assert.deepEqual(admission.finalize(operation.operationId, 'failed'), { status: 'failed', duplicate: false });
  assert.deepEqual(admission.finalize(operation.operationId, 'failed'), { status: 'failed', duplicate: true });
  assert.deepEqual({ ...store.get<{ used: number; reserved: number }>('SELECT used,reserved FROM web_ip_windows') }, { used: 0, reserved: 0 });
  assert.equal(store.get<{ trial_used: number; trial_reserved: number }>('SELECT trial_used,trial_reserved FROM web_principals WHERE id=?', principalId)?.trial_used, 0);
  assert.equal(store.get<{ trial_used: number; trial_reserved: number }>('SELECT trial_used,trial_reserved FROM web_principals WHERE id=?', principalId)?.trial_reserved, 0);
});

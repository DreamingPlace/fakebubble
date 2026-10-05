import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WebAdmission } from '../../../apps/server/web-admission.ts';
import { WebStageQueue } from '../../../apps/server/web-stage-queue.ts';
import { WebStore } from '../../../apps/server/store.ts';

function fixture(t: test.TestContext) {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'web-stage-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, 'instance'), instanceId = randomUUID();
  const store = new WebStore(root, { create: true, instanceId });
  t.after(() => store.close());
  store.migrateStages();
  store.migrateAdmissionOrder();
  let now = 1_700_000_000_000, sequence = 0;
  const clock = { now: () => now }, nextId = () => `stage-${++sequence}`;
  const admission = new WebAdmission(store, clock, nextId);
  const queue = new WebStageQueue(store, clock, nextId);
  store.run('INSERT INTO character_templates(id,version,config_json) VALUES (?,?,?)', 'character', 1, '{}');
  function guest(name: string) {
    const playerId = `player-${name}`, worldId = `world-${name}`, principalId = `principal-${name}`;
    store.transaction(() => {
      store.run('INSERT INTO api_players VALUES (?,?)', playerId, now);
      store.run('INSERT INTO worlds VALUES (?,?,?,?)', worldId, playerId, 'Asia/Singapore', '{}');
      store.run("INSERT INTO world_characters VALUES (?,?,'new')", worldId, 'character');
    });
    admission.registerGuest({ principalId, playerId, worldId });
    return principalId;
  }
  function admit(principalId: string, requestId: string) {
    return admission.admit({ principalId, requestId, characterId: 'character', text: requestId,
      ipHash: requestId.padEnd(64, 'a').slice(0, 64).replace(/[^a-f0-9]/g, 'b') });
  }
  return { root, instanceId, clock, nextId, store, admission, queue, guest, admit, advance: (ms: number) => { now += ms; } };
}

const candidate = { narrative: ['合成候选一', '合成候选二'], inputVersion: 'input-v1', characterVersion: 'character-v1',
  templateVersion: 'template-v1', voiceVersion: 'voice-v1', accessRevision: 1, usage: { mockTokens: 3 } };

test('text capacity is four, per-principal pipeline one, and persistent cursor rotates users', t => {
  const { store, queue, guest, admit } = fixture(t);
  const principals = ['a', 'b', 'c', 'd', 'e'].map(guest);
  for (const [index, principal] of principals.entries()) admit(principal, `r${index}`);
  admit(principals[0]!, 'r-extra');
  const coordinator = queue.acquireCoordinator('coordinator');
  assert.throws(() => queue.acquireCoordinator('other'), /WEB_COORDINATOR_BUSY/);
  const claims = Array.from({ length: 4 }, () => queue.claimText(coordinator, 'text-worker'));
  assert.deepEqual(claims.map(claim => claim?.principalId), principals.slice(0, 4));
  assert.equal(queue.claimText(coordinator, 'text-worker'), null);
  assert.equal(store.get<{ text_last_principal_id: string }>('SELECT text_last_principal_id FROM web_scheduler_state')?.text_last_principal_id,
    principals[3]);
  queue.completeText(claims[0]!, candidate);
  const next = queue.claimText(coordinator, 'text-worker');
  assert.equal(next?.principalId, principals[4]);
  assert.notEqual(next?.operationId, claims[0]?.operationId);
  assert.equal(store.get<{ count: number }>("SELECT count(*) count FROM web_operations WHERE principal_id=? AND status='queued'", principals[0]!)?.count, 1);
});

test('text round-robin cursor survives a second WebStore connection', t => {
  const { root, instanceId, clock, nextId, queue, guest, admit } = fixture(t);
  const a = guest('a'), b = guest('b'), c = guest('c');
  admit(a, 'a1'); admit(b, 'b1'); admit(c, 'c1');
  const coordinator = queue.acquireCoordinator('coordinator');
  assert.equal(queue.claimText(coordinator, 'worker-a')?.principalId, a);
  const reopened = new WebStore(root, { create: false, instanceId });
  t.after(() => reopened.close());
  const other = new WebStageQueue(reopened, clock, nextId);
  assert.equal(other.claimText(coordinator, 'worker-b')?.principalId, b);
  assert.equal(other.claimText(coordinator, 'worker-c')?.principalId, c);
});

test('TEXT_READY stores one frozen candidate, frees text slot and allows own audio continuation', t => {
  const { store, queue, guest, admit, advance } = fixture(t);
  const a = guest('a'), b = guest('b');
  const first = admit(a, 'a1'); admit(a, 'a2'); admit(b, 'b1');
  const coordinator = queue.acquireCoordinator('coordinator');
  const text = queue.claimText(coordinator, 'text-worker')!;
  assert.equal(text.operationId, first.operationId);
  assert.equal(queue.claimText(coordinator, 'text-worker')?.principalId, b);
  advance(10);
  assert.deepEqual(queue.completeText(text, candidate), { operationId: first.operationId, status: 'text_ready', stageVersion: 3 });
  assert.throws(() => queue.completeText(text, candidate), /WEB_STAGE_STALE/);
  const saved = store.get<{ input_message_id: string; narrative_json: string; voice_version: string }>(
    'SELECT input_message_id,narrative_json,voice_version FROM web_reviewed_candidates WHERE operation_id=?', first.operationId)!;
  assert.equal(saved.input_message_id, text.inputMessageId);
  assert.deepEqual(JSON.parse(saved.narrative_json), candidate.narrative);
  assert.equal(saved.voice_version, candidate.voiceVersion);
  assert.equal(store.get<{ count: number }>("SELECT count(*) count FROM web_operations WHERE status='text_running'")?.count, 1);
  const audio = queue.claimAudio(coordinator, 'audio-worker')!;
  assert.equal(audio.operationId, first.operationId);
  assert.equal(audio.stage, 'audio');
  assert.equal(queue.claimText(coordinator, 'text-worker'), null, 'same principal queued input remains blocked');
});

test('audio gets its own first-queue clock; stale epoch and expired lease cannot commit text', t => {
  const { store, queue, guest, admit, advance } = fixture(t);
  const principal = guest('slow');
  const operation = admit(principal, 'slow1');
  const coordinator = queue.acquireCoordinator('coordinator');
  const text = queue.claimText(coordinator, 'text-worker')!;
  advance(80_000);
  queue.completeText(text, candidate);
  const audioQueuedAt = store.get<{ audio_queued_at: number }>('SELECT audio_queued_at FROM web_operations WHERE id=?', operation.operationId)!.audio_queued_at;
  assert.equal(audioQueuedAt, 1_700_000_080_000);
  advance(40_000);
  const recovered = queue.acquireCoordinator('recovered');
  assert.equal(recovered.epoch, coordinator.epoch + 1);
  assert.equal(queue.claimAudio(recovered, 'audio-worker')?.operationId, operation.operationId,
    'audio still has twenty seconds of its own queue budget');
  assert.throws(() => queue.completeText(text, candidate), /WEB_STAGE_STALE/);
  assert.equal(store.get<{ count: number }>('SELECT count(*) count FROM web_stage_attempts')?.count, 0);
});

test('coordinator renewal is CAS, ordinary reconnect does not advance epoch', t => {
  const { root, instanceId, queue, advance } = fixture(t);
  const lease = queue.acquireCoordinator('coordinator');
  const connection = new WebStore(root, { create: false, instanceId });
  t.after(() => connection.close());
  assert.equal(connection.get<{ epoch: number }>('SELECT epoch FROM web_scheduler_state')?.epoch, lease.epoch);
  advance(20_000);
  const renewed = queue.renewCoordinator(lease);
  assert.equal(renewed.epoch, lease.epoch);
  assert.equal(renewed.expiresAt, lease.expiresAt + 20_000);
  advance(11_000);
  assert.throws(() => queue.acquireCoordinator('other'), /WEB_COORDINATOR_BUSY/);
  advance(20_000);
  assert.throws(() => queue.renewCoordinator(renewed), /WEB_COORDINATOR_STALE/);
  assert.equal(queue.acquireCoordinator('recovered').epoch, lease.epoch + 1);
});

test('expired initial queue is not claimed or given a refreshed deadline', t => {
  const { store, queue, guest, admit, advance } = fixture(t);
  const operation = admit(guest('old'), 'old1');
  const before = store.get<{ created_at: number; text_queued_at: number; deadline_at: number }>(
    'SELECT created_at,text_queued_at,deadline_at FROM web_operations WHERE id=?', operation.operationId)!;
  advance(60_000);
  const coordinator = queue.acquireCoordinator('coordinator');
  assert.equal(queue.claimText(coordinator, 'text-worker'), null);
  assert.deepEqual({ ...store.get<typeof before>('SELECT created_at,text_queued_at,deadline_at FROM web_operations WHERE id=?', operation.operationId) }, { ...before });
});

test('running operations retain global reservation through TEXT_READY without oversubscription', t => {
  const { store, queue, guest, admit } = fixture(t);
  for (let i = 0; i < 128; i++) admit(guest(String(i)), `r${i}`);
  const coordinator = queue.acquireCoordinator('coordinator');
  const claims = Array.from({ length: 4 }, () => queue.claimText(coordinator, 'text-worker'));
  assert.ok(claims.every(Boolean));
  const next = guest('overflow');
  assert.throws(() => admit(next, 'overflow'), /QUEUE_FULL/);
  queue.completeText(claims[0]!, candidate);
  assert.throws(() => admit(next, 'overflow'), /QUEUE_FULL/);
  assert.equal(store.get<{ n: number }>(`SELECT count(*) n FROM web_operations
    WHERE status NOT IN ('published','cancelled','failed')`)?.n, 128);
  assert.equal(store.get<{ n: number }>("SELECT count(*) n FROM web_operations WHERE status='text_ready'")?.n, 1);
});

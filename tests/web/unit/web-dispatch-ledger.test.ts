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

function fixture(t: test.TestContext, migrate = true) {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'web-ledger-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, 'instance'), instanceId = randomUUID();
  const store = new WebStore(root, { create: true, instanceId });
  t.after(() => store.close());
  store.migrateStages(); store.migrateAdmissionOrder(); store.migrateIdentity(randomUUID());
  if (migrate) store.migrateDispatchLedger();
  let now = 1_700_000_000_000, sequence = 0;
  const clock = { now: () => now }, nextId = () => `ledger-${++sequence}`;
  const admission = new WebAdmission(store, clock, nextId);
  const queue = new WebStageQueue(store, clock, nextId);
  const ledger = new WebDispatchLedger(store, clock);
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
  function admit(principalId: string, requestId: string, ipHash = 'a'.repeat(64)) {
    return admission.admit({ principalId, requestId, characterId: 'character', text: requestId, ipHash });
  }
  return { root, instanceId, store, clock, admission, queue, ledger, guest, admit,
    advance: (ms: number) => { now += ms; } };
}

test('104 is explicit, retains 103 identity/admission and rejects unsafe old evidence', t => {
  const f = fixture(t, false), principal = f.guest('a');
  const first = f.admit(principal, 'before');
  assert.throws(() => f.ledger.configureBudget({ provider: 'fake', stage: 'text', phase: 'draft', capacity: 1 }),
    /WEB_DISPATCH_MIGRATION_REQUIRED/);
  const coordinator = f.queue.acquireCoordinator('coordinator');
  const running = f.queue.claimText(coordinator, 'worker')!;
  assert.throws(() => f.store.migrateDispatchLedger(), /WEB_DISPATCH_MIGRATION_UNSAFE/);
  assert.equal(f.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 103);
  f.admission.finalize(running.operationId, 'failed');
  f.store.run(`INSERT INTO web_stage_attempts(operation_id,stage,attempt,dispatch_state,provider_request_id,created_at)
    VALUES (?,'text',1,'sent','old-provider-id',?)`, first.operationId, f.clock.now());
  assert.throws(() => f.store.migrateDispatchLedger(), /WEB_DISPATCH_MIGRATION_UNSAFE/);
  f.store.run('DELETE FROM web_stage_attempts');
  f.store.migrateDispatchLedger();
  assert.equal(f.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 104);
  assert.throws(() => f.store.migrateDispatchLedger(), /WEB_DISPATCH_MIGRATION_REQUIRED/);
  const reopened = new WebStore(f.root, { create: false, instanceId: f.instanceId });
  t.after(() => reopened.close());
  assert.equal(reopened.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 104);
  assert.equal(reopened.get<{ n: number }>('SELECT count(*) n FROM web_sessions')?.n, 0);
  const identity = new WebIdentity(reopened, { origin: 'https://web.example.test', cookieName: '__Host-build_session',
    clock: f.clock, keys: { keyId: 'synthetic', sealKey: Buffer.alloc(32, 1), requestKey: Buffer.alloc(32, 2) } });
  assert.equal(identity.bootstrap().principalId.length > 0, true);
  assert.equal(f.admit(principal, 'after').status, 'queued');
  assert.throws(() => f.admission.finalize(first.operationId, 'failed'), /WEB_DISPATCH_FENCE_REQUIRED/);
});

test('two connections reserve one external ticket; unknown survives business terminal and late receipt settles once', t => {
  const f = fixture(t), principal = f.guest('a');
  const input = f.admit(principal, 'first');
  f.ledger.configureBudget({ provider: 'fake', stage: 'text', phase: 'draft', capacity: 1 });
  const coordinator = f.queue.acquireCoordinator('coordinator'), claim = f.queue.claimText(coordinator, 'worker')!;
  const otherStore = new WebStore(f.root, { create: false, instanceId: f.instanceId });
  t.after(() => otherStore.close());
  const other = new WebDispatchLedger(otherStore, f.clock);
  const key = f.ledger.reserve(claim, { phase: 'draft', ordinal: -1, provider: 'fake', providerRequestId: 'fake-1' });
  assert.throws(() => other.reserve(claim, { phase: 'draft', ordinal: -1, provider: 'fake', providerRequestId: 'fake-2' }),
    /WEB_DISPATCH_IN_FLIGHT/);
  assert.equal(otherStore.get<{ reserved: number }>('SELECT reserved FROM web_external_budgets')?.reserved, 1);
  assert.throws(() => f.ledger.reserve(claim, { phase: 'review', ordinal: -1, provider: 'unknown', providerRequestId: 'fake-3' }),
    /WEB_DISPATCH_IN_FLIGHT/);
  f.ledger.markSent(claim, key);
  assert.throws(() => f.ledger.markSent(claim, key), /WEB_DISPATCH_STALE/);
  const fence = f.ledger.fence(input.operationId);
  assert.deepEqual(f.ledger.terminate(coordinator, fence, principal, 'cancelled', 'cancel'),
    { status: 'cancelled', duplicate: false });
  assert.deepEqual(other.terminate(coordinator, fence, principal, 'cancelled', 'cancel'),
    { status: 'cancelled', duplicate: true });
  assert.equal(f.store.get<{ reserved: number }>('SELECT reserved FROM web_external_budgets')?.reserved, 1);
  assert.equal(f.store.get<{ dispatch_state: string }>('SELECT dispatch_state FROM web_external_attempts')?.dispatch_state, 'unknown');
  assert.equal(f.store.get<{ reserved: number }>('SELECT reserved FROM web_ip_windows')?.reserved, 0);
  assert.deepEqual(other.confirm(key, { outcome: 'succeeded', receipt: { fake: true }, usage: { synthetic: 1 } }),
    { duplicate: false });
  assert.deepEqual(f.ledger.confirm(key, { outcome: 'succeeded', receipt: { fake: true }, usage: { synthetic: 1 } }),
    { duplicate: true });
  assert.equal(f.store.get<{ reserved: number }>('SELECT reserved FROM web_external_budgets')?.reserved, 0);
  assert.equal(f.store.get<{ status: string }>('SELECT status FROM web_operations WHERE id=?', input.operationId)?.status, 'cancelled');
});

test('not-sent recovery releases capacity and original quota, but sent recovery stays unknown', t => {
  const f = fixture(t), a = f.guest('a'), b = f.guest('b');
  f.ledger.configureBudget({ provider: 'fake', stage: 'text', phase: 'draft', capacity: 2 });
  const first = f.admit(a, 'first'), second = f.admit(b, 'second', 'b'.repeat(64));
  const coordinator = f.queue.acquireCoordinator('first'), claimA = f.queue.claimText(coordinator, 'worker-a')!;
  const claimB = f.queue.claimText(coordinator, 'worker-b')!;
  const keyA = f.ledger.reserve(claimA, { phase: 'draft', ordinal: -1, provider: 'fake', providerRequestId: 'fake-a' });
  const keyB = f.ledger.reserve(claimB, { phase: 'draft', ordinal: -1, provider: 'fake', providerRequestId: 'fake-b' });
  f.ledger.markSent(claimB, keyB);
  const fenceA = f.ledger.fence(first.operationId), fenceB = f.ledger.fence(second.operationId);
  f.advance(90_000);
  const recovered = f.queue.acquireCoordinator('recovered');
  assert.equal(f.ledger.recover(recovered, fenceA).status, 'failed');
  assert.equal(f.ledger.recover(recovered, fenceB).status, 'unknown');
  assert.equal(f.store.get<{ reserved: number }>('SELECT reserved FROM web_external_budgets')?.reserved, 1);
  assert.equal(f.store.get<{ outcome: string }>(`SELECT outcome FROM web_external_attempts WHERE provider_request_id='fake-a'`)?.outcome,
    'not_dispatched');
  assert.throws(() => f.ledger.markSent(claimA, keyA), /WEB_COORDINATOR_STALE|WEB_STAGE_STALE/);
  f.advance(210_000);
  const later = f.queue.acquireCoordinator('later');
  assert.deepEqual(f.ledger.terminate(later, f.ledger.fence(second.operationId), b, 'failed', 'expired'),
    { status: 'failed', duplicate: false });
  assert.equal(f.store.get<{ reserved: number }>('SELECT reserved FROM web_external_budgets')?.reserved, 1);
  assert.equal(f.store.get<{ reserved: number }>('SELECT reserved FROM web_ip_windows WHERE id=(SELECT ip_window_id FROM web_operations WHERE id=?)',
    second.operationId)?.reserved, 0);
});

test('expired queue and original rolled IP window settle once; cancellation rejects wrong principal', t => {
  const f = fixture(t), a = f.guest('a'), b = f.guest('b');
  const seed = f.admit(a, 'seed');
  const coordinator = f.queue.acquireCoordinator('coordinator');
  f.ledger.terminate(coordinator, f.ledger.fence(seed.operationId), a, 'cancelled', 'cancel');
  f.advance(24 * 60 * 60_000 - 30_000);
  const old = f.admit(a, 'old');
  const oldWindow = f.store.get<{ ip_window_id: string }>('SELECT ip_window_id FROM web_operations WHERE id=?', old.operationId)!.ip_window_id;
  f.advance(30_001);
  const fresh = f.admit(b, 'fresh');
  const freshWindow = f.store.get<{ ip_window_id: string }>('SELECT ip_window_id FROM web_operations WHERE id=?', fresh.operationId)!.ip_window_id;
  assert.notEqual(oldWindow, freshWindow);
  const fence = f.ledger.fence(old.operationId);
  assert.throws(() => f.ledger.terminate(coordinator, fence, b, 'failed', 'expired'), /WEB_COORDINATOR_STALE|WEB_SCOPE_MISMATCH/);
  const current = f.queue.acquireCoordinator('current');
  assert.throws(() => f.ledger.terminate(current, fence, a, 'failed', 'expired'), /WEB_OPERATION_NOT_EXPIRED/);
  f.advance(30_000);
  const renewed = f.queue.acquireCoordinator('renewed');
  assert.equal(f.ledger.terminate(renewed, fence, a, 'failed', 'expired').duplicate, false);
  assert.equal(f.store.get<{ reserved: number }>('SELECT reserved FROM web_ip_windows WHERE id=?', oldWindow)?.reserved, 0);
  assert.equal(f.store.get<{ reserved: number }>('SELECT reserved FROM web_ip_windows WHERE id=?', freshWindow)?.reserved, 1);
});

test('unknown provider capacity fails closed and a failed intent transaction rolls back its ticket', t => {
  const f = fixture(t), a = f.guest('a'), b = f.guest('b');
  f.admit(a, 'first'); f.admit(b, 'second', 'b'.repeat(64));
  const coordinator = f.queue.acquireCoordinator('coordinator');
  const first = f.queue.claimText(coordinator, 'worker')!, second = f.queue.claimText(coordinator, 'worker')!;
  const input = { phase: 'draft' as const, ordinal: -1, provider: 'fake', providerRequestId: 'same-id' };
  assert.throws(() => f.ledger.reserve(first, input), /WEB_EXTERNAL_CAPACITY_UNAVAILABLE/);
  f.ledger.configureBudget({ provider: 'fake', stage: 'text', phase: 'draft', capacity: 2 });
  f.ledger.reserve(first, input);
  assert.throws(() => f.ledger.reserve(second, input), /UNIQUE constraint failed/);
  assert.equal(f.store.get<{ reserved: number }>('SELECT reserved FROM web_external_budgets')?.reserved, 1);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_external_attempts')?.n, 1);
  assert.throws(() => f.ledger.reserve(first, { ...input, phase: 'review', providerRequestId: 'other' }),
    /WEB_DISPATCH_IN_FLIGHT/);
});

test('confirmed failure cannot masquerade as reviewed text; receipt replay must match', t => {
  const f = fixture(t), principal = f.guest('a');
  f.admit(principal, 'first');
  f.ledger.configureBudget({ provider: 'fake', stage: 'text', phase: 'draft', capacity: 1 });
  const coordinator = f.queue.acquireCoordinator('coordinator'), claim = f.queue.claimText(coordinator, 'worker')!;
  const key = f.ledger.reserve(claim, { phase: 'draft', ordinal: -1, provider: 'fake', providerRequestId: 'call' });
  f.ledger.markSent(claim, key);
  assert.throws(() => f.queue.completeText(claim, { narrative: ['synthetic'], inputVersion: 'i',
    characterVersion: 'c', templateVersion: 't', voiceVersion: 'v', accessRevision: 1, usage: {} }),
  /WEB_DISPATCH_UNSETTLED/);
  f.ledger.confirm(key, { outcome: 'failed', receipt: { code: 'synthetic-failure' }, usage: {} });
  assert.throws(() => f.ledger.confirm(key, { outcome: 'succeeded', receipt: {}, usage: {} }),
    /WEB_DISPATCH_RECEIPT_CONFLICT/);
  assert.throws(() => f.queue.completeText(claim, { narrative: ['synthetic'], inputVersion: 'i',
    characterVersion: 'c', templateVersion: 't', voiceVersion: 'v', accessRevision: 1, usage: {} }),
  /WEB_DISPATCH_UNSETTLED/);
});

test('104 reviewed candidate cannot commit after coordinator expiry before stage lease expiry', t => {
  const f = fixture(t), principal = f.guest('a');
  f.admit(principal, 'first');
  const coordinator = f.queue.acquireCoordinator('coordinator'), claim = f.queue.claimText(coordinator, 'worker')!;
  f.advance(30_000);
  assert.throws(() => f.queue.completeText(claim, { narrative: ['synthetic'], inputVersion: 'i',
    characterVersion: 'c', templateVersion: 't', voiceVersion: 'v', accessRevision: 1, usage: {} }),
  /WEB_COORDINATOR_STALE/);
});

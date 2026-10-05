import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { WebStore } from '../../../apps/server/store.ts';
import { WebIdentity } from '../../../apps/server/web-identity.ts';
import { WebAdmission } from '../../../apps/server/web-admission.ts';
import { WebLocalExecutor } from '../../../apps/server/web-local-executor.ts';
import { WebStageQueue } from '../../../apps/server/web-stage-queue.ts';
import { WebDispatchLedger } from '../../../apps/server/web-dispatch-ledger.ts';
import { preflightWebDataPolicy, type DataPolicyKeySource } from '../../../apps/server/web-data-policy-preflight.ts';
import { defaultSchedule } from '../../../packages/domain/defaults.ts';

const origin = 'https://127.0.0.1:18451';
const hour = 60 * 60_000;
const day = 24 * hour;

function fixture(t: TestContext) {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'web-data-preflight-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const epoch = randomUUID();
  const store = new WebStore(join(parent, 'instance'), { create: true, instanceId: randomUUID() });
  t.after(() => store.close());
  store.migrateStages(); store.migrateAdmissionOrder(); store.migrateIdentity(epoch);
  store.migrateDispatchLedger(); store.migrateSyntheticVoiceQueue(); store.migrateInputSnapshot();
  store.migrateSyntheticPrivateAudio(); store.migrateVerticalCandidate(); store.migrateLocalTransport();
  let now = 1_700_000_000_000;
  const clock = { now: () => now };
  const identity = new WebIdentity(store, { origin, cookieName: '__Host-fixture', clock,
    keys: { keyId: 'synthetic', sealKey: Buffer.alloc(32, 1), requestKey: Buffer.alloc(32, 2) } });
  store.run('INSERT INTO character_templates VALUES (?,?,?)', 'synthetic-local', 1,
    JSON.stringify({ id: 'synthetic-local', name: '合成测试人物', version: 1, fictional: true,
      persona: '仅供本地离线接口测试，不是真实人物设定。', schedule: defaultSchedule() }));
  const key: DataPolicyKeySource = { kind: 'synthetic-fixture', instanceId: store.instanceId,
    recoveryEpoch: epoch, fingerprint: 'a'.repeat(64) };
  const guest = () => {
    const boot = identity.bootstrap(), scope = identity.authenticate(boot.issuedToken!);
    store.run("INSERT INTO world_characters VALUES (?,?,'new')", scope.world_id, 'synthetic-local');
    return { boot, scope };
  };
  const admit = (principalId: string, ipHash: string, requestId: string) =>
    new WebAdmission(store, clock, randomUUID).admit({ principalId, requestId,
      characterId: 'synthetic-local', text: `fixture ${requestId}`, ipHash });
  const publish = (operationId: string) => {
    const executor = new WebLocalExecutor(store, clock);
    try {
      executor.start();
      for (let i = 0; i < 12 && !store.get('SELECT 1 FROM web_publications WHERE operation_id=?', operationId); i++)
        executor.pump();
      assert.equal(store.get<{ status: string }>('SELECT status FROM web_operations WHERE id=?', operationId)?.status,
        'published');
    } finally { executor.stop(); }
  };
  return { store, clock, key, identity, guest, admit, publish,
    advance: (ms: number) => { now += ms; }, now: () => now };
}

test('empty 109 snapshot is deterministic and logically read-only; key source is explicit', t => {
  const f = fixture(t);
  const before = f.store.get<{ user_version: number }>('PRAGMA user_version')!.user_version;
  const changes = f.store.get<{ n: number }>('SELECT total_changes() n')!.n;
  const first = preflightWebDataPolicy(f.store, f.clock, f.key);
  assert.equal(first.sourceSchema, 109);
  assert.equal(first.consistent, true);
  assert.equal(first.migrationAuthorized, false);
  assert.deepEqual(first.quotas, []); assert.deepEqual(first.retention, []);
  assert.deepEqual(preflightWebDataPolicy(f.store, f.clock, f.key), first);
  assert.equal(f.store.get<{ user_version: number }>('PRAGMA user_version')!.user_version, before);
  assert.equal(f.store.get<{ n: number }>('SELECT total_changes() n')!.n, changes);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_operations')!.n, 0);
  assert.deepEqual(preflightWebDataPolicy(f.store, f.clock, null).reasons, ['KEY_SOURCE_UNVERIFIED']);
  assert.ok(preflightWebDataPolicy(f.store, f.clock, { kind: 'runtime-config' }).reasons
    .includes('KEY_SOURCE_UNVERIFIED'), 'an arbitrary temp root cannot claim private config provenance');
  assert.deepEqual(preflightWebDataPolicy(f.store, f.clock,
    { ...f.key, fingerprint: 'not-a-fingerprint' } as DataPolicyKeySource).reasons, ['KEY_SOURCE_UNVERIFIED']);
});

test('guest without accepted input has no start; invalid request and later activity do not invent or extend it', t => {
  const f = fixture(t), user = f.guest();
  const admission = new WebAdmission(f.store, f.clock, randomUUID);
  assert.throws(() => admission.admit({ principalId: user.boot.principalId, requestId: 'bad',
    characterId: 'synthetic-local', text: ' ', ipHash: 'f'.repeat(64) }), /INVALID_TEXT/);
  assert.equal(preflightWebDataPolicy(f.store, f.clock, f.key).retention[0]?.firstTrialAcceptedAt, null);
  f.advance(hour);
  f.admit(user.boot.principalId, 'f'.repeat(64), 'first');
  const started = preflightWebDataPolicy(f.store, f.clock, f.key).retention[0]!;
  assert.equal(started.firstTrialAcceptedAt, f.now());
  f.advance(hour);
  f.admit(user.boot.principalId, 'f'.repeat(64), 'second');
  const later = preflightWebDataPolicy(f.store, f.clock, f.key).retention[0]!;
  assert.equal(later.firstTrialAcceptedAt, started.firstTrialAcceptedAt);
  assert.equal(later.expiresAt, started.expiresAt);
});

test('all old windows accumulate beyond three without truncation; IPs and first admission stay separate', t => {
  const f = fixture(t), ipA = 'a'.repeat(64), ipB = 'b'.repeat(64);
  const guests: ReturnType<typeof f.guest>[] = [];
  for (let i = 0; i < 4; i++) {
    const user = f.guest(); guests.push(user);
    f.publish(f.admit(user.boot.principalId, ipA, `a-${i}`).operationId);
    f.advance(day + 1);
  }
  const other = f.guest();
  f.admit(other.boot.principalId, ipB, 'b-queued');
  const result = preflightWebDataPolicy(f.store, f.clock, f.key);
  assert.deepEqual(result.reasons, []);
  assert.deepEqual(result.quotas.map(q => [q.usedTotal, q.reservedTotal, q.overLimit]),
    [[4, 0, true], [0, 1, false]]);
  assert.equal(result.quotas[0]?.windowIds.length, 4);
  assert.equal(result.retention.find(r => r.principalId === guests[0]!.boot.principalId)?.firstTrialAcceptedAt,
    1_700_000_000_000);
  assert.equal(result.retention.find(r => r.principalId === guests[0]!.boot.principalId)?.expiresAt,
    1_700_000_000_000 + 2 * hour);
  assert.equal(result.retention.find(r => r.principalId === other.boot.principalId)?.firstTrialAcceptedAt,
    f.now());
});

test('cross-window reservations, upgraded trial and UNKNOWN preserve original scope/charge', async t => {
  const f = fixture(t), ip = 'c'.repeat(64);
  const first = f.guest();
  const old = f.admit(first.boot.principalId, ip, 'old');
  const queue = new WebStageQueue(f.store, f.clock, randomUUID), ledger = new WebDispatchLedger(f.store, f.clock);
  const coordinator = queue.acquireCoordinator('owner');
  const claim = queue.claimText(coordinator, 'text-worker')!;
  ledger.configureBudget({ provider: 'synthetic-local', stage: 'text', phase: 'draft', capacity: 4 });
  const key = ledger.reserve(claim, { phase: 'draft', ordinal: -1, provider: 'synthetic-local',
    providerRequestId: 'unknown-draft' });
  ledger.markSent(claim, key);
  f.advance(31_000);
  const successor = queue.acquireCoordinator('successor');
  assert.equal(ledger.recover(successor, ledger.fence(old.operationId)).status, 'unknown');
  await f.identity.register(first.boot.issuedToken!, first.boot.csrf, origin,
    { requestId: 'register', username: 'fixture-account', password: 'test-passphrase' });
  f.advance(day + 1);
  const second = f.guest(); f.admit(second.boot.principalId, ip, 'new');
  const result = preflightWebDataPolicy(f.store, f.clock, f.key);
  assert.deepEqual(result.reasons, []);
  assert.equal(result.quotas[0]?.reservedTotal, 2);
  assert.equal(result.quotas[0]?.windowIds.length, 2);
  assert.equal(result.unknownExternalAttempts, 1);
  assert.equal(result.retention.find(r => r.principalId === first.boot.principalId)?.protectedByUpgrade, true);
});

test('bad window count, lost history and bad attempt scope reject rather than repair', t => {
  const f = fixture(t), user = f.guest();
  const op = f.admit(user.boot.principalId, 'd'.repeat(64), 'one');
  f.store.run('UPDATE web_ip_windows SET reserved=0 WHERE id=(SELECT ip_window_id FROM web_operations WHERE id=?)',
    op.operationId);
  assert.ok(preflightWebDataPolicy(f.store, f.clock, f.key).reasons.includes('WINDOW_COUNTER_MISMATCH'));
  f.store.run('UPDATE web_ip_windows SET reserved=1 WHERE id=(SELECT ip_window_id FROM web_operations WHERE id=?)',
    op.operationId);
  f.store.run('UPDATE web_principals SET trial_reserved=0 WHERE id=?', user.boot.principalId);
  assert.ok(preflightWebDataPolicy(f.store, f.clock, f.key).reasons.includes('PRINCIPAL_HISTORY_MISMATCH'));
  f.store.run('UPDATE web_principals SET trial_reserved=1 WHERE id=?', user.boot.principalId);
  f.store.run("UPDATE messages SET author_kind='character' WHERE id=(SELECT input_message_id FROM web_operations WHERE id=?)",
    op.operationId);
  assert.ok(preflightWebDataPolicy(f.store, f.clock, f.key).reasons.includes('OPERATION_SCOPE_INVALID'));
});

test('historical used without an admitted operation is not silently reset or accepted', t => {
  const f = fixture(t);
  f.store.run(`INSERT INTO web_ip_windows(id,ip_hash,starts_at,expires_at,used,reserved)
    VALUES (?,?,?,?,1,0)`, randomUUID(), '1'.repeat(64), f.now(), f.now() + day);
  const result = preflightWebDataPolicy(f.store, f.clock, f.key);
  assert.equal(result.consistent, false);
  assert.ok(result.reasons.includes('WINDOW_COUNTER_MISMATCH'));
  assert.equal(result.quotas[0]?.usedTotal, 1, 'do not erase the historical used lower bound');
});

test('schema drift and trial character mismatch reject without normalizing records', t => {
  const f = fixture(t), user = f.guest();
  f.admit(user.boot.principalId, '2'.repeat(64), 'one');
  f.store.run('UPDATE web_principals SET trial_character_id=NULL WHERE id=?', user.boot.principalId);
  assert.ok(preflightWebDataPolicy(f.store, f.clock, f.key).reasons.includes('TRIAL_SCOPE_INVALID'));
  f.store.db.exec('PRAGMA user_version=108'); // explicit fault injection, never a migration path
  const schema = preflightWebDataPolicy(f.store, f.clock, f.key);
  assert.deepEqual(schema.reasons, ['SCHEMA_NOT_109']);
  assert.equal(schema.migrationAuthorized, false);
});

test('time overflow and missing key lineage fail closed without touching rows', t => {
  const f = fixture(t), user = f.guest();
  f.admit(user.boot.principalId, 'e'.repeat(64), 'one');
  assert.throws(() => preflightWebDataPolicy(f.store, { now: () => Number.MAX_SAFE_INTEGER }, f.key),
    /WEB_DATA_PREFLIGHT_CLOCK_INVALID/);
  const bad = preflightWebDataPolicy(f.store, f.clock,
    { kind: 'synthetic-fixture', instanceId: 'wrong', recoveryEpoch: f.key.kind === 'synthetic-fixture' ?
      f.key.recoveryEpoch : '', fingerprint: 'a'.repeat(64) });
  assert.ok(bad.reasons.includes('KEY_SOURCE_UNVERIFIED'));
  assert.equal(bad.consistent, false);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_operations')!.n, 1);
});

test('external capacity follows not_sent, sent, unknown and known across provider/phase keys', t => {
  const f = fixture(t), user = f.guest();
  const op = f.admit(user.boot.principalId, '3'.repeat(64), 'ledger');
  const queue = new WebStageQueue(f.store, f.clock, randomUUID);
  const ledger = new WebDispatchLedger(f.store, f.clock);
  ledger.configureBudget({ provider: 'fixture-a', stage: 'text', phase: 'review', capacity: 2 });
  ledger.configureBudget({ provider: 'fixture-b', stage: 'audio', phase: 'speech', capacity: 2 });
  const coordinator = queue.acquireCoordinator('fixture-owner');
  const claim = queue.claimText(coordinator, 'fixture-text')!;
  const key = ledger.reserve(claim, { phase: 'review', ordinal: -1, provider: 'fixture-a',
    providerRequestId: 'fixture-review' });
  const snapshots = [preflightWebDataPolicy(f.store, f.clock, f.key)];
  ledger.markSent(claim, key);
  snapshots.push(preflightWebDataPolicy(f.store, f.clock, f.key));
  f.advance(31_000);
  const successor = queue.acquireCoordinator('fixture-successor');
  assert.equal(ledger.recover(successor, ledger.fence(op.operationId)).status, 'unknown');
  snapshots.push(preflightWebDataPolicy(f.store, f.clock, f.key));
  ledger.confirm(key, { outcome: 'failed', receipt: { origin: 'fixture', id: 'one' }, usage: { calls: 1 } });
  snapshots.push(preflightWebDataPolicy(f.store, f.clock, f.key));
  assert.ok(snapshots.every(s => s.consistent && s.migrationAuthorized === false));
  assert.equal(snapshots[2]!.unknownExternalAttempts, 1);
  assert.equal(snapshots[3]!.unknownExternalAttempts, 0);
  assert.equal(f.store.get<{ reserved: number }>(`SELECT reserved FROM web_external_budgets
    WHERE provider='fixture-a' AND stage='text' AND phase='review'`)?.reserved, 0);
  assert.equal(f.store.get<{ reserved: number }>(`SELECT reserved FROM web_external_budgets
    WHERE provider='fixture-b' AND stage='audio' AND phase='speech'`)?.reserved, 0);
  assert.equal(new Set(snapshots.map(s => s.sourceDigest)).size, snapshots.length,
    'each persisted dispatch transition changes source identity');
});

test('budget conservation and receipt/usage evidence change digest without exposing JSON', t => {
  const f = fixture(t), user = f.guest();
  const op = f.admit(user.boot.principalId, '4'.repeat(64), 'evidence');
  const queue = new WebStageQueue(f.store, f.clock, randomUUID);
  const ledger = new WebDispatchLedger(f.store, f.clock);
  ledger.configureBudget({ provider: 'fixture', stage: 'text', phase: 'draft', capacity: 2 });
  const claim = queue.claimText(queue.acquireCoordinator('fixture-owner'), 'fixture-text')!;
  const key = ledger.reserve(claim, { phase: 'draft', ordinal: -1, provider: 'fixture',
    providerRequestId: 'fixture-draft' });
  ledger.markSent(claim, key);
  const before = preflightWebDataPolicy(f.store, f.clock, f.key);
  assert.equal(before.consistent, true);
  f.store.run("UPDATE web_external_budgets SET reserved=0 WHERE provider='fixture'");
  const broken = preflightWebDataPolicy(f.store, f.clock, f.key);
  assert.equal(broken.consistent, false);
  assert.ok(broken.reasons.includes('EXTERNAL_BUDGET_MISMATCH'));
  assert.notEqual(broken.sourceDigest, before.sourceDigest);
  f.store.run("UPDATE web_external_budgets SET reserved=1 WHERE provider='fixture'");
  ledger.confirm(key, { outcome: 'failed', receipt: { secret: 'receipt-one' },
    usage: { units: 1 } });
  const known = preflightWebDataPolicy(f.store, f.clock, f.key);
  assert.equal(known.consistent, true);
  f.store.run('UPDATE web_external_attempts SET receipt_json=?,usage_json=? WHERE operation_id=?',
    JSON.stringify({ secret: 'receipt-two' }), JSON.stringify({ units: 2 }), op.operationId);
  const changed = preflightWebDataPolicy(f.store, f.clock, f.key);
  assert.notEqual(changed.sourceDigest, known.sourceDigest);
  assert.equal(changed.consistent, true);
  assert.ok(!JSON.stringify(changed).includes('receipt-two'));
  assert.ok(!JSON.stringify(changed).includes('units'));
  f.store.db.exec('PRAGMA foreign_keys=OFF'); // Deliberate orphan fault, not a migration path.
  try { f.store.run("DELETE FROM web_external_budgets WHERE provider='fixture'"); }
  finally { f.store.db.exec('PRAGMA foreign_keys=ON'); }
  const orphan = preflightWebDataPolicy(f.store, f.clock, f.key);
  assert.equal(orphan.consistent, false);
  assert.ok(orphan.reasons.includes('ATTEMPT_BUDGET_MISSING'));
});

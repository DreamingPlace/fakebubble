import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { WebStore } from '../../../apps/server/platform/store.ts';
import { WebIdentity } from '../../../apps/server/identity/web-identity.ts';
import { WebAdmission } from '../../../apps/server/admission/web-admission.ts';
import { WebStageQueue } from '../../../apps/server/admission/web-stage-queue.ts';
import { WebDispatchLedger } from '../../../apps/server/budget/web-dispatch-ledger.ts';
import { WebLocalExecutor } from '../../../apps/server/platform/web-local-executor.ts';
import { initLocalInstance, localRuntime } from '../../../apps/server/platform/web-local-config.ts';
import {
  preflightWebDataPolicy,
  type DataPolicyKeySource,
} from '../../../apps/server/platform/web-data-policy-preflight.ts';
import { defaultSchedule } from '../../../packages/domain/defaults.ts';

const hour = 60 * 60_000;
const day = 24 * hour;
const origin = 'https://127.0.0.1:18461';

function fixture(t: TestContext) {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'web-c-data-'));
  const store = new WebStore(join(parent, 'instance'), { create: true, instanceId: randomUUID() });
  t.after(() => {
    store.close();
    rmSync(parent, { recursive: true, force: true });
  });
  const epoch = randomUUID();
  store.migrateStages();
  store.migrateAdmissionOrder();
  store.migrateIdentity(epoch);
  store.migrateDispatchLedger();
  store.migrateSyntheticVoiceQueue();
  store.migrateInputSnapshot();
  store.migrateSyntheticPrivateAudio();
  store.migrateVerticalCandidate();
  store.migrateLocalTransport();
  let now = 1_700_000_000_000;
  const clock = { now: () => now };
  const identity = new WebIdentity(store, {
    origin,
    cookieName: '__Host-c_data',
    clock,
    keys: { keyId: 'c-fixture', sealKey: Buffer.alloc(32, 11), requestKey: Buffer.alloc(32, 12) },
  });
  store.run(
    'INSERT INTO character_templates VALUES (?,?,?)',
    'c-synthetic',
    1,
    JSON.stringify({
      id: 'c-synthetic',
      name: 'C synthetic',
      version: 1,
      fictional: true,
      persona: 'offline verification only',
      schedule: defaultSchedule(),
    }),
  );
  const key: DataPolicyKeySource = {
    kind: 'synthetic-fixture',
    instanceId: store.instanceId,
    recoveryEpoch: epoch,
    fingerprint: 'a'.repeat(64),
  };
  const guest = () => {
    const boot = identity.bootstrap(),
      scope = identity.authenticate(boot.issuedToken!);
    store.run("INSERT INTO world_characters VALUES (?,?,'new')", scope.world_id, 'c-synthetic');
    return { boot, scope };
  };
  const admit = (principalId: string, ipHash: string, requestId: string) =>
    new WebAdmission(store, clock, randomUUID).admit({
      principalId,
      requestId,
      characterId: 'c-synthetic',
      text: `C input ${requestId}`,
      ipHash,
    });
  const publish = (operationId: string) => {
    const executor = new WebLocalExecutor(store, clock);
    try {
      executor.start();
      for (let i = 0; i < 12 && !store.get('SELECT 1 FROM web_publications WHERE operation_id=?', operationId); i++)
        executor.pump();
      assert.ok(store.get('SELECT 1 FROM web_publications WHERE operation_id=?', operationId));
    } finally {
      executor.stop();
    }
  };
  const sentAttempt = (operationId: string) => {
    const queue = new WebStageQueue(store, clock, randomUUID);
    const ledger = new WebDispatchLedger(store, clock);
    const coordinator = queue.acquireCoordinator('c-data');
    const claim = queue.claimText(coordinator, 'c-text')!;
    assert.equal(claim.operationId, operationId);
    ledger.configureBudget({ provider: 'c-fake', stage: 'text', phase: 'draft', capacity: 4 });
    const attempt = ledger.reserve(claim, {
      phase: 'draft',
      ordinal: -1,
      provider: 'c-fake',
      providerRequestId: `c-${operationId}`,
    });
    ledger.markSent(claim, attempt);
    return { ledger, attempt };
  };
  return {
    store,
    clock,
    key,
    identity,
    guest,
    admit,
    publish,
    sentAttempt,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}

function fullSnapshot(store: WebStore) {
  const tables = store.db
    .prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string; sql: string }[];
  const rows = tables.map(
    ({ name }) =>
      [
        name,
        (store.db.prepare(`SELECT * FROM \"${name}\"`).all() as Record<string, unknown>[])
          .map((row) => JSON.stringify(row))
          .sort(),
      ] as const,
  );
  return {
    version: store.get('PRAGMA user_version'),
    tables,
    rows,
    totalChanges: store.get('SELECT total_changes() n'),
  };
}

test('C-DATA: populated UNKNOWN snapshot is deterministic and changes no business table, budget, or schema', (t) => {
  const f = fixture(t),
    first = f.guest(),
    second = f.guest();
  f.publish(f.admit(first.boot.principalId, 'a'.repeat(64), 'published').operationId);
  const pending = f.admit(second.boot.principalId, 'b'.repeat(64), 'unknown');
  f.sentAttempt(pending.operationId);
  f.store.run("UPDATE web_external_attempts SET dispatch_state='unknown' WHERE operation_id=?", pending.operationId);
  const before = fullSnapshot(f.store);
  const one = preflightWebDataPolicy(f.store, f.clock, f.key);
  const two = preflightWebDataPolicy(f.store, f.clock, f.key);
  assert.deepEqual(two, one);
  assert.equal(one.consistent, true);
  assert.equal(one.unknownExternalAttempts, 1);
  assert.equal(one.migrationAuthorized, false);
  assert.equal(one.historicalKeyLineageProven, false);
  assert.deepEqual(fullSnapshot(f.store), before);
  assert.equal(f.store.db.isTransaction, false);
});

test('C-DATA: old windows above three accumulate, original trial survives upgrade, and 2h never slides', async (t) => {
  const f = fixture(t),
    ip = 'c'.repeat(64),
    first = f.guest();
  const firstAt = f.now();
  f.publish(f.admit(first.boot.principalId, ip, 'first').operationId);
  f.advance(hour);
  f.publish(f.admit(first.boot.principalId, ip, 'second').operationId);
  await f.identity.register(first.boot.issuedToken!, first.boot.csrf, origin, {
    requestId: 'register-c',
    username: 'c-fixture-account',
    password: 'test-passphrase',
  });
  for (let i = 0; i < 3; i++) {
    f.advance(day + 1);
    const user = f.guest();
    f.publish(f.admit(user.boot.principalId, ip, `later-${i}`).operationId);
  }
  const snapshot = preflightWebDataPolicy(f.store, f.clock, f.key);
  assert.equal(snapshot.consistent, true);
  assert.equal(snapshot.quotas[0]?.usedTotal, 5);
  assert.equal(snapshot.quotas[0]?.overLimit, true);
  assert.equal(snapshot.quotas[0]?.windowIds.length, 4);
  assert.deepEqual(
    snapshot.retention.find((row) => row.principalId === first.boot.principalId),
    {
      principalId: first.boot.principalId,
      kind: 'account',
      firstTrialAcceptedAt: firstAt,
      expiresAt: firstAt + 2 * hour,
      protectedByUpgrade: true,
    },
  );
});

test('C-DATA: actual attempt scope corruption and future operation time fail closed', (t) => {
  const f = fixture(t),
    user = f.guest(),
    other = f.guest();
  const op = f.admit(user.boot.principalId, 'd'.repeat(64), 'scope');
  f.sentAttempt(op.operationId);
  f.store.run(
    'UPDATE web_external_attempts SET principal_id=? WHERE operation_id=?',
    other.boot.principalId,
    op.operationId,
  );
  const badScope = preflightWebDataPolicy(f.store, f.clock, f.key);
  assert.equal(badScope.consistent, false);
  assert.ok(badScope.reasons.includes('ATTEMPT_SCOPE_INVALID'));
  f.store.run(
    'UPDATE web_external_attempts SET principal_id=? WHERE operation_id=?',
    user.boot.principalId,
    op.operationId,
  );
  f.store.run('UPDATE web_operations SET created_at=? WHERE id=?', f.now() + 1, op.operationId);
  const badTime = preflightWebDataPolicy(f.store, f.clock, f.key);
  assert.equal(badTime.consistent, false);
  assert.ok(badTime.reasons.includes('OPERATION_TIME_INVALID'));
});

test('C-DATA: external budget mismatch must not be reported as a consistent source', (t) => {
  const f = fixture(t),
    user = f.guest(),
    op = f.admit(user.boot.principalId, 'e'.repeat(64), 'budget');
  f.sentAttempt(op.operationId);
  const before = preflightWebDataPolicy(f.store, f.clock, f.key);
  assert.equal(before.consistent, true);
  assert.equal(
    f.store.get<{ reserved: number }>("SELECT reserved FROM web_external_budgets WHERE provider='c-fake'")?.reserved,
    1,
  );
  f.store.run("UPDATE web_external_budgets SET reserved=0 WHERE provider='c-fake'");
  const after = preflightWebDataPolicy(f.store, f.clock, f.key);
  assert.deepEqual(
    { consistent: after.consistent, digestChanged: after.sourceDigest !== before.sourceDigest },
    { consistent: false, digestChanged: true },
    'external budget conservation and source identity must both change',
  );
});

test('C-DATA: receipt evidence change must change sourceDigest', (t) => {
  const f = fixture(t),
    user = f.guest(),
    op = f.admit(user.boot.principalId, 'f'.repeat(64), 'receipt');
  const { ledger, attempt } = f.sentAttempt(op.operationId);
  ledger.confirm(attempt, { outcome: 'failed', receipt: { origin: 'c-fixture', code: 'one' }, usage: { calls: 1 } });
  const before = preflightWebDataPolicy(f.store, f.clock, f.key);
  assert.equal(before.consistent, true);
  f.store.run(
    'UPDATE web_external_attempts SET receipt_json=? WHERE operation_id=?',
    JSON.stringify({ origin: 'c-fixture', code: 'two' }),
    op.operationId,
  );
  const after = preflightWebDataPolicy(f.store, f.clock, f.key);
  assert.notEqual(after.sourceDigest, before.sourceDigest, 'different stored receipt cannot share source identity');
});

test('C-DATA: runtime config binds current instance and epoch; mismatched epoch fails', (t) => {
  const parent = localRuntime().parent;
  mkdirSync(parent, { recursive: true });
  const root = join(parent, `local-c-data-${randomUUID().slice(0, 12)}`);
  const initialized = initLocalInstance(root);
  const store = new WebStore(root, { create: false, instanceId: initialized.instanceId });
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  store.migrateStages();
  store.migrateAdmissionOrder();
  const configFile = join(root, 'local-config.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8')) as { recoveryEpoch: string };
  store.migrateIdentity(config.recoveryEpoch);
  store.migrateDispatchLedger();
  store.migrateSyntheticVoiceQueue();
  store.migrateInputSnapshot();
  store.migrateSyntheticPrivateAudio();
  store.migrateVerticalCandidate();
  store.migrateLocalTransport();
  const clock = { now: () => 1_700_000_000_000 };
  const valid = preflightWebDataPolicy(store, clock, { kind: 'runtime-config' });
  assert.equal(valid.consistent, true);
  assert.equal(valid.keySource, 'runtime-config');
  assert.equal(valid.migrationAuthorized, false);
  writeFileSync(configFile, JSON.stringify({ ...config, recoveryEpoch: randomUUID() }), { mode: 0o600 });
  const wrong = preflightWebDataPolicy(store, clock, { kind: 'runtime-config' });
  assert.equal(wrong.consistent, false);
  assert.ok(wrong.reasons.includes('KEY_BINDING_MISMATCH'));
});

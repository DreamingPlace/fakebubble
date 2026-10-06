import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WebStore } from '../../../apps/server/platform/store.ts';
import { WebIdentity } from '../../../apps/server/identity/web-identity.ts';
import { WebAdmission } from '../../../apps/server/admission/web-admission.ts';
import { WebStageQueue } from '../../../apps/server/admission/web-stage-queue.ts';
import { WebDispatchLedger } from '../../../apps/server/budget/web-dispatch-ledger.ts';
import { textRequest } from '../../text-fixtures.ts';
import { readWebV7Request } from '../../../apps/server/generation/web-v7-request.ts';
import { syntheticText, syntheticTone } from '../../../apps/server/platform/web-local-fake.ts';

test('109 explicit migration preserves 108 rows and emits new admission in its transaction', () => {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'web-local-migration-'));
  try {
    const root = join(parent, 'instance'),
      instanceId = randomUUID();
    const store = new WebStore(root, { create: true, instanceId });
    try {
      store.migrateStages();
      store.migrateAdmissionOrder();
      store.migrateIdentity(randomUUID());
      store.migrateDispatchLedger();
      store.migrateSyntheticVoiceQueue();
      store.migrateInputSnapshot();
      store.migrateSyntheticPrivateAudio();
      store.migrateVerticalCandidate();
      const clock = { now: () => 1_700_000_000_000 };
      const identity = new WebIdentity(store, {
        origin: 'https://127.0.0.1:18451',
        cookieName: '__Host-local-test',
        clock,
        keys: { keyId: 'synthetic', sealKey: Buffer.alloc(32, 1), requestKey: Buffer.alloc(32, 2) },
      });
      const guest = identity.bootstrap(),
        scope = identity.authenticate(guest.issuedToken!);
      store.run(
        'INSERT INTO character_templates VALUES (?,?,?)',
        'character',
        1,
        JSON.stringify({ ...textRequest().character, id: 'character' }),
      );
      store.run("INSERT INTO world_characters VALUES (?,?,'new')", scope.world_id, 'character');
      const admission = new WebAdmission(store, clock, randomUUID);
      admission.admit({
        principalId: guest.principalId,
        requestId: 'before',
        characterId: 'character',
        text: 'before',
        ipHash: 'a'.repeat(64),
      });
      store.run('CREATE TABLE web_local_events (blocking INTEGER)');
      assert.throws(() => store.migrateLocalTransport());
      assert.equal(store.get<{ user_version: number }>('PRAGMA user_version')!.user_version, 108);
      assert.equal(
        store.all<{ name: string }>('PRAGMA table_info(web_operations)').some((row) => row.name === 'failure_code'),
        false,
      );
      assert.equal(store.get(`SELECT 1 FROM sqlite_master WHERE name='web_local_text_outputs'`), undefined);
      store.run('DROP TABLE web_local_events');
      store.migrateLocalTransport();
      assert.equal(store.get<{ n: number }>('SELECT count(*) n FROM web_local_events')!.n, 0);
      const after = admission.admit({
        principalId: guest.principalId,
        requestId: 'after',
        characterId: 'character',
        text: 'after',
        ipHash: 'a'.repeat(64),
      });
      const event = store.get<{ payload_json: string }>(
        "SELECT payload_json FROM web_local_events WHERE kind='operation'",
      );
      assert.equal(JSON.parse(event!.payload_json).operationId, after.operationId);
      assert.equal(store.get<{ user_version: number }>('PRAGMA user_version')!.user_version, 109);
    } finally {
      store.close();
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('109 late speech receipt after coordinator takeover settles cost without recoverable bytes', (t) => {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'web-local-audio-late-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const store = new WebStore(join(parent, 'instance'), { create: true, instanceId: randomUUID() });
  t.after(() => store.close());
  store.migrateStages();
  store.migrateAdmissionOrder();
  store.migrateIdentity(randomUUID());
  store.migrateDispatchLedger();
  store.migrateSyntheticVoiceQueue();
  store.migrateInputSnapshot();
  store.migrateSyntheticPrivateAudio();
  store.migrateVerticalCandidate();
  store.migrateLocalTransport();
  let now = 1_700_000_000_000;
  const clock = { now: () => now };
  const identity = new WebIdentity(store, {
    origin: 'https://127.0.0.1:18451',
    cookieName: '__Host-local-test',
    clock,
    keys: { keyId: 'synthetic', sealKey: Buffer.alloc(32, 1), requestKey: Buffer.alloc(32, 2) },
  });
  const guest = identity.bootstrap(),
    scope = identity.authenticate(guest.issuedToken!);
  store.run(
    'INSERT INTO character_templates VALUES (?,?,?)',
    'character',
    1,
    JSON.stringify({ ...textRequest().character, id: 'character' }),
  );
  store.run("INSERT INTO world_characters VALUES (?,?,'new')", scope.world_id, 'character');
  const admitted = new WebAdmission(store, clock, randomUUID).admit({
    principalId: guest.principalId,
    requestId: 'late-speech',
    characterId: 'character',
    text: 'late speech',
    ipHash: 'a'.repeat(64),
  });
  const queue = new WebStageQueue(store, clock, randomUUID),
    ledger = new WebDispatchLedger(store, clock);
  const old = queue.acquireCoordinator('first'),
    textClaim = queue.claimText(old, 'first-text')!;
  const output = syntheticText(readWebV7Request(store, admitted.operationId).request);
  for (const phase of ['draft', 'review'] as const) {
    ledger.configureBudget({ provider: 'synthetic-local', stage: 'text', phase, capacity: 4 });
    const key = ledger.reserve(textClaim, {
      phase,
      ordinal: -1,
      provider: 'synthetic-local',
      providerRequestId: `${admitted.operationId}:${phase}`,
    });
    ledger.markSent(textClaim, key);
    ledger.confirm(key, {
      outcome: 'succeeded',
      receipt: {
        origin: 'synthetic_test',
        outputDigest: createHash('sha256').update(JSON.stringify(output[phase])).digest('hex'),
      },
      usage: { calls: 1 },
      output: output[phase],
    });
  }
  assert.equal(store.get<{ n: number }>('SELECT count(*) n FROM web_local_text_outputs')!.n, 2);
  queue.completeReviewedText(textClaim, output);
  ledger.configureBudget({ provider: 'synthetic-local', stage: 'audio', phase: 'speech', capacity: 4 });
  const audioClaim = queue.claimAudio(old, 'first-audio')!;
  const key = ledger.reserve(audioClaim, {
    phase: 'speech',
    ordinal: 0,
    provider: 'synthetic-local',
    providerRequestId: `${admitted.operationId}:speech:0`,
  });
  ledger.markSent(audioClaim, key);
  const bytes = syntheticTone(),
    result = {
      outcome: 'succeeded' as const,
      receipt: { origin: 'synthetic_test', outputDigest: createHash('sha256').update(bytes).digest('hex') },
      usage: { calls: 1 },
      output: bytes,
    };
  now += 31_000;
  const successor = queue.acquireCoordinator('second');
  assert.equal(ledger.confirm(key, result).duplicate, false);
  assert.equal(ledger.confirm(key, result).duplicate, true);
  assert.equal(store.get<{ n: number }>('SELECT count(*) n FROM web_local_audio_outputs')!.n, 0);
  assert.equal(
    store.get<{ reserved: number }>(`SELECT reserved FROM web_external_budgets
    WHERE provider='synthetic-local' AND stage='audio' AND phase='speech'`)!.reserved,
    0,
  );
  assert.equal(ledger.recover(successor, ledger.fence(admitted.operationId)).status, 'failed');
  assert.equal(store.get<{ n: number }>('SELECT count(*) n FROM web_publications')!.n, 0);
});

for (const migrationMoment of ['before-dispatch', 'after-unknown', 'after-known'] as const)
  test(`${migrationMoment}: 109 preserves old or late text receipt without inventing output`, (t) => {
    const parent = mkdtempSync(join(realpathSync(tmpdir()), 'web-local-late-'));
    t.after(() => rmSync(parent, { recursive: true, force: true }));
    const store = new WebStore(join(parent, 'instance'), { create: true, instanceId: randomUUID() });
    t.after(() => store.close());
    store.migrateStages();
    store.migrateAdmissionOrder();
    store.migrateIdentity(randomUUID());
    store.migrateDispatchLedger();
    store.migrateSyntheticVoiceQueue();
    store.migrateInputSnapshot();
    store.migrateSyntheticPrivateAudio();
    store.migrateVerticalCandidate();
    let now = 1_700_000_000_000;
    const clock = { now: () => now };
    const identity = new WebIdentity(store, {
      origin: 'https://127.0.0.1:18451',
      cookieName: '__Host-local-test',
      clock,
      keys: { keyId: 'synthetic', sealKey: Buffer.alloc(32, 1), requestKey: Buffer.alloc(32, 2) },
    });
    const guest = identity.bootstrap(),
      scope = identity.authenticate(guest.issuedToken!);
    store.run(
      'INSERT INTO character_templates VALUES (?,?,?)',
      'character',
      1,
      JSON.stringify({ ...textRequest().character, id: 'character' }),
    );
    store.run("INSERT INTO world_characters VALUES (?,?,'new')", scope.world_id, 'character');
    const admission = new WebAdmission(store, clock, randomUUID),
      queue = new WebStageQueue(store, clock, randomUUID);
    const ledger = new WebDispatchLedger(store, clock);
    const admitted = admission.admit({
      principalId: guest.principalId,
      requestId: 'late',
      characterId: 'character',
      text: 'late',
      ipHash: 'a'.repeat(64),
    });
    if (migrationMoment === 'before-dispatch') store.migrateLocalTransport();
    ledger.configureBudget({ provider: 'fake', stage: 'text', phase: 'draft', capacity: 1 });
    const coordinator = queue.acquireCoordinator('first'),
      claim = queue.claimText(coordinator, 'text')!;
    const key = ledger.reserve(claim, { phase: 'draft', ordinal: -1, provider: 'fake', providerRequestId: 'late' });
    ledger.markSent(claim, key);
    if (migrationMoment !== 'before-dispatch') {
      assert.throws(() => store.migrateLocalTransport(), /WEB_LOCAL_MIGRATION_UNSAFE/);
      assert.equal(store.get<{ user_version: number }>('PRAGMA user_version')!.user_version, 108);
    }
    const result = {
      outcome: 'succeeded' as const,
      receipt: { origin: 'synthetic_test', outputDigest: 'old' },
      usage: { calls: 1 },
    };
    if (migrationMoment === 'after-known') {
      assert.equal(ledger.confirm(key, result).duplicate, false);
      now += 301_000;
      const nextCoordinator = queue.acquireCoordinator('second');
      assert.equal(
        ledger.terminate(nextCoordinator, ledger.fence(admitted.operationId), guest.principalId, 'failed', 'expired')
          .status,
        'failed',
      );
    } else {
      now += 31_000;
      const nextCoordinator = queue.acquireCoordinator('second');
      assert.equal(ledger.recover(nextCoordinator, ledger.fence(admitted.operationId)).status, 'unknown');
    }
    if (migrationMoment === 'after-unknown') store.migrateLocalTransport();
    if (migrationMoment === 'after-known') store.migrateLocalTransport();
    if (migrationMoment !== 'after-known') assert.equal(ledger.confirm(key, result).duplicate, false);
    assert.equal(ledger.confirm(key, result).duplicate, true);
    assert.equal(
      store.get<{ status: string }>('SELECT status FROM web_operations WHERE id=?', admitted.operationId)!.status,
      migrationMoment === 'after-known' ? 'failed' : 'unknown',
    );
    assert.equal(store.get<{ n: number }>('SELECT count(*) n FROM web_local_text_outputs')!.n, 0);
  });

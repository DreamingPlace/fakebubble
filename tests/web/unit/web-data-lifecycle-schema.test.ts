import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { WebStore } from '../../../apps/server/store.ts';
import { WebIdentity } from '../../../apps/server/web-identity.ts';
import { WebAdmission } from '../../../apps/server/web-admission.ts';
import { WebRetentionCleaner } from '../../../apps/server/web-retention-cleaner.ts';
import { WebDispatchLedger } from '../../../apps/server/web-dispatch-ledger.ts';
import { WebStageQueue } from '../../../apps/server/web-stage-queue.ts';
import { WebLocalExecutor } from '../../../apps/server/web-local-executor.ts';
import { webReceiptDigest } from '../../../apps/server/web-retention.ts';
import { WebPrivateAudioFiles } from '../../../apps/server/web-private-audio-files.ts';
import { syntheticTone } from '../../../apps/server/web-local-fake.ts';
import { initLocalInstance, localRuntime, readLocalConfig } from '../../../apps/server/web-local-config.ts';
import { defaultSchedule } from '../../../packages/domain/defaults.ts';

test('INCOMPLETE 110 schema candidate is explicit, scoped, and does not make ordinary reopen runnable', async (t) => {
  const { parent } = localRuntime();
  mkdirSync(parent, { recursive: true });
  const root = join(parent, `local-a3-${randomUUID().slice(0, 12)}`);
  const initialized = initLocalInstance(root);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new WebStore(root, { create: false, instanceId: initialized.instanceId, dataLifecycleTest: true });
  t.after(() => store.close());
  store.migrateStages();
  store.migrateAdmissionOrder();
  const config = readLocalConfig(root);
  store.migrateIdentity(config.recoveryEpoch);
  store.migrateDispatchLedger();
  store.migrateSyntheticVoiceQueue();
  store.migrateInputSnapshot();
  store.migrateSyntheticPrivateAudio();
  store.migrateVerticalCandidate();
  store.migrateLocalTransport();
  store.run(
    'INSERT INTO character_templates VALUES (?,?,?)',
    'synthetic-a3',
    1,
    JSON.stringify({
      id: 'synthetic-a3',
      name: '合成',
      version: 1,
      fictional: true,
      persona: 'only for local offline migration test',
      schedule: defaultSchedule(),
    }),
  );
  let now = 1_700_000_000_000;
  const clock = { now: () => now };
  const identity = new WebIdentity(store, {
    origin: config.origin,
    cookieName: config.cookieName,
    clock,
    keys: {
      keyId: 'a3',
      sealKey: Buffer.from(config.sealKey, 'base64url'),
      requestKey: Buffer.from(config.requestKey, 'base64url'),
    },
  });
  const guest = identity.bootstrap();
  const scope = identity.authenticate(guest.issuedToken!);
  store.run("INSERT INTO world_characters VALUES (?,?,'new')", scope.world_id, 'synthetic-a3');
  const admitted = new WebAdmission(store, clock, randomUUID).admit({
    principalId: guest.principalId,
    requestId: 'first',
    characterId: 'synthetic-a3',
    text: 'synthetic only',
    ipHash: 'a'.repeat(64),
  });
  assert.equal(store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 109);
  store.run('UPDATE web_ip_windows SET reserved=0 WHERE ip_hash=?', 'a'.repeat(64));
  assert.throws(() => store.migrateDataLifecycle(clock), /WEB_DATA_MIGRATION_SOURCE_UNSAFE/);
  assert.equal(store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 109);
  assert.equal(store.get("SELECT 1 FROM sqlite_master WHERE name='web_guest_retention'"), undefined);
  store.run('UPDATE web_ip_windows SET reserved=1 WHERE ip_hash=?', 'a'.repeat(64));
  store.db.exec('CREATE TABLE synthetic_unrecognized_payload(world_id TEXT,body TEXT)');
  store.run('INSERT INTO synthetic_unrecognized_payload VALUES (?,?)', scope.world_id, 'must reject before 110 DDL');
  assert.throws(() => store.migrateDataLifecycle(clock), /WEB_RETENTION_UNEXPECTED_WORLD_DATA/);
  assert.equal(store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 109);
  store.db.exec('DROP TABLE synthetic_unrecognized_payload');
  const migrationQueue = new WebStageQueue(store, clock, randomUUID);
  const liveCoordinator = migrationQueue.acquireCoordinator('synthetic-migration-blocker');
  assert.throws(() => store.migrateDataLifecycle(clock), /WEB_DATA_MIGRATION_ACTIVE_WORK/);
  migrationQueue.releaseCoordinator(liveCoordinator);
  let migrationClockReads = 0;
  assert.equal(
    store.migrateDataLifecycle({
      now: () => {
        migrationClockReads++;
        if (migrationClockReads !== 1) throw new Error('migration must freeze its clock');
        return now;
      },
    })?.length,
    64,
  );
  assert.equal(migrationClockReads, 1);
  assert.equal(store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 110);
  assert.deepEqual(
    {
      ...store.get<{ used_total: number; reserved_total: number }>(
        'SELECT used_total,reserved_total FROM web_ip_lifetime_quota',
      ),
    },
    { used_total: 0, reserved_total: 1 },
  );
  assert.deepEqual(
    {
      ...store.get<{ started_at: number; expires_at: number; state: string }>(
        'SELECT started_at,expires_at,state FROM web_guest_retention',
      ),
    },
    { started_at: clock.now(), expires_at: clock.now() + 2 * 60 * 60_000, state: 'active' },
  );
  const admission110 = new WebAdmission(store, clock, randomUUID);
  now += 2 * 60 * 60_000;
  assert.throws(
    () =>
      admission110.admit({
        principalId: guest.principalId,
        requestId: 'first',
        characterId: 'synthetic-a3',
        text: 'synthetic only',
        ipHash: 'a'.repeat(64),
      }),
    /TRIAL_EXPIRED/,
  );
  await assert.rejects(
    identity.register(guest.issuedToken!, guest.csrf, config.origin, {
      requestId: 'expired-register',
      username: 'expired-a3',
      password: 'test-passphrase',
    }),
    /TRIAL_EXPIRED/,
  );
  now += 24 * 60 * 60_000 + 1;
  const second = identity.bootstrap();
  const secondScope = identity.authenticate(second.issuedToken!);
  store.run("INSERT INTO world_characters VALUES (?,?,'new')", secondScope.world_id, 'synthetic-a3');
  const secondAdmitted = admission110.admit({
    principalId: second.principalId,
    requestId: 'second',
    characterId: 'synthetic-a3',
    text: 'same IP later',
    ipHash: 'a'.repeat(64),
  });
  const queue = new WebStageQueue(store, clock, randomUUID);
  const coordinator = queue.acquireCoordinator('synthetic-a3-test');
  assert.equal(queue.claimText(coordinator, 'synthetic-a3-test')?.operationId, secondAdmitted.operationId);
  const mediaId = randomUUID(),
    bytes = syntheticTone();
  const audioExpected = {
    byteLength: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    durationMs: 250,
  };
  store.run(
    `INSERT INTO web_synthetic_voice_segments
    (operation_id,ordinal,text_digest,voice_version,state) VALUES (? ,0,'synthetic-text','synthetic-voice','pending')`,
    secondAdmitted.operationId,
  );
  store.run(
    `INSERT INTO web_private_audio_assets
    (operation_id,ordinal,media_id,origin,principal_id,player_id,world_id,conversation_id,
    character_id,input_message_id,text_digest,voice_version,format,byte_length,sha256,duration_ms,
    state,lease_epoch,lease_token,lease_until,created_at)
    VALUES (?,0,?,'synthetic_test',?,?,?,?,'synthetic-a3',?,'synthetic-text','synthetic-voice',
      'wav_pcm16',?,?,?,'preparing',0,'synthetic-lease',?,?)`,
    secondAdmitted.operationId,
    mediaId,
    second.principalId,
    secondScope.player_id,
    secondScope.world_id,
    secondAdmitted.conversationId,
    secondAdmitted.inputMessageId,
    audioExpected.byteLength,
    audioExpected.sha256,
    audioExpected.durationMs,
    now + 1000,
    now,
  );
  const files = new WebPrivateAudioFiles(root);
  files.write(mediaId, bytes, audioExpected);
  assert.deepEqual(files.read(mediaId, audioExpected), bytes);
  assert.deepEqual(
    {
      ...store.get<{ used_total: number; reserved_total: number }>(
        'SELECT used_total,reserved_total FROM web_ip_lifetime_quota',
      ),
    },
    { used_total: 0, reserved_total: 2 },
  );
  assert.equal(
    store.get<{ n: number }>('SELECT count(*) n FROM web_ip_windows')?.n,
    1,
    'new admission reuses the old window as an FK slot, not as a renewal clock',
  );
  store.run(`INSERT INTO web_external_budgets(provider,stage,phase,capacity,reserved)
    VALUES ('synthetic-local','text','draft',1,1)`);
  store.run(
    `INSERT INTO web_external_attempts(operation_id,stage,phase,ordinal,provider,
    provider_request_id,dispatch_state,stage_version,lease_epoch,lease_token,principal_id,
    world_id,conversation_id,input_message_id,created_at,sent_at)
    VALUES (?,'text','draft',-1,'synthetic-local',?,'sent',1,1,'synthetic-lease',
      ?,?,?,?, ?,?)`,
    secondAdmitted.operationId,
    `${secondAdmitted.operationId}:draft`,
    second.principalId,
    secondScope.world_id,
    secondAdmitted.conversationId,
    secondAdmitted.inputMessageId,
    now,
    now,
  );
  now += 2 * 60 * 60_000;
  const cleaner = new WebRetentionCleaner(store, clock);
  store.db.exec(`CREATE TRIGGER synthetic_t1_fault BEFORE UPDATE OF status ON web_operations
    WHEN OLD.principal_id='${second.principalId}' BEGIN SELECT RAISE(ABORT,'synthetic T1 fault'); END`);
  assert.throws(() => cleaner.markExpired(second.principalId), /synthetic T1 fault/);
  assert.equal(
    store.get<{ state: string }>('SELECT state FROM web_guest_retention WHERE principal_id=?', second.principalId)
      ?.state,
    'active',
  );
  assert.equal(
    store.get<{ reserved_total: number }>(
      `SELECT reserved_total FROM web_ip_lifetime_quota
    WHERE ip_hash=?`,
      'a'.repeat(64),
    )?.reserved_total,
    2,
  );
  store.db.exec('DROP TRIGGER synthetic_t1_fault');
  assert.deepEqual(cleaner.markExpired(second.principalId), { duplicate: false });
  store.db.exec('CREATE TABLE synthetic_unrecognized_payload(world_id TEXT,body TEXT)');
  store.run(
    'INSERT INTO synthetic_unrecognized_payload VALUES (?,?)',
    secondScope.world_id,
    'must not be silently skipped',
  );
  assert.throws(() => cleaner.clearDatabase(second.principalId), /WEB_RETENTION_UNEXPECTED_WORLD_DATA/);
  assert.ok(
    store.get('SELECT 1 FROM messages WHERE id=?', secondAdmitted.inputMessageId),
    'failed T2 remains wholly rolled back',
  );
  store.db.exec('DROP TABLE synthetic_unrecognized_payload');
  store.db.exec(`CREATE TRIGGER synthetic_t2_fault BEFORE DELETE ON messages
    WHEN OLD.world_id='${secondScope.world_id}' BEGIN SELECT RAISE(ABORT,'synthetic T2 fault'); END`);
  assert.throws(() => cleaner.clearDatabase(second.principalId), /synthetic T2 fault/);
  assert.equal(
    store.get('SELECT 1 FROM web_retention_purge_gate'),
    undefined,
    'T2 rollback must not leave a global delete gate',
  );
  assert.ok(store.get('SELECT 1 FROM messages WHERE id=?', secondAdmitted.inputMessageId));
  store.db.exec('DROP TRIGGER synthetic_t2_fault');
  assert.deepEqual(cleaner.clearDatabase(second.principalId), { duplicate: false });
  writeFileSync(join(files.root, `${mediaId}.wav`), Buffer.from('tampered'));
  assert.throws(() => cleaner.clearFiles(second.principalId), /WEB_PRIVATE_AUDIO_INTEGRITY/);
  assert.equal(
    store.get<{ state: string }>('SELECT state FROM web_guest_retention WHERE principal_id=?', second.principalId)
      ?.state,
    'purging',
  );
  writeFileSync(join(files.root, `${mediaId}.wav`), bytes);
  const cleanerFiles = (cleaner as unknown as { files: WebPrivateAudioFiles }).files;
  const faultTarget = cleanerFiles as unknown as { syncDirectory: (path: string) => void };
  const originalSync = faultTarget.syncDirectory;
  try {
    faultTarget.syncDirectory = function (path) {
      if (path === files.root) throw new Error('synthetic directory fsync fault');
      return originalSync.call(cleanerFiles, path);
    };
    assert.throws(() => cleaner.clearFiles(second.principalId), /synthetic directory fsync fault/);
    assert.equal(
      existsSync(join(files.root, `${mediaId}.wav`)),
      false,
      'unlink succeeded before directory fsync failed',
    );
    assert.equal(
      store.get<{ state: string }>('SELECT state FROM web_retention_file_cleanup WHERE media_id=?', mediaId)?.state,
      'pending',
    );
    assert.throws(
      () => cleaner.clearFiles(second.principalId),
      /synthetic directory fsync fault/,
      'ENOENT retry must still require directory durability',
    );
    assert.equal(
      store.get<{ state: string }>('SELECT state FROM web_retention_file_cleanup WHERE media_id=?', mediaId)?.state,
      'pending',
    );
  } finally {
    faultTarget.syncDirectory = originalSync;
  }
  cleaner.clearFiles(second.principalId);
  cleaner.clearFiles(second.principalId);
  assert.throws(() => files.read(mediaId, audioExpected), /WEB_PRIVATE_AUDIO_UNAVAILABLE/);
  assert.equal(store.get('SELECT 1 FROM messages WHERE id=?', secondAdmitted.inputMessageId), undefined);
  assert.ok(
    store.get('SELECT 1 FROM messages WHERE id=?', admitted.inputMessageId),
    'the other principal is not physically touched',
  );
  assert.deepEqual(
    {
      ...store.get<{ used_total: number; reserved_total: number }>(
        'SELECT used_total,reserved_total FROM web_ip_lifetime_quota',
      ),
    },
    { used_total: 0, reserved_total: 1 },
  );
  assert.equal(
    store.get<{ state: string }>('SELECT state FROM web_guest_retention WHERE principal_id=?', second.principalId)
      ?.state,
    'purged',
  );
  assert.equal(store.get<{ foreign_keys: number }>('PRAGMA foreign_keys')?.foreign_keys, 1);
  assert.equal(store.get('PRAGMA foreign_key_check'), undefined);
  const lateKey = {
    operationId: secondAdmitted.operationId,
    stage: 'text' as const,
    phase: 'draft' as const,
    ordinal: -1,
  };
  const lateResult = {
    outcome: 'succeeded' as const,
    receipt: { origin: 'synthetic_test', privateText: 'must-not-retain' },
    usage: { calls: 1 },
  };
  const ledger = new WebDispatchLedger(store, clock);
  assert.deepEqual(ledger.confirm(lateKey, lateResult), { duplicate: false });
  assert.deepEqual(ledger.confirm(lateKey, lateResult), { duplicate: true });
  assert.throws(() => ledger.confirm(lateKey, { ...lateResult, usage: { calls: 2 } }), /WEB_DISPATCH_RECEIPT_CONFLICT/);
  assert.deepEqual(
    {
      ...store.get<{
        receipt_json: string | null;
        usage_json: string | null;
        receipt_digest: string | null;
        usage_digest: string | null;
      }>(
        `SELECT receipt_json,usage_json,
    receipt_digest,usage_digest FROM web_external_attempts WHERE operation_id=?`,
        lateKey.operationId,
      )!,
    },
    {
      receipt_json: null,
      usage_json: null,
      receipt_digest: webReceiptDigest(store, 'receipt', JSON.stringify(lateResult.receipt)),
      usage_digest: webReceiptDigest(store, 'usage', JSON.stringify(lateResult.usage)),
    },
  );
  assert.equal(
    store.get<{ reserved: number }>(`SELECT reserved FROM web_external_budgets
    WHERE provider='synthetic-local' AND stage='text' AND phase='draft'`)?.reserved,
    0,
  );
  store.run(
    `INSERT INTO web_local_text_outputs VALUES (?,'draft','digest','{}','digest',?)`,
    admitted.operationId,
    clock.now(),
  );
  assert.throws(
    () => store.run('DELETE FROM web_local_text_outputs WHERE operation_id=?', admitted.operationId),
    /WEB_TEXT_OUTPUT_IMMUTABLE/,
  );
  store.run(
    "UPDATE web_guest_retention SET state='purging',revision=revision+1 WHERE principal_id=?",
    guest.principalId,
  );
  store.run('INSERT INTO web_retention_purge_gate VALUES (?,?,?)', second.principalId, secondScope.world_id, 3);
  assert.throws(
    () => store.run('DELETE FROM web_local_text_outputs WHERE operation_id=?', admitted.operationId),
    /WEB_TEXT_OUTPUT_IMMUTABLE/,
    'another principal gate cannot delete this output',
  );
  store.run('DELETE FROM web_retention_purge_gate WHERE principal_id=?', second.principalId);
  store.run(`INSERT INTO web_retention_purge_gate VALUES (?,?,?)`, guest.principalId, scope.world_id, 2);
  assert.equal(store.run('DELETE FROM web_local_text_outputs WHERE operation_id=?', admitted.operationId).changes, 1);
  store.run('DELETE FROM web_retention_purge_gate WHERE principal_id=?', guest.principalId);
  store.run('UPDATE web_operations SET input_message_id=NULL WHERE id=?', admitted.operationId);
  store.run('DELETE FROM outbox WHERE message_id=?', admitted.inputMessageId);
  assert.equal(store.run('DELETE FROM messages WHERE id=?', admitted.inputMessageId).changes, 1);
  assert.equal(store.get('PRAGMA foreign_key_check'), undefined);
  assert.throws(
    () => new WebStore(root, { create: false, instanceId: initialized.instanceId }),
    /WEB_SCHEMA_MISMATCH|UNSUPPORTED_SCHEMA/,
    '110 is denied to ordinary runtime',
  );
  const reopened = new WebStore(root, { create: false, instanceId: initialized.instanceId, dataLifecycleTest: true });
  assert.equal(reopened.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 110);
  reopened.close();
  assert.throws(
    () => new WebStore(root, { create: false, instanceId: randomUUID(), dataLifecycleTest: true }),
    /WEB_INSTANCE_MISMATCH/,
  );
  const configPath = join(root, 'local-config.json'),
    originalConfig = readFileSync(configPath);
  try {
    const configData = JSON.parse(originalConfig.toString('utf8')) as Record<string, unknown>;
    writeFileSync(configPath, JSON.stringify({ ...configData, mode: 'live' }));
    assert.throws(
      () => new WebStore(root, { create: false, instanceId: initialized.instanceId, dataLifecycleTest: true }),
      /WEB_LOCAL_CONFIG_INVALID|WEB_DATA_TEST_CONFIG_INVALID/,
    );
    writeFileSync(configPath, JSON.stringify({ ...configData, origin: 'https://0.0.0.0:18451' }));
    assert.throws(
      () => new WebStore(root, { create: false, instanceId: initialized.instanceId, dataLifecycleTest: true }),
      /WEB_LOCAL_CONFIG_INVALID|WEB_DATA_TEST_CONFIG_INVALID/,
    );
    writeFileSync(configPath, JSON.stringify({ ...configData, recoveryEpoch: randomUUID() }));
    assert.throws(
      () => new WebStore(root, { create: false, instanceId: initialized.instanceId, dataLifecycleTest: true }),
      /WEB_DATA_TEST_EPOCH_MISMATCH/,
    );
  } finally {
    writeFileSync(configPath, originalConfig);
  }
});

test('INCOMPLETE 110 synthetic executor publishes, then bounded sweep removes its private graph', async (t) => {
  const { parent } = localRuntime();
  mkdirSync(parent, { recursive: true });
  const root = join(parent, `local-a3-run-${randomUUID().slice(0, 12)}`);
  const initialized = initLocalInstance(root);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = readLocalConfig(root),
    store = new WebStore(root, { create: false, instanceId: initialized.instanceId, dataLifecycleTest: true });
  t.after(() => store.close());
  store.migrateStages();
  store.migrateAdmissionOrder();
  store.migrateIdentity(config.recoveryEpoch);
  store.migrateDispatchLedger();
  store.migrateSyntheticVoiceQueue();
  store.migrateInputSnapshot();
  store.migrateSyntheticPrivateAudio();
  store.migrateVerticalCandidate();
  store.migrateLocalTransport();
  store.run(
    'INSERT INTO character_templates VALUES (?,?,?)',
    'synthetic-a3',
    1,
    JSON.stringify({
      id: 'synthetic-a3',
      name: '合成',
      version: 1,
      fictional: true,
      persona: 'offline test only',
      schedule: defaultSchedule(),
    }),
  );
  let now = 1_700_000_000_000;
  const clock = { now: () => now };
  const identity = new WebIdentity(store, {
    origin: config.origin,
    cookieName: config.cookieName,
    clock,
    keys: {
      keyId: 'a3',
      sealKey: Buffer.from(config.sealKey, 'base64url'),
      requestKey: Buffer.from(config.requestKey, 'base64url'),
    },
  });
  const guest = identity.bootstrap(),
    scope = identity.authenticate(guest.issuedToken!);
  store.run("INSERT INTO world_characters VALUES (?,?,'new')", scope.world_id, 'synthetic-a3');
  const admitted = new WebAdmission(store, clock, randomUUID).admit({
    principalId: guest.principalId,
    requestId: 'published',
    characterId: 'synthetic-a3',
    text: 'synthetic private marker',
    ipHash: 'c'.repeat(64),
  });
  store.migrateDataLifecycle(clock);
  const executor = new WebLocalExecutor(store, clock);
  t.after(() => executor.stop());
  executor.start();
  for (
    let i = 0;
    i < 30 && !store.get('SELECT 1 FROM web_publications WHERE operation_id=?', admitted.operationId);
    i++
  ) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    executor.pump();
  }
  assert.equal(executor.lastError, null);
  assert.equal(
    store.get<{ status: string }>('SELECT status FROM web_operations WHERE id=?', admitted.operationId)?.status,
    'published',
  );
  assert.equal(
    store.get<{ n: number }>('SELECT count(*) n FROM web_publication_items WHERE operation_id=?', admitted.operationId)
      ?.n,
    1,
  );
  const publishedAudio = store.get<{ media_id: string; byte_length: number; sha256: string; duration_ms: number }>(
    'SELECT media_id,byte_length,sha256,duration_ms FROM web_private_audio_assets WHERE operation_id=?',
    admitted.operationId,
  )!;
  const privateFiles = new WebPrivateAudioFiles(root);
  const publishedExpectation = {
    byteLength: publishedAudio.byte_length,
    sha256: publishedAudio.sha256,
    durationMs: publishedAudio.duration_ms,
  };
  assert.ok(privateFiles.read(publishedAudio.media_id, publishedExpectation).length > 0);
  now += 2 * 60 * 60_000;
  executor.stop();
  const restarted = new WebLocalExecutor(store, clock);
  t.after(() => restarted.stop());
  restarted.start();
  assert.equal(
    store.get<{ state: string }>('SELECT state FROM web_guest_retention WHERE principal_id=?', guest.principalId)
      ?.state,
    'purged',
  );
  assert.equal(store.get('SELECT 1 FROM messages WHERE id=?', admitted.inputMessageId), undefined);
  assert.equal(store.get('SELECT 1 FROM web_publications WHERE operation_id=?', admitted.operationId), undefined);
  assert.throws(
    () => privateFiles.read(publishedAudio.media_id, publishedExpectation),
    /WEB_PRIVATE_AUDIO_UNAVAILABLE/,
  );
  assert.equal(store.get('PRAGMA foreign_key_check'), undefined);
});

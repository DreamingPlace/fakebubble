import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { WebStore } from '../../../apps/server/platform/store.ts';
import { WebIdentity } from '../../../apps/server/identity/web-identity.ts';
import { WebAdmission } from '../../../apps/server/admission/web-admission.ts';
import { WebLocalExecutor } from '../../../apps/server/platform/web-local-executor.ts';
import { initLocalInstance, localRuntime, readLocalConfig } from '../../../apps/server/platform/web-local-config.ts';
import { defaultSchedule } from '../../../packages/domain/defaults.ts';

function fixture(t: TestContext) {
  const { parent, port } = localRuntime();
  assert.ok([18441, 18451, 18461, 18491].includes(port));
  mkdirSync(parent, { recursive: true });
  const root = join(parent, `local-invite-${randomUUID().slice(0, 12)}`);
  const initialized = initLocalInstance(root);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = readLocalConfig(root);
  assert.equal(config.instanceId, initialized.instanceId);
  let now = 1_700_000_000_000;
  const clock = { now: () => now };
  const store = new WebStore(root, {
    create: false,
    instanceId: config.instanceId,
    dataLifecycleTest: true,
    inviteTest: true,
  });
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
  store.migrateDataLifecycle(clock);
  store.migrateInviteCore();
  store.migrateInviteIdentity();
  store.run(
    'INSERT INTO character_templates VALUES (?,?,?)',
    'synthetic',
    1,
    JSON.stringify({
      id: 'synthetic',
      name: '合成',
      version: 1,
      fictional: true,
      persona: 'isolated invite executor only',
      schedule: defaultSchedule(),
    }),
  );
  const identity = new WebIdentity(store, {
    origin: config.origin,
    cookieName: config.cookieName,
    clock,
    keys: {
      keyId: 'synthetic',
      sealKey: Buffer.from(config.sealKey, 'base64url'),
      requestKey: Buffer.from(config.requestKey, 'base64url'),
    },
  });
  const boot = identity.bootstrap(),
    scope = identity.authenticate(boot.issuedToken!);
  store.run("INSERT INTO world_characters VALUES (?,'synthetic','new')", scope.world_id);
  store.run("UPDATE web_principals SET kind='invite' WHERE id=?", boot.principalId);
  store.run("UPDATE web_guest_retention SET state='protected',expires_at=NULL WHERE principal_id=?", boot.principalId);
  store.run('INSERT INTO admin_sessions VALUES (?,?,?,?,NULL)', 'admin', 'hash', now, now + 10_000);
  store.run(
    `INSERT INTO web_invite_codes(id,code_digest,issue_request_id,issue_digest,
    capacity,redeemed_count,redeem_by,access_duration_ms,status,batch,note,created_by,created_at)
    VALUES ('code','digest','issue','issue-digest',1,1,NULL,NULL,'active','synthetic',NULL,'admin',?)`,
    now,
  );
  store.run(
    `INSERT INTO web_invite_grants VALUES ('grant','code',?,?,?,?,NULL,NULL)`,
    boot.principalId,
    scope.player_id,
    scope.world_id,
    now,
  );
  const admitted = new WebAdmission(store, clock, randomUUID).admit({
    principalId: boot.principalId,
    requestId: 'invite-send',
    characterId: 'synthetic',
    text: '请回复',
    ipHash: 'a'.repeat(64),
  });
  return {
    store,
    clock,
    admitted,
    principalId: boot.principalId,
    revoke: () => store.run('UPDATE web_invite_grants SET revoked_at=? WHERE id=?', now, 'grant'),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test('112 invited principal completes synthetic text, speech and atomic publication', async (t) => {
  const f = fixture(t),
    executor = new WebLocalExecutor(f.store, f.clock);
  t.after(() => executor.stop());
  executor.start();
  for (
    let i = 0;
    i < 12 && !f.store.get('SELECT 1 FROM web_publications WHERE operation_id=?', f.admitted.operationId);
    i++
  ) {
    executor.pump();
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(executor.lastError, null);
  assert.equal(
    f.store.get<{ status: string }>('SELECT status FROM web_operations WHERE id=?', f.admitted.operationId)?.status,
    'published',
  );
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_local_text_outputs')?.n, 2);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_local_audio_outputs')?.n, 1);
  assert.ok(f.store.get('SELECT 1 FROM web_publications WHERE operation_id=?', f.admitted.operationId));
});

test('112 invite revoked after speech sent cannot attach or publish; sent cost stays unknown', async (t) => {
  const f = fixture(t);
  const executor = new WebLocalExecutor(f.store, f.clock, {
    audioDelayMs: 25,
    afterSpeechSent: () => f.revoke(),
  });
  t.after(() => executor.stop());
  executor.start();
  await new Promise((resolve) => setTimeout(resolve, 45));
  for (let i = 0; i < 3; i++) {
    executor.pump();
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(
    f.store.get<{ status: string }>('SELECT status FROM web_operations WHERE id=?', f.admitted.operationId)?.status,
    'failed',
  );
  assert.equal(
    f.store.get<{ failure_code: string }>('SELECT failure_code FROM web_operations WHERE id=?', f.admitted.operationId)
      ?.failure_code,
    'AUTH_REVOKED',
  );
  assert.equal(f.store.get('SELECT 1 FROM web_publications WHERE operation_id=?', f.admitted.operationId), undefined);
  assert.equal(
    f.store.get('SELECT 1 FROM web_private_audio_assets WHERE operation_id=?', f.admitted.operationId),
    undefined,
  );
  assert.equal(
    f.store.get<{ dispatch_state: string }>(
      `SELECT dispatch_state FROM web_external_attempts
    WHERE operation_id=? AND stage='audio'`,
      f.admitted.operationId,
    )?.dispatch_state,
    'unknown',
  );
});

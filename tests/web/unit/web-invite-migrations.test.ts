import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { WebStore } from '../../../apps/server/store.ts';
import { WebIdentity } from '../../../apps/server/web-identity.ts';
import { WebAdmission } from '../../../apps/server/web-admission.ts';
import { WebStageQueue, claimRetention } from '../../../apps/server/web-stage-queue.ts';
import { WebRetentionCleaner } from '../../../apps/server/web-retention-cleaner.ts';
import { initLocalInstance, localRuntime, readLocalConfig } from '../../../apps/server/web-local-config.ts';
import { defaultSchedule } from '../../../packages/domain/defaults.ts';
import { WEB_LIMITS } from '../../../config/web-v1.ts';

test('only a new role-scoped synthetic invite root can explicitly advance 110→111→112', t => {
  const { parent, port } = localRuntime();
  assert.ok([18441, 18451, 18461, 18491].includes(port), 'only registered A/B/C/S synthetic ports are approved');
  mkdirSync(parent, { recursive: true });
  const root = join(parent, `local-invite-${randomUUID().slice(0, 12)}`);
  const initialized = initLocalInstance(root);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = readLocalConfig(root);
  assert.equal(config.instanceId, initialized.instanceId);
  let now = 1_700_000_000_000;
  const clock = { now: () => now };
  const base = new WebStore(root, { create: false, instanceId: config.instanceId,
    dataLifecycleTest: true });
  base.migrateStages(); base.migrateAdmissionOrder(); base.migrateIdentity(config.recoveryEpoch);
  base.migrateDispatchLedger(); base.migrateSyntheticVoiceQueue(); base.migrateInputSnapshot();
  base.migrateSyntheticPrivateAudio(); base.migrateVerticalCandidate(); base.migrateLocalTransport();
  base.migrateDataLifecycle(clock);
  base.close();
  assert.throws(() => new WebStore(root, { create: false, instanceId: config.instanceId }),
    /WEB_SCHEMA_MISMATCH|UNSUPPORTED_SCHEMA/);
  const invite = new WebStore(root, { create: false, instanceId: config.instanceId,
    dataLifecycleTest: true, inviteTest: true });
  t.after(() => invite.close());
  assert.equal(invite.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 110);
  invite.migrateInviteCore();
  assert.equal(invite.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 111);
  assert.throws(() => invite.migrateInviteCore(), /WEB_INVITE_MIGRATION_REQUIRED/);
  invite.migrateInviteIdentity();
  assert.equal(invite.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 112);
  assert.throws(() => invite.migrateInviteIdentity(), /WEB_INVITE_IDENTITY_MIGRATION_REQUIRED/);
  assert.equal(invite.get('PRAGMA foreign_key_check'), undefined);
  assert.throws(() => new WebStore(root, { create: false, instanceId: config.instanceId,
    dataLifecycleTest: true }), /WEB_DATA_TEST_SCHEMA_REQUIRED/);
  const reopened = new WebStore(root, { create: false, instanceId: config.instanceId,
    dataLifecycleTest: true, inviteTest: true });
  assert.equal(reopened.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 112);
  reopened.run('INSERT INTO character_templates VALUES (?,?,?)', 'synthetic-invite', 1,
    JSON.stringify({ id: 'synthetic-invite', name: '合成', version: 1, fictional: true,
      persona: 'isolated queue test only', schedule: defaultSchedule() }));
  const identity = new WebIdentity(reopened, { origin: config.origin, cookieName: config.cookieName,
    clock, keys: { keyId: 'synthetic-invite', sealKey: Buffer.from(config.sealKey, 'base64url'),
      requestKey: Buffer.from(config.requestKey, 'base64url') } });
  const admission = new WebAdmission(reopened, clock, randomUUID);
  const actors: { principalId: string; playerId: string; worldId: string }[] = [];
  for (let i = 0; i < 5; i++) {
    const boot = identity.bootstrap();
    const scope = identity.authenticate(boot.issuedToken!);
    reopened.run("INSERT INTO world_characters VALUES (?,'synthetic-invite','new')", scope.world_id);
    admission.admit({ principalId: boot.principalId, requestId: `queue-${i}`,
      characterId: 'synthetic-invite', text: `synthetic ${i}`, ipHash: String(i).repeat(64) });
    actors.push({ principalId: boot.principalId, playerId: scope.player_id, worldId: scope.world_id });
  }
  const upgrade = (index: number, kind: 'account' | 'invite') => {
    const actor = actors[index]!;
    reopened.run('UPDATE web_principals SET kind=? WHERE id=?', kind, actor.principalId);
    reopened.run("UPDATE web_guest_retention SET state='protected',expires_at=NULL WHERE principal_id=?",
      actor.principalId);
    return actor;
  };
  const account = upgrade(0, 'account'), valid = upgrade(2, 'invite');
  const revoked = upgrade(3, 'invite'), expired = upgrade(4, 'invite');
  reopened.run(`INSERT INTO web_accounts(id,principal_id,username_norm,password_salt,password_tag,created_at)
    VALUES (?,?,?,?,?,?)`, 'account-synthetic', account.principalId, 'synthetic',
  Buffer.alloc(16), Buffer.alloc(32), clock.now());
  reopened.run('INSERT INTO admin_sessions VALUES (?,?,?,?,NULL)', 'admin-synthetic', 'hash',
    clock.now(), clock.now() + 10000);
  for (const [index, actor] of [valid, revoked, expired].entries()) {
    const id = `invite-${index}`;
    reopened.run(`INSERT INTO web_invite_codes(id,code_digest,issue_request_id,issue_digest,
      capacity,redeemed_count,redeem_by,access_duration_ms,status,batch,note,created_by,created_at)
      VALUES (?,?,?,?,1,1,NULL,NULL,'active','synthetic',NULL,'admin-synthetic',?)`, id,
    `digest-${index}`, `issue-${index}`, `issue-digest-${index}`, clock.now());
    reopened.run(`INSERT INTO web_invite_grants VALUES (?,?,?,?,?,?,?,?)`, `grant-${index}`,
      id, actor.principalId, actor.playerId, actor.worldId, clock.now() - 100,
      index === 2 ? clock.now() : null, index === 1 ? clock.now() - 1 : null);
  }
  const admit = (principalId: string, requestId: string, ipHash = 'a'.repeat(64)) =>
    admission.admit({ principalId, requestId, characterId: 'synthetic-invite',
      text: `synthetic ${requestId}`, ipHash });
  const accountNext = admit(account.principalId, 'account-next');
  const guestNext = admit(actors[1]!.principalId, 'guest-next', '1'.repeat(64));
  const inviteNext = admit(valid.principalId, 'invite-next');
  assert.equal(admit(valid.principalId, 'invite-next').operationId, inviteNext.operationId,
    'idempotent invite replay does not enqueue twice');
  assert.throws(() => admit(revoked.principalId, 'revoked-next'), /WEB_INVITE_ACCESS_REQUIRED/);
  assert.throws(() => admit(expired.principalId, 'expired-next'), /WEB_INVITE_ACCESS_REQUIRED/);
  assert.throws(() => admission.finalize(inviteNext.operationId, 'cancelled'),
    /WEB_DISPATCH_FENCE_REQUIRED/);
  const operations = reopened.all<{ id: string; principal_id: string; status: string;
    quota_state: string; text_queued_at: number; admission_seq: number; deadline_at: number }>(
    'SELECT id,principal_id,status,quota_state,text_queued_at,admission_seq,deadline_at FROM web_operations ORDER BY admission_seq');
  assert.equal(operations.length, 8);
  assert.deepEqual(operations.map(op => op.admission_seq), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.ok(operations.every(op => op.status === 'queued' && op.quota_state === 'reserved' &&
    op.text_queued_at === clock.now() && op.deadline_at > clock.now()));
  assert.deepEqual(operations.slice(-3).map(op => op.id),
    [accountNext.operationId, guestNext.operationId, inviteNext.operationId]);
  const retention = claimRetention(112, clock.now());
  const rawEligible = reopened.all<{ principal_id: string }>(`SELECT DISTINCT o.principal_id FROM web_operations o
    WHERE 1=1 ${retention.sql}`, ...retention.args);
  const eligible = rawEligible.map(row => row.principal_id);
  assert.ok(eligible.every(Boolean), JSON.stringify(rawEligible));
  assert.deepEqual(new Set(eligible), new Set([account.principalId,
    actors[1]!.principalId, valid.principalId]));
  const runnable = reopened.all<{ principal_id: string }>(`SELECT o.principal_id FROM web_operations o
    WHERE o.status='queued' AND o.quota_state='reserved' AND o.text_queued_at IS NOT NULL
      AND o.text_queued_at<=? AND ?<min(o.text_queued_at+?,o.deadline_at)
      ${retention.sql}
      AND (SELECT count(*) FROM web_operations other WHERE other.principal_id=o.principal_id
        AND other.id<>o.id AND other.status IN
        ('text_running','text_ready','audio_pending','audio_running','ready_to_publish','retryable_failed','unknown'))<?
      AND (SELECT count(*) FROM web_operations other WHERE other.conversation_id=o.conversation_id
        AND other.id<>o.id AND other.status IN
        ('text_running','text_ready','audio_pending','audio_running','ready_to_publish','retryable_failed','unknown'))<?`,
  clock.now(), clock.now(), WEB_LIMITS.queueWaitMs, ...retention.args,
  WEB_LIMITS.maxPrincipalActive, WEB_LIMITS.maxConversationActive).map(row => row.principal_id);
  assert.deepEqual(new Set(runnable), new Set(eligible));
  assert.equal(reopened.get<{ n: number }>('SELECT count(*) n FROM web_operations')?.n, 8,
    'denied and replayed requests do not allocate operations');
  const queue = new WebStageQueue(reopened, clock, randomUUID);
  const lease = queue.acquireCoordinator('synthetic-112');
  const claims = Array.from({ length: 3 }, () => queue.claimText(lease, 'synthetic-112'));
  assert.deepEqual(new Set(claims.map(claim => claim?.principalId)), new Set([
    account.principalId, actors[1]!.principalId, valid.principalId]));
  assert.ok(claims.every(claim => claim && reopened.get('SELECT 1 FROM web_v7_requests WHERE operation_id=?',
    claim.operationId)), 'accepted operations freeze V7 context before any supplier attempt');
  assert.equal(queue.claimText(lease, 'synthetic-112'), null,
    'revoked/expired invite and second same-principal requests cannot bypass stage capacity');
  const cleaner = new WebRetentionCleaner(reopened, clock);
  const inviteMessages = () => reopened.get<{ n: number }>(
    'SELECT count(*) n FROM messages WHERE world_id=?', valid.worldId)!.n;
  assert.ok(inviteMessages() > 0);
  now += 2 * 60 * 60_000;
  assert.equal(cleaner.sweep(), 1, 'only the expired guest enters T1/T2/F');
  assert.equal(reopened.get<{ state: string }>(
    'SELECT state FROM web_guest_retention WHERE principal_id=?', actors[1]!.principalId)?.state,
  'purged');
  assert.equal(reopened.get<{ n: number }>(
    'SELECT count(*) n FROM messages WHERE world_id=?', actors[1]!.worldId)?.n, 0);
  assert.ok(inviteMessages() > 0, 'invite narrative remains after guest purge');
  for (const actor of [valid, revoked, expired]) {
    assert.equal(reopened.get<{ state: string }>(
      'SELECT state FROM web_guest_retention WHERE principal_id=?', actor.principalId)?.state,
    'protected');
    assert.throws(() => cleaner.markExpired(actor.principalId), /WEB_RETENTION_SCOPE_INVALID/);
    assert.throws(() => cleaner.clearDatabase(actor.principalId), /WEB_RETENTION_NOT_PURGING/);
  }
  reopened.close();
});

test('invite test flag rejects non-invite synthetic root and missing data-lifecycle guard', t => {
  const { parent, port } = localRuntime();
  assert.ok([18441, 18451, 18461, 18491].includes(port));
  mkdirSync(parent, { recursive: true });
  const root = join(parent, `local-plain-${randomUUID().slice(0, 12)}`);
  const initialized = initLocalInstance(root);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(() => new WebStore(root, { create: false, instanceId: initialized.instanceId,
    inviteTest: true }), /WEB_INVITE_TEST_SCOPE_REQUIRED/);
  assert.throws(() => new WebStore(root, { create: false, instanceId: initialized.instanceId,
    dataLifecycleTest: true, inviteTest: true }), /WEB_INVITE_TEST_ROOT_REQUIRED/);
  const configPath = join(root, 'local-config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as { port: number; origin: string };
  assert.equal(config.port, port);
  config.port = port === 18441 ? 18451 : 18441;
  config.origin = `https://127.0.0.1:${config.port}`;
  writeFileSync(configPath, JSON.stringify(config));
  assert.throws(() => new WebStore(root, { create: false, instanceId: initialized.instanceId,
    dataLifecycleTest: true }), /WEB_LOCAL_CONFIG_INVALID/);
});

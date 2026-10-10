import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { WebStore } from '../../../apps/server/platform/store.ts';
import { WebIdentity } from '../../../apps/server/identity/web-identity.ts';
import { WebAdmission } from '../../../apps/server/admission/web-admission.ts';
import { WebRetentionCleaner } from '../../../apps/server/admission/web-retention-cleaner.ts';
import { initLocalInstance, localRuntime, readLocalConfig } from '../../../apps/server/platform/web-local-config.ts';
import { requireWebContent } from '../../../apps/server/admission/web-retention.ts';
import { defaultSchedule } from '../../../packages/domain/defaults.ts';

/**
 * Fix-up 11f on the Node cleaner (same schema-110 setup as web-player-logins-retention-node.test.ts): a guest with a
 * login is kept when its trial ends and purged after 180 idle days; a guest without a login purges at trial end.
 */
test('Node guest retention keeps a guest with a login at trial end and purges it after 180 idle days', (t) => {
  const { parent } = localRuntime();
  mkdirSync(parent, { recursive: true });
  const root = join(parent, `local-login-${randomUUID().slice(0, 12)}`);
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
    'synthetic-login',
    1,
    JSON.stringify({
      id: 'synthetic-login',
      name: '合成',
      version: 1,
      fictional: true,
      persona: 'only for local offline retention test',
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
      keyId: 'login',
      sealKey: Buffer.from(config.sealKey, 'base64url'),
      requestKey: Buffer.from(config.requestKey, 'base64url'),
    },
  });
  const admission = new WebAdmission(store, clock, randomUUID);
  const worlds = [0, 1].map((i) => {
    const guest = identity.bootstrap();
    const scope = identity.authenticate(guest.issuedToken!);
    store.run("INSERT INTO world_characters VALUES (?,?,'new')", scope.world_id, 'synthetic-login');
    admission.admit({
      principalId: guest.principalId,
      requestId: `request-${i}`,
      characterId: 'synthetic-login',
      text: 'synthetic only',
      ipHash: `${i}`.repeat(64),
    });
    return { guest, scope };
  });
  store.migrateDataLifecycle(clock);
  // The 118 tables, exactly as the provider migration creates them.
  store.db.exec(
    readFileSync(new URL('../../../apps/server/web-migrations/118_player_logins.sql', import.meta.url), 'utf8'),
  );
  for (const [i, { guest, scope }] of worlds.entries().filter(([i]) => i === 0)) {
    const email = `guest${i}@example.com`;
    store.run(
      'INSERT INTO web_player_logins VALUES (?,?,?,?,?,?)',
      guest.principalId,
      email,
      'scrypt-16384-8-5$x$y',
      now,
      now,
      now,
    );
    store.run(
      `INSERT INTO web_email_challenges(id,purpose,email_norm,principal_id,code_digest,ip_hash,created_at,expires_at)
      VALUES (?,'signup',?,?,?,?,?,?)`,
      `signup-${i}`,
      email,
      guest.principalId,
      'c'.repeat(64),
      'd'.repeat(64),
      now,
      now + 600_000,
    );
    store.run(
      `INSERT INTO web_email_challenges(id,purpose,email_norm,principal_id,code_digest,ip_hash,created_at,expires_at)
      VALUES (?,'reset',?,NULL,?,?,?,?)`,
      `reset-${i}`,
      email,
      'c'.repeat(64),
      'd'.repeat(64),
      now,
      now + 600_000,
    );
    store.run('INSERT INTO player_profile_versions VALUES (?,1,?,?)', scope.world_id, '{"name":"昵称"}', now);
  }
  const [kept, plain] = worlds;
  const count = (sql: string, ...params: string[]) => store.get<{ n: number }>(sql, ...params)!.n;
  const dataOf = (world: (typeof worlds)[number]) => ({
    messages: count('SELECT count(*) n FROM messages WHERE world_id=?', world.scope.world_id),
    logins: count('SELECT count(*) n FROM web_player_logins WHERE principal_id=?', world.guest.principalId),
    state: store.get<{ state: string }>(
      'SELECT state FROM web_guest_retention WHERE principal_id=?',
      world.guest.principalId,
    )!.state,
  });
  const before = dataOf(kept!);
  assert.ok(before.messages > 0);
  // Trial end: the guest without a login is purged exactly as before, the one with a login is untouched.
  now += 2 * 60 * 60_000 + 1;
  const cleaner = new WebRetentionCleaner(store, clock);
  assert.equal(cleaner.sweep(), 1);
  assert.equal(dataOf(plain!).state, 'purged');
  assert.deepEqual(dataOf(kept!), before);
  assert.throws(() => cleaner.markExpired(kept!.guest.principalId), /WEB_RETENTION_NOT_EXPIRED/);
  assert.throws(
    () =>
      admission.admit({
        principalId: kept!.guest.principalId,
        requestId: 'after-trial',
        characterId: 'synthetic-login',
        text: 'synthetic only',
        ipHash: 'f'.repeat(64),
      }),
    /TRIAL_EXPIRED/,
  );
  assert.equal(requireWebContent(store, clock, kept!.guest.principalId, kept!.scope.world_id, 'read').state, 'active');
  assert.throws(() => requireWebContent(store, clock, kept!.guest.principalId, kept!.scope.world_id), /TRIAL_EXPIRED/);
  // 179 idle days: still kept. 181: purged through the audited path (clearDatabase audits before and after).
  now += 179 * 24 * 60 * 60_000;
  assert.equal(cleaner.sweep(), 0);
  now += 2 * 24 * 60 * 60_000;
  assert.equal(cleaner.sweep(), 1);
  assert.deepEqual(dataOf(kept!), { messages: 0, logins: 0, state: 'purged' });
  assert.equal(count('SELECT count(*) n FROM player_profile_versions WHERE world_id=?', kept!.scope.world_id), 0);
  assert.equal(store.get('PRAGMA foreign_key_check'), undefined);
});

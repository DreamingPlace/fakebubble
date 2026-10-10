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
import { defaultSchedule } from '../../../packages/domain/defaults.ts';

/**
 * The Node retention cleaner (synthetic local mode) removes a purged guest's email login, challenges and nickname 名片
 * (schema 118). It runs on a schema-110 database here, so the 118 tables are added by hand: the cleaner decides by
 * table existence, not by schema number.
 */
test("Node guest retention removes a guest's login, challenges and nickname and keeps another world's", (t) => {
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
  for (const [i, { guest, scope }] of worlds.entries()) {
    const email = `guest${i}@example.com`;
    store.run(
      'INSERT INTO web_player_logins VALUES (?,?,?,?,?)',
      guest.principalId,
      email,
      'scrypt-16384-8-5$x$y',
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
  const [first, second] = worlds;
  const state = (world: (typeof worlds)[number]) => ({
    logins: store.get<{ n: number }>(
      'SELECT count(*) n FROM web_player_logins WHERE principal_id=?',
      world.guest.principalId,
    )!.n,
    challenges: store.get<{ n: number }>(
      'SELECT count(*) n FROM web_email_challenges WHERE principal_id=? OR email_norm=(SELECT email_norm FROM web_player_logins WHERE principal_id=?)',
      world.guest.principalId,
      world.guest.principalId,
    )!.n,
    cards: store.get<{ n: number }>(
      'SELECT count(*) n FROM player_profile_versions WHERE world_id=?',
      world.scope.world_id,
    )!.n,
  });
  assert.deepEqual(state(first!), { logins: 1, challenges: 2, cards: 1 });
  // Both worlds are guests; expire the first one only.
  now += 2 * 60 * 60_000 + 1;
  const cleaner = new WebRetentionCleaner(store, clock);
  cleaner.markExpired(first!.guest.principalId);
  cleaner.clearDatabase(first!.guest.principalId);
  assert.deepEqual(state(first!), { logins: 0, challenges: 0, cards: 0 });
  assert.deepEqual(state(second!), { logins: 1, challenges: 2, cards: 1 }, 'the other guest is untouched');
  assert.equal(store.get('PRAGMA foreign_key_check'), undefined);
});

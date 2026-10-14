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
 * The Node retention cleaner (synthetic local mode) is the second implementation of the transaction that starts a purge.
 * Like web-player-logins-retention-node.test.ts it runs on a schema-110 database to which the later tables are added by hand:
 * the cleaner decides by table existence, not by schema number.
 */
function world(t: test.TestContext, chatReview: boolean) {
  const { parent } = localRuntime();
  mkdirSync(parent, { recursive: true });
  const root = join(parent, `local-review-${randomUUID().slice(0, 12)}`);
  const initialized = initLocalInstance(root);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new WebStore(root, {
    create: false,
    instanceId: initialized.instanceId,
    dataLifecycleTest: true,
    ...(chatReview ? { chatReview: true } : {}),
  });
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
    'synthetic-review',
    1,
    JSON.stringify({
      id: 'synthetic-review',
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
      keyId: 'review',
      sealKey: Buffer.from(config.sealKey, 'base64url'),
      requestKey: Buffer.from(config.requestKey, 'base64url'),
    },
  });
  const admission = new WebAdmission(store, clock, randomUUID);
  const players = [0, 1].map((i) => {
    const guest = identity.bootstrap();
    const scope = identity.authenticate(guest.issuedToken!);
    store.run("INSERT INTO world_characters VALUES (?,?,'new')", scope.world_id, 'synthetic-review');
    admission.admit({
      principalId: guest.principalId,
      requestId: `request-${i}`,
      characterId: 'synthetic-review',
      text: `玩家${i}，我是阿泡`,
      ipHash: `${i}`.repeat(64),
    });
    return { guest, scope };
  });
  store.migrateDataLifecycle(clock);
  store.db.exec(
    readFileSync(new URL('../../../apps/server/web-migrations/118_player_logins.sql', import.meta.url), 'utf8'),
  );
  store.db.exec(
    readFileSync(new URL('../../../apps/server/web-migrations/122_chat_review.sql', import.meta.url), 'utf8'),
  );
  for (const [i, { guest, scope }] of players.entries()) {
    store.run('INSERT INTO player_profile_versions VALUES (?,1,?,?)', scope.world_id, '{"name":"阿泡"}', now);
    store.run('INSERT INTO web_review_codes VALUES (?,?,?)', guest.principalId, ['K7M2', 'Q9ZH'][i]!, now);
  }
  return {
    store,
    players,
    clock,
    advance: (ms: number) => (now += ms),
    cleaner: new WebRetentionCleaner(store, clock),
  };
}
const archive = (f: ReturnType<typeof world>) =>
  f.store.all<{ text: string; speaker: string; review_code: string }>(
    'SELECT text,speaker,review_code FROM web_review_archive ORDER BY label,line_order',
  );

test('Node cleaner, flag on: the transaction that starts the purge archives the transcript once, anonymously', (t) => {
  const f = world(t, true);
  const [first, second] = f.players;
  f.advance(2 * 60 * 60_000 + 1);
  f.cleaner.markExpired(first!.guest.principalId);
  const started = archive(f);
  assert.deepEqual(
    started.map((r) => [r.speaker, r.text]),
    [['player', '玩家0，我是〔昵称〕']],
    'the player’s line, with the nickname replaced, copied before anything was cleared',
  );
  assert.equal(
    f.store.get('SELECT 1 FROM web_review_codes WHERE principal_id=?', first!.guest.principalId),
    undefined,
    'the live code left in the same transaction',
  );
  assert.ok(f.store.get('SELECT 1 FROM web_review_codes WHERE principal_id=?', second!.guest.principalId));
  // The rest of the purge (as after a restart) archives nothing more, and a second markExpired is a no-op.
  f.cleaner.markExpired(first!.guest.principalId);
  f.cleaner.clearDatabase(first!.guest.principalId);
  assert.deepEqual(archive(f), started);
  assert.equal(f.store.get('SELECT 1 FROM messages WHERE world_id=?', first!.scope.world_id), undefined);
  // The other world is untouched and nothing about it was archived.
  assert.ok(f.store.get('SELECT 1 FROM messages WHERE world_id=?', second!.scope.world_id));
  assert.equal(f.store.get('PRAGMA foreign_key_check'), undefined);
  // sweep(): a day past 180 days the archive is emptied by the cleaner's own sweep.
  f.advance(181 * 24 * 60 * 60_000);
  f.cleaner.sweep();
  assert.deepEqual(
    archive(f).filter((r) => r.text.startsWith('玩家0')),
    [],
  );
});

test('Node cleaner, flag off: nothing is archived and the live code still goes with the player', (t) => {
  const f = world(t, false);
  const [first] = f.players;
  f.advance(2 * 60 * 60_000 + 1);
  f.cleaner.markExpired(first!.guest.principalId);
  f.cleaner.clearDatabase(first!.guest.principalId);
  assert.deepEqual(archive(f), []);
  assert.equal(f.store.get('SELECT 1 FROM web_review_codes WHERE principal_id=?', first!.guest.principalId), undefined);
});

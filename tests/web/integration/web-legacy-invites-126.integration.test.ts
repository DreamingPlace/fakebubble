import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { WebAdmission } from '../../../apps/server/admission/web-admission.ts';
import { effectiveTier } from '../../../apps/server/admission/web-model-settings.ts';
import { guestPurgeDue } from '../../../apps/server/identity/web-player-purge.ts';
import { requireWebContent, webTierSql } from '../../../apps/server/admission/web-retention.ts';
import { hasPoints } from '../../../apps/server/admission/web-points.ts';
import { migrateWebProviderLegacyInvites } from '../../../apps/server/generation/web-provider-migration.ts';
import type { WebStore } from '../../../apps/server/platform/store.ts';
import { DomainError } from '../../../packages/domain/errors.ts';
import { registerSqlTextLoader } from '../../../scripts/web-sql-text.ts';
import { enableModelChoice } from '../fixtures/model-choice.ts';
import { schema125 } from '../fixtures/invite-tiers.ts';

registerSqlTextLoader();
const { expectedWebMigrations } = await import('../../../workers/web-cloudflare/migrations.ts');

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const characterId = 'fixture-character';
const sql126 = () =>
  readFileSync(new URL('../../../apps/server/web-migrations/126_legacy_invites_retired.sql', import.meta.url), 'utf8');

/** The shapes production holds at schema 125: a legacy 'invite' principal is protected and carries a grant. */
function legacyDatabase(t: test.TestContext) {
  const store = schema125();
  t.after(() => store.close());
  Object.assign(store, { webIpKeyFingerprint: () => 'f'.repeat(64) });
  enableModelChoice(store);
  let seq = 0;
  const admission = new WebAdmission(store as WebStore, { now: () => NOW }, () => `id-${++seq}`);
  store.run('INSERT INTO character_templates(id,version,config_json) VALUES (?,?,?)', characterId, 1, '{}');
  store.run("INSERT INTO admin_sessions VALUES ('admin','h',?,?,NULL)", NOW, NOW + DAY);
  const build = (name: string, o: { login?: boolean; invite?: boolean; state?: 'purging' } = {}) => {
    const playerId = `player-${name}`,
      worldId = `world-${name}`,
      principalId = `principal-${name}`;
    store.transaction(() => {
      store.run('INSERT INTO api_players VALUES (?,?)', playerId, NOW);
      store.run('INSERT INTO worlds VALUES (?,?,?,?)', worldId, playerId, 'Asia/Singapore', '{}');
      store.run("INSERT INTO world_characters VALUES (?,?,'new')", worldId, characterId);
    });
    admission.registerGuest({ principalId, playerId, worldId });
    if (o.login)
      store.run(
        'INSERT INTO web_player_logins(principal_id,email_norm,password_hash,created_at,password_changed_at,last_seen_at) VALUES (?,?,?,?,?,?)',
        principalId,
        `${name}@example.com`,
        'x',
        NOW,
        NOW,
        NOW,
      );
    if (o.invite) {
      store.run("UPDATE web_principals SET kind='invite',revision=revision+1 WHERE id=?", principalId);
      store.run(
        "UPDATE web_guest_retention SET state='protected',started_at=NULL,expires_at=NULL,revision=revision+1 WHERE principal_id=?",
        principalId,
      );
      store.run(
        `INSERT INTO web_invite_codes(id,code_digest,issue_request_id,issue_digest,capacity,redeemed_count,status,batch,created_by,created_at)
        VALUES (?,?,?,?,1,1,'active','spring','admin',?)`,
        `invite-${name}`,
        `digest-${name}`,
        `issue-${name}`,
        'd',
        NOW - 10 * DAY,
      );
      store.run(
        'INSERT INTO web_invite_grants(id,invite_id,principal_id,player_id,world_id,redeemed_at) VALUES (?,?,?,?,?,?)',
        `grant-${name}`,
        `invite-${name}`,
        principalId,
        playerId,
        worldId,
        NOW - 5 * DAY,
      );
    }
    if (o.state === 'purging')
      store.run(
        "UPDATE web_guest_retention SET state='purging',started_at=1,expires_at=2 WHERE principal_id=?",
        principalId,
      );
    return { principalId, worldId };
  };
  return { store, build };
}
const verdict = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError) return error.code;
    throw error;
  }
  return 'live';
};

test('126 is its own step after 125, data only, and not repeatable', (t) => {
  const { store } = legacyDatabase(t);
  assert.equal(store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 125);
  const tables = () => store.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
  const before = tables();
  migrateWebProviderLegacyInvites(store);
  assert.equal(store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 126);
  assert.deepEqual(tables(), before, 'no table is created, altered or dropped');
  assert.equal(store.get('PRAGMA foreign_key_check'), undefined);
  assert.throws(() => migrateWebProviderLegacyInvites(store), /WEB_PROVIDER_LEGACY_INVITES_MIGRATION_REQUIRED/);
  // The same SQL on both authorities, the newest step.
  const { inline, r2 } = expectedWebMigrations();
  // Named exception (Part 22a2, migration 127): the ledger has 52 steps and 127 is the newest, so step counts, positions counted from the end of the ledger and expected versions moved by one again. No assertion was weakened.
  // Named exception (Part 22c, migration 128): the ledger has 53 steps and 128 is the newest, so step counts, positions counted from the end of the ledger and the expected user_version moved by one again. No assertion was weakened.
  // Named exception (Part 24a, migration 129): the ledger has 54 steps and 129 is the newest, so step counts, positions counted from the end of the ledger and the expected user_version moved by one again. No assertion was weakened.
  assert.equal(inline.at(-4)!.version, 126);
  assert.equal(inline.at(-4)!.sha256, createHash('sha256').update(sql126()).digest('hex'));
  assert.deepEqual(r2.at(-4), inline.at(-4));
});

test('126 a legacy invite principal WITH an email login is a registered player; one WITHOUT has no access and is purged like an expired guest', (t) => {
  const { store, build } = legacyDatabase(t);
  Object.assign(store, { publicFreeTier: true });
  const withLogin = build('login', { login: true, invite: true });
  const without = build('plain', { invite: true });
  const purging = build('purging', { invite: true, state: 'purging' });
  const guest = build('guest');
  const registered = build('registered', { login: true });
  const grants = store.all('SELECT * FROM web_invite_grants ORDER BY id');
  migrateWebProviderLegacyInvites(store);

  // No principal is of kind 'invite' any more, and the old tables are exactly as they were.
  assert.equal(store.get<{ n: number }>("SELECT count(*) n FROM web_principals WHERE kind='invite'")!.n, 0);
  assert.deepEqual(store.all('SELECT * FROM web_invite_grants ORDER BY id'), grants);
  const kind = (id: string) => store.get<{ kind: string }>('SELECT kind FROM web_principals WHERE id=?', id)!.kind;
  for (const who of [withLogin, without, purging, guest, registered]) assert.equal(kind(who.principalId), 'guest');
  const state = (id: string) =>
    store.get<{ state: string; started_at: number | null; expires_at: number | null }>(
      'SELECT state,started_at,expires_at FROM web_guest_retention WHERE principal_id=?',
      id,
    )!;
  assert.equal(state(purging.principalId).state, 'purging', 'a purge in progress continues as it was');
  assert.equal(state(guest.principalId).state, 'unstarted', 'a guest is untouched');

  const live = (who: { principalId: string; worldId: string }) =>
    verdict(() => requireWebContent(store, { now: () => NOW }, who.principalId, who.worldId));
  // With a login: the 17h / 17i rules of a registered player - live past its (ended) window, tier 'registered'.
  assert.equal(state(withLogin.principalId).state, 'active');
  assert.ok(state(withLogin.principalId).expires_at! < NOW, 'its window is over');
  assert.equal(live(withLogin), 'live');
  assert.equal(effectiveTier(store, withLogin.principalId, NOW)!.kind, 'registered');
  assert.equal(hasPoints(store, withLogin.principalId, NOW), true);
  // Without one: a guest past its window - no access.
  assert.equal(live(without), 'TRIAL_EXPIRED');
  assert.equal(effectiveTier(store, without.principalId, NOW)!.kind, 'guest');
  assert.equal(
    verdict(() => requireWebContent(store, { now: () => NOW }, without.principalId, without.worldId, 'read')),
    'TRIAL_EXPIRED',
  );

  // The retention cleaner's due selection (the same one the Node cleaner and the Worker alarm use) picks it up.
  const due = guestPurgeDue(store, NOW);
  const dueIds = new Set(
    store
      .all<{ principal_id: string }>(
        `SELECT r.principal_id FROM web_guest_retention r JOIN web_principals p ON p.id=r.principal_id AND p.world_id=r.world_id
        WHERE p.kind='guest' AND ${due.sql}`,
        ...due.args,
      )
      .map((row) => row.principal_id),
  );
  assert.equal(dueIds.has(without.principalId), true, 'an invite without a login is purged as an expired guest');
  assert.equal(dueIds.has(purging.principalId), true);
  assert.equal(dueIds.has(withLogin.principalId), false, 'a registered player is kept');
  assert.equal(dueIds.has(registered.principalId), false);
  assert.equal(dueIds.has(guest.principalId), false);

  // The SQL tier twin agrees with the JS tier for each shape.
  const tier = webTierSql(126, true, NOW);
  for (const [who, expected] of [
    [withLogin, 'registered'],
    [without, 'guest'],
    [guest, 'guest'],
  ] as const)
    assert.equal(
      store.get<{ tier: string }>(
        `SELECT ${tier.sql} AS tier FROM web_principals p WHERE p.id=?`,
        ...tier.args,
        who.principalId,
      )!.tier,
      expected,
    );
});

test('126 no business decision reads principal kind invite', () => {
  // A source-level guard: after Part 22x the only occurrences of the string are the entitlement source label, the retired
  // admin-runtime flag and the migration comment - never a kind comparison.
  const files = [
    'apps/server/admission/web-admission.ts',
    'apps/server/admission/web-retention.ts',
    'apps/server/admission/web-free-tier.ts',
    'apps/server/admission/web-model-settings.ts',
    'apps/server/admission/web-registered.ts',
    'apps/server/admission/web-points.ts',
    'apps/server/admission/web-stage-queue.ts',
    'apps/server/conversation/web-vertical-publisher.ts',
    'apps/server/generation/web-v7-request.ts',
    'apps/server/generation/web-provider-application.ts',
    'apps/server/identity/web-identity.ts',
    'apps/server/identity/web-player-accounts.ts',
    'apps/server/identity/web-player-purge.ts',
    'apps/server/cloudflare/web-retention.ts',
    'apps/server/platform/web-local-server.ts',
    'apps/server/platform/web-local-executor.ts',
  ];
  for (const file of files) {
    const source = readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(
      source,
      /kind\s*(===|!==|=)\s*'invite'|kind='invite'|kind\s*=\s*'invite'|'guest' \| 'invite'/,
      file,
    );
  }
});

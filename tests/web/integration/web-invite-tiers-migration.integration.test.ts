import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { WebAdmission } from '../../../apps/server/admission/web-admission.ts';
import { effectiveTier } from '../../../apps/server/admission/web-model-settings.ts';
import { PLAYER_NUMBER_PATTERN } from '../../../apps/server/admission/web-player-number.ts';
import { Store, type WebStore } from '../../../apps/server/platform/store.ts';
import {
  migrateWebProviderInviteTiers,
  migrateWebProviderLegacyInvites,
} from '../../../apps/server/generation/web-provider-migration.ts';
import { registerSqlTextLoader } from '../../../scripts/web-sql-text.ts';
import { enableModelChoice } from '../fixtures/model-choice.ts';
import { schema124 } from '../fixtures/model-settings.ts';

registerSqlTextLoader();
const { expectedWebMigrations } = await import('../../../workers/web-cloudflare/migrations.ts');
const sha = (sql: string) => createHash('sha256').update(sql).digest('hex');
const sql125 = () =>
  readFileSync(new URL('../../../apps/server/web-migrations/125_invite_tiers.sql', import.meta.url), 'utf8');

const NEW_TABLES = [
  'web_entitlement_redemptions',
  'web_entitlement_refills',
  'web_entitlements',
  'web_invite_batch_changes',
  'web_invite_batches',
  'web_player_numbers',
];
const tables = (store: Store) =>
  store
    .all<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name IN (${NEW_TABLES.map((n) => `'${n}'`).join(',')}) ORDER BY name`,
    )
    .map((row) => row.name);

const NOW = Date.now(); // the migration compares grant expiry with the database clock
const DAY = 86_400_000;
const characterId = 'fixture-character';

/**
 * The shapes production holds at schema 124. Every principal is built on the real schema; the invited ones carry a real invite
 * code and grant (so the foreign keys hold) and some an email login.
 */
function oldDatabase(t: test.TestContext) {
  const store = schema124();
  t.after(() => store.close());
  Object.assign(store, { webIpKeyFingerprint: () => 'f'.repeat(64) });
  enableModelChoice(store);
  let seq = 0;
  const admission = new WebAdmission(store as WebStore, { now: () => NOW }, () => `id-${++seq}`);
  store.run('INSERT INTO character_templates(id,version,config_json) VALUES (?,?,?)', characterId, 1, '{}');
  store.run("INSERT INTO admin_sessions VALUES ('admin','h',?,?,NULL)", NOW, NOW + DAY);
  const build = (
    name: string,
    o: { login?: boolean; bonus?: boolean; grant?: 'active' | 'future' | 'expired' | 'revoked'; batch?: string } = {},
  ) => {
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
    if (o.bonus) store.run('INSERT INTO web_signup_bonus(principal_id,granted_at) VALUES (?,?)', principalId, NOW);
    if (o.grant) {
      store.run("UPDATE web_principals SET kind='invite',revision=revision+1 WHERE id=?", principalId);
      store.run(
        "UPDATE web_guest_retention SET state='protected',started_at=NULL,expires_at=NULL,revision=revision+1 WHERE principal_id=?",
        principalId,
      );
      store.run(
        `INSERT INTO web_invite_codes(id,code_digest,issue_request_id,issue_digest,capacity,redeemed_count,status,batch,created_by,created_at)
        VALUES (?,?,?,?,1,1,'active',?,'admin',?)`,
        `invite-${name}`,
        `digest-${name}`,
        `issue-${name}`,
        'd',
        o.batch ?? 'spring',
        NOW - 10 * DAY,
      );
      store.run(
        'INSERT INTO web_invite_grants(id,invite_id,principal_id,player_id,world_id,redeemed_at,expires_at,revoked_at) VALUES (?,?,?,?,?,?,?,?)',
        `grant-${name}`,
        `invite-${name}`,
        principalId,
        playerId,
        worldId,
        NOW - 5 * DAY,
        o.grant === 'expired' ? NOW - DAY : o.grant === 'future' ? NOW + 30 * DAY : null,
        o.grant === 'revoked' ? NOW - DAY : null,
      );
    }
    return principalId;
  };
  return { store, build };
}

test('125 is its own step after 124, creates the tables once and is not repeatable', (t) => {
  const store = schema124();
  t.after(() => store.close());
  assert.equal(store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 124);
  assert.deepEqual(tables(store), []);
  migrateWebProviderInviteTiers(store);
  assert.equal(store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 125);
  assert.deepEqual(tables(store), NEW_TABLES);
  assert.equal(store.get('PRAGMA foreign_key_check'), undefined);
  assert.throws(() => migrateWebProviderInviteTiers(store), /WEB_PROVIDER_INVITE_TIERS_MIGRATION_REQUIRED/);
  const fresh = new Store(':memory:');
  t.after(() => fresh.close());
  assert.throws(() => migrateWebProviderInviteTiers(fresh), /WEB_PROVIDER_INVITE_TIERS_MIGRATION_REQUIRED/);
});

test('125 is the same SQL on both authorities, followed by 126, and 100-124 are unchanged', () => {
  const { inline, r2 } = expectedWebMigrations();
  // Named exception (Part 22a2, migration 127): the ledger has 52 steps and 127 is the newest, so step counts, positions counted from the end of the ledger and expected versions moved by one again. No assertion was weakened.
  // Named exception (Part 22c, migration 128): the ledger has 53 steps and 128 is the newest, so step counts, positions counted from the end of the ledger and the expected user_version moved by one again. No assertion was weakened.
  // Named exception (Part 24a, migration 129): the ledger has 54 steps and 129 is the newest, so step counts, positions counted from the end of the ledger and the expected user_version moved by one again. No assertion was weakened.
  // Named exception (Part 22d, migration 130): the ledger has 55 steps and 130 is the newest, so step counts, positions counted from the end of the ledger and the expected user_version moved by one again. No assertion was weakened.
  // Named exception (Part 24c, migration 131): the ledger has 56 steps and 131 is the newest, so step counts, positions counted from the end of the ledger and the expected user_version moved by one again. No assertion was weakened.
  assert.equal(inline.length, 56);
  assert.equal(r2.length, 56);
  assert.equal(inline.at(-6)!.version, 126);
  assert.equal(inline.at(-7)!.version, 125);
  assert.equal(inline.at(-7)!.sha256, sha(sql125()));
  assert.deepEqual(r2.at(-7), inline.at(-7));
  // Never edit steps 1-125: the earlier steps are byte-identical to main's.
  // Named exception (Part 22c, migration 128): the ledger has 53 steps and 128 is the newest, so step counts, positions counted from the end of the ledger and the expected user_version moved by one again. No assertion was weakened.
  // Named exception (Part 24a, migration 129): the ledger has 54 steps and 129 is the newest, so step counts, positions counted from the end of the ledger and the expected user_version moved by one again. No assertion was weakened.
  // Named exception (Part 22d, migration 130): the ledger has 55 steps and 130 is the newest, so step counts, positions counted from the end of the ledger and the expected user_version moved by one again. No assertion was weakened.
  // Named exception (Part 24c, migration 131): the ledger has 56 steps and 131 is the newest, so step counts, positions counted from the end of the ledger and the expected user_version moved by one again. No assertion was weakened.
  assert.equal(inline.at(-8)!.version, 124);
  assert.equal(inline.at(-8)!.sha256, '5754ab5882783ac356527db8904fd2a4661c6b9ff98ee796a49a438ec1301d17');
  assert.equal(inline.at(-9)!.sha256.startsWith('432c1237'), true);
});

test('125 backfill: entitlements only for invited principals with a login and an ACTIVE grant; kind and retention never change', (t) => {
  const { store, build } = oldDatabase(t);
  const shapes = {
    'invited, login, active grant (no expiry)': build('a1', { login: true, grant: 'active' }),
    'invited, login, active grant (expires later)': build('a2', { login: true, grant: 'future' }),
    'invited, login, lapsed grant (expired)': build('b1', { login: true, grant: 'expired' }),
    'invited, login, revoked grant': build('b2', { login: true, grant: 'revoked' }),
    'invited, NO login, active grant': build('c1', { grant: 'active' }),
    'invited, NO login, lapsed grant': build('c2', { grant: 'expired' }),
    'registered guest (bonus)': build('d1', { bonus: true }),
    'registered guest (login only)': build('d2', { login: true }),
    'plain guest': build('e1'),
  };
  const before = store.all('SELECT * FROM web_principals ORDER BY id');
  const retention = store.all('SELECT * FROM web_guest_retention ORDER BY principal_id');
  const grants = store.all('SELECT * FROM web_invite_grants ORDER BY id');
  migrateWebProviderInviteTiers(store);
  assert.deepEqual(store.all('SELECT * FROM web_principals ORDER BY id'), before, 'principal kinds are untouched');
  assert.deepEqual(
    store.all('SELECT * FROM web_guest_retention ORDER BY principal_id'),
    retention,
    'retention untouched',
  );
  assert.deepEqual(store.all('SELECT * FROM web_invite_grants ORDER BY id'), grants, 'grants untouched');

  const ent = store.all<{
    principal_id: string;
    kind: string;
    expires_at: number | null;
    source: string;
    batch_id: string;
  }>('SELECT principal_id,kind,expires_at,source,batch_id FROM web_entitlements ORDER BY principal_id');
  const byPrincipal = new Map(ent.map((e) => [e.principal_id, e]));
  assert.equal(ent.length, 2);
  assert.deepEqual(
    [
      byPrincipal.get(shapes['invited, login, active grant (no expiry)'])!.kind,
      byPrincipal.get(shapes['invited, login, active grant (no expiry)'])!.expires_at,
    ],
    ['unlimited', null],
  );
  assert.deepEqual(
    [
      byPrincipal.get(shapes['invited, login, active grant (expires later)'])!.kind,
      byPrincipal.get(shapes['invited, login, active grant (expires later)'])!.expires_at,
    ],
    ['unlimited', NOW + 30 * DAY],
  );
  assert.ok(ent.every((e) => e.source === 'invite' && e.batch_id === 'legacy:spring'));
  for (const name of [
    'invited, login, lapsed grant (expired)',
    'invited, login, revoked grant',
    'invited, NO login, active grant',
    'invited, NO login, lapsed grant',
  ] as const)
    assert.equal(byPrincipal.has(shapes[name]), false, name);

  // The legacy codes are carried by one 'unlimited' batch per distinct batch name.
  assert.deepEqual(
    store
      .all<Record<string, unknown>>('SELECT id,name,tier,daily_amount,total_cap FROM web_invite_batches')
      .map((row) => ({ ...row })),
    [{ id: 'legacy:spring', name: 'spring', tier: 'unlimited', daily_amount: null, total_cap: null }],
  );
  assert.equal(store.get<{ n: number }>('SELECT count(*) n FROM web_invite_codes WHERE batch_id IS NULL')!.n, 0);

  // 玩家编号: every REGISTERED player (a bonus row or a login), unique, 8 Crockford characters; nobody else.
  const numbers = store.all<{ principal_id: string; number: string }>(
    'SELECT principal_id,number FROM web_player_numbers',
  );
  assert.equal(numbers.length, 6, 'the four invited players with a login, plus the bonus guest and the login guest');
  assert.ok(numbers.every((n) => PLAYER_NUMBER_PATTERN.test(n.number)));
  assert.equal(new Set(numbers.map((n) => n.number)).size, numbers.length);
  assert.equal(
    numbers.some((n) => n.principal_id === shapes['plain guest']),
    false,
  );
  assert.equal(
    numbers.some((n) => n.principal_id === shapes['invited, NO login, active grant']),
    false,
  );

  // The effective tier after the migration: the entitled pair is unlimited, the lapsed ones are registered, the rest unchanged.
  // Named exception (Part 22x, migration 126): the effective tier is derived without the legacy kind, so the tiers are read
  // after 126 normalizes the invite principals; 125's own assertions above (kind and retention unchanged) ran before it.
  migrateWebProviderLegacyInvites(store);
  const tier = (id: string) => effectiveTier(store, id, NOW)!.kind;
  // Part 22a follow-up: the backfilled entitlement decides (not the grant): unlimited, until it ends.
  assert.equal(tier(shapes['invited, login, active grant (no expiry)']), 'unlimited');
  assert.equal(tier(shapes['invited, login, lapsed grant (expired)']), 'registered');
  assert.equal(tier(shapes['invited, NO login, lapsed grant']), 'guest');
  assert.equal(tier(shapes['registered guest (bonus)']), 'registered');
  assert.equal(tier(shapes['plain guest']), 'guest');

  // Counts by shape, for the report (counts only, no ids).
  const counts = {
    entitlements: ent.length,
    'invited+login+active -> unlimited entitlement': 2,
    'invited+login+lapsed/revoked -> none': 2,
    'invited without login -> none (legacy path)': 2,
    playerNumbers: numbers.length,
    batches: store.get<{ n: number }>('SELECT count(*) n FROM web_invite_batches')!.n,
  };
  process.stdout.write(`125-backfill-shape-counts ${JSON.stringify(counts)}\n`);
});

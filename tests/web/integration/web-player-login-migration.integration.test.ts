import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { localRuntime } from '../../cloudflare/runtime.ts';
import { auditWebLifecycleWorld } from '../../../apps/server/admission/web-lifecycle-audit.ts';
import { purgePlayerLogins } from '../../../apps/server/identity/web-player-purge.ts';
import { Store } from '../../../apps/server/platform/store.ts';
import {
  migrateWebProviderCocreation,
  migrateWebProviderEmbeddings,
  migrateWebProviderLogins,
  migrateWebProviderMemory,
  migrateWebProviderMetrics,
  migrateWebProviderOffline,
} from '../../../apps/server/generation/web-provider-migration.ts';
import { registerSqlTextLoader } from '../../../scripts/web-sql-text.ts';

registerSqlTextLoader();
const { expectedWebMigrations } = await import('../../../workers/web-cloudflare/migrations.ts');

function nodeAt117() {
  const store = new Store(':memory:');
  const folder = new URL('../../../apps/server/web-migrations/', import.meta.url);
  for (const file of readdirSync(folder).sort()) {
    if (Number(file.slice(0, 3)) > 112) break;
    store.db.exec(readFileSync(new URL(file, folder), 'utf8'));
  }
  store.db.exec('PRAGMA user_version=112');
  migrateWebProviderOffline(store);
  migrateWebProviderMetrics(store);
  migrateWebProviderMemory(store);
  migrateWebProviderEmbeddings(store);
  migrateWebProviderCocreation(store);
  return store;
}
const rows = (store: Store, table: string) =>
  store.all<Record<string, unknown>>(`SELECT * FROM ${table} ORDER BY rowid`);
const sha = (sql: string) => createHash('sha256').update(sql).digest('hex');
const sql118 = () =>
  readFileSync(new URL('../../../apps/server/web-migrations/118_player_logins.sql', import.meta.url), 'utf8');
const digest = 'c'.repeat(64);

function seed(store: Store, now: number) {
  store.db.exec('PRAGMA foreign_keys=ON');
  store.run('INSERT INTO web_instance(singleton,instance_id) VALUES (1,?)', 'fixture-instance');
  store.run('INSERT INTO api_players VALUES (?,?)', 'player', now);
  store.run('INSERT INTO worlds VALUES (?,?,?,?)', 'world', 'player', 'UTC', '{}');
  store.run("INSERT INTO web_principals(id,player_id,world_id,kind) VALUES ('principal','player','world','guest')");
  store.run('INSERT INTO api_players VALUES (?,?)', 'player2', now);
  store.run('INSERT INTO worlds VALUES (?,?,?,?)', 'world2', 'player2', 'UTC', '{}');
  store.run("INSERT INTO web_principals(id,player_id,world_id,kind) VALUES ('other','player2','world2','guest')");
}

test('local runner: 118 is its own step after 117, sets user_version=118 and is not repeatable', (t) => {
  const store = nodeAt117();
  t.after(() => store.close());
  assert.equal(store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 117);
  assert.equal(store.get('SELECT 1 FROM sqlite_master WHERE name=?', 'web_player_logins'), undefined);
  migrateWebProviderLogins(store);
  assert.equal(store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 118);
  for (const table of ['web_player_logins', 'web_email_challenges', 'web_player_email_daily', 'web_player_throttle'])
    assert.ok(store.get('SELECT 1 FROM sqlite_master WHERE type=? AND name=?', 'table', table), table);
  assert.throws(() => migrateWebProviderLogins(store), /WEB_PROVIDER_LOGIN_MIGRATION_REQUIRED/);
  const fresh = new Store(':memory:');
  t.after(() => fresh.close());
  assert.throws(() => migrateWebProviderLogins(fresh), /WEB_PROVIDER_LOGIN_MIGRATION_REQUIRED/);
});

test('a populated 117 database upgrades to 118 keeping every row; the new constraints hold', (t) => {
  const store = nodeAt117();
  t.after(() => store.close());
  const now = 1_700_000_000_000;
  seed(store, now);
  const before = Object.fromEntries(
    ['web_principals', 'worlds', 'api_players'].map((table) => [table, rows(store, table)]),
  );
  migrateWebProviderLogins(store);
  for (const table of Object.keys(before)) assert.deepEqual(rows(store, table), before[table], `${table} is unchanged`);
  assert.equal(store.get('PRAGMA foreign_key_check'), undefined);
  for (const table of ['web_player_logins', 'web_email_challenges', 'web_player_email_daily', 'web_player_throttle'])
    assert.equal(rows(store, table).length, 0, `the migration writes nothing to ${table}`);

  const login = (principal: string, email: string, extra: Record<string, unknown> = {}) => {
    const row = {
      principal_id: principal,
      email_norm: email,
      password_hash: 'scrypt-16384-8-5$x$y',
      created_at: now,
      password_changed_at: now,
      last_seen_at: now, // Fix-up 11f: schema 118 gained last_seen_at NOT NULL.
      ...extra,
    };
    store.run(
      `INSERT INTO web_player_logins(${Object.keys(row).join(',')}) VALUES (${Object.keys(row)
        .map(() => '?')
        .join(',')})`,
      ...(Object.values(row) as (string | number | null)[]),
    );
  };
  login('principal', 'a@example.com');
  assert.throws(() => login('principal', 'b@example.com'), /UNIQUE|PRIMARY/, 'one login per principal');
  assert.throws(() => login('other', 'a@example.com'), /UNIQUE/, 'one principal per email');
  assert.throws(() => login('nobody', 'c@example.com'), /FOREIGN KEY/, 'a login belongs to a principal');
  assert.throws(() => login('other', 'x'), /CHECK/, 'an address has a plausible length');
  assert.throws(() => login('other', 'd@example.com', { password_hash: '' }), /CHECK/);
  login('other', 'd@example.com');

  const challenge = (id: string, extra: Record<string, unknown> = {}) => {
    const row = {
      id,
      purpose: 'signup',
      email_norm: 'a@example.com',
      principal_id: 'principal',
      code_digest: digest,
      ip_hash: digest,
      created_at: now,
      expires_at: now + 600_000,
      ...extra,
    };
    store.run(
      `INSERT INTO web_email_challenges(${Object.keys(row).join(',')}) VALUES (${Object.keys(row)
        .map(() => '?')
        .join(',')})`,
      ...(Object.values(row) as (string | number | null)[]),
    );
  };
  challenge('c1');
  assert.deepEqual(
    { ...store.get<object>('SELECT attempts,verified_at,consumed_at,delivery FROM web_email_challenges') },
    { attempts: 0, verified_at: null, consumed_at: null, delivery: 'pending' },
  );
  assert.throws(() => challenge('c2', { purpose: 'login' }), /CHECK/, 'only signup, reset and bind');
  assert.throws(() => challenge('c3', { code_digest: 'short' }), /CHECK/, 'a digest, never a code');
  assert.throws(() => challenge('c4', { ip_hash: 'short' }), /CHECK/);
  assert.throws(() => challenge('c5', { expires_at: now }), /CHECK/, 'a challenge expires after it is created');
  assert.throws(() => challenge('c6', { delivery: 'sent' }), /CHECK/);
  assert.throws(() => challenge('c7', { attempts: -1 }), /CHECK/);
  assert.throws(() => challenge('c8', { principal_id: null }), /CHECK/, 'signup / bind belong to a session principal');
  assert.throws(() => challenge('c9', { purpose: 'reset' }), /CHECK/, 'a reset has no session principal');
  assert.throws(() => challenge('c10', { principal_id: 'nobody' }), /FOREIGN KEY/);
  assert.throws(() => challenge('c1'), /UNIQUE|PRIMARY/);
  challenge('c11', { purpose: 'reset', principal_id: null, delivery: 'none' });

  store.run("INSERT INTO web_player_email_daily VALUES ('2026-10-10',3)");
  assert.throws(() => store.run("INSERT INTO web_player_email_daily VALUES ('short',3)"), /CHECK/);
  assert.throws(() => store.run("INSERT INTO web_player_email_daily VALUES ('2026-10-11',-1)"), /CHECK/);
  store.run("INSERT INTO web_player_throttle VALUES ('login-email',?,?,1)", digest, now);
  assert.throws(
    () => store.run("INSERT INTO web_player_throttle VALUES ('login-email',?,?,1)", digest, now),
    /UNIQUE|PRIMARY/,
  );
  assert.throws(() => store.run("INSERT INTO web_player_throttle VALUES ('nonsense',?,?,1)", digest, now), /CHECK/);
  assert.throws(() => store.run("INSERT INTO web_player_throttle VALUES ('login-ip','short',?,1)", now), /CHECK/);
  assert.equal(store.get('PRAGMA foreign_key_check'), undefined);
});

test('the lifecycle audit knows the new tables, and the purge removes login, challenges and 名片 only for that player', (t) => {
  const store = nodeAt117();
  t.after(() => store.close());
  migrateWebProviderLogins(store);
  const now = 1_700_000_000_000;
  seed(store, now);
  store.run(
    // Fix-up 11f: positional insert gained the new last_seen_at column (schema 118).
    "INSERT INTO web_player_logins VALUES ('principal','gone@example.com','scrypt-16384-8-5$x$y',?,?,?)",
    now,
    now,
    now,
  );
  store.run(
    `INSERT INTO web_email_challenges(id,purpose,email_norm,principal_id,code_digest,ip_hash,created_at,expires_at)
    VALUES ('s','signup','gone@example.com','principal',?,?,?,?)`,
    digest,
    digest,
    now,
    now + 1,
  );
  store.run(
    `INSERT INTO web_email_challenges(id,purpose,email_norm,principal_id,code_digest,ip_hash,created_at,expires_at)
    VALUES ('r','reset','gone@example.com',NULL,?,?,?,?)`,
    digest,
    digest,
    now,
    now + 1,
  );
  store.run(
    `INSERT INTO web_email_challenges(id,purpose,email_norm,principal_id,code_digest,ip_hash,created_at,expires_at)
    VALUES ('k','reset','keep@example.com',NULL,?,?,?,?)`,
    digest,
    digest,
    now,
    now + 1,
  );
  store.run("INSERT INTO player_profile_versions VALUES ('world',1,'{}',?)", now);
  // The source world passes (a nickname 名片 is the player's own data, deleted by the cleaners); a cleared world must
  // hold neither the 名片 nor the login.
  auditWebLifecycleWorld(store as never, 'world', 'source');
  assert.throws(
    () => auditWebLifecycleWorld(store as never, 'world', 'cleared'),
    /WEB_RETENTION_UNEXPECTED_WORLD_DATA/,
  );
  purgePlayerLogins(store, { principalId: 'principal', worldId: 'world' });
  assert.equal(rows(store, 'web_player_logins').length, 0);
  assert.deepEqual(
    rows(store, 'web_email_challenges').map((r) => r.id),
    ['k'],
    "another address's challenge stays",
  );
  assert.equal(rows(store, 'player_profile_versions').length, 0);
  auditWebLifecycleWorld(store as never, 'world', 'cleared');
  // A login that survives a cleared world fails the audit on its own, without any 名片.
  store.run(
    // Fix-up 11f: positional insert gained the new last_seen_at column (schema 118).
    "INSERT INTO web_player_logins VALUES ('principal','again@example.com','scrypt-16384-8-5$x$y',?,?,?)",
    now,
    now,
    now,
  );
  assert.throws(
    () => auditWebLifecycleWorld(store as never, 'world', 'cleared'),
    /WEB_RETENTION_UNEXPECTED_WORLD_DATA/,
  );
});

test('Cloudflare runner: 118 is the same SQL on both authorities and its ledger hash is stable', () => {
  const { inline, r2 } = expectedWebMigrations();
  const last = (list: { version: number; sha256: string }[]) => list.at(-1)!;
  assert.equal(inline.length, 43);
  assert.equal(r2.length, 43);
  assert.equal(last(inline).version, 118);
  assert.equal(last(r2).version, 118);
  assert.equal(last(inline).sha256, sha(sql118()), 'the ledger hash is the sha256 of the SQL file as written');
  assert.equal(last(inline).sha256, last(r2).sha256, 'only the R2 schema-113 step differs between the lists');
  assert.deepEqual(
    inline.map((m) => m.version),
    [...Array.from({ length: 24 }, (_, i) => i + 1), ...Array.from({ length: 19 }, (_, i) => 100 + i)],
  );
});

test('Cloudflare runner: an existing authority at 117 upgrades to 118 through the normal path (inline and R2)', async (t) => {
  const f = localRuntime(t, 'tests/web/fixtures/cloudflare-metrics-worker.ts', { STATE: 'WebMetricsFixture' });
  for (const mode of ['inline', 'r2']) {
    const result = await f.call<{
      before: string[];
      after: string[];
      version: unknown;
      logins: { logins: boolean; challenges: boolean; daily: boolean; throttle: boolean };
    }>(`/upgrade?mode=${mode}&through=117&object=logins-${mode}`);
    assert.equal(result.before.length, 42, mode);
    assert.equal(result.before.at(-1)?.startsWith('117:'), true, mode);
    assert.deepEqual(result.after.slice(0, 42), result.before, `${mode}: applied steps are untouched`);
    assert.equal(result.after.length, 43, mode);
    assert.equal(result.after.at(-1), `118:${sha(sql118())}`, mode);
    assert.deepEqual(result.version, { user_version: 118 }, mode);
    assert.deepEqual(result.logins, { logins: true, challenges: true, daily: true, throttle: true }, mode);
  }
});

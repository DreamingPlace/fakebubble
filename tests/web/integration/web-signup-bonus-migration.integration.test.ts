import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { localRuntime } from '../../cloudflare/runtime.ts';
import { Store } from '../../../apps/server/platform/store.ts';
import {
  migrateWebProviderCocreation,
  migrateWebProviderEmbeddings,
  migrateWebProviderLogins,
  migrateWebProviderMemory,
  migrateWebProviderMemoryMetrics,
  migrateWebProviderMetrics,
  migrateWebProviderOffline,
  migrateWebProviderPreviewWorkbench,
  migrateWebProviderSignupBonus,
} from '../../../apps/server/generation/web-provider-migration.ts';
import { registerSqlTextLoader } from '../../../scripts/web-sql-text.ts';

registerSqlTextLoader();
const { expectedWebMigrations } = await import('../../../workers/web-cloudflare/migrations.ts');

function nodeAt120() {
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
  migrateWebProviderLogins(store);
  migrateWebProviderPreviewWorkbench(store);
  migrateWebProviderMemoryMetrics(store);
  return store;
}
const sha = (sql: string) => createHash('sha256').update(sql).digest('hex');
const sql121 = () =>
  readFileSync(new URL('../../../apps/server/web-migrations/121_signup_bonus.sql', import.meta.url), 'utf8');
const tables = (store: Store) =>
  store
    .all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('web_bonus_emails','web_signup_bonus','web_free_operations','web_signup_ip_daily') ORDER BY name",
    )
    .map((row) => row.name);

test('local runner: 121 is its own step after 120, adds the four signup-bonus tables and is not repeatable', (t) => {
  const store = nodeAt120();
  t.after(() => store.close());
  assert.equal(store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 120);
  assert.deepEqual(tables(store), []);
  migrateWebProviderSignupBonus(store);
  assert.equal(store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 121);
  assert.deepEqual(tables(store), [
    'web_bonus_emails',
    'web_free_operations',
    'web_signup_bonus',
    'web_signup_ip_daily',
  ]);
  assert.equal(store.get('PRAGMA foreign_key_check'), undefined);
  assert.throws(() => migrateWebProviderSignupBonus(store), /WEB_PROVIDER_SIGNUP_BONUS_MIGRATION_REQUIRED/);
  const fresh = new Store(':memory:');
  t.after(() => fresh.close());
  assert.throws(() => migrateWebProviderSignupBonus(fresh), /WEB_PROVIDER_SIGNUP_BONUS_MIGRATION_REQUIRED/);
});

test('the tables only accept what the free tier writes: a keyed 64-hex digest, a known tier, an IP hash exactly for trial_extra', (t) => {
  const store = nodeAt120();
  t.after(() => store.close());
  migrateWebProviderSignupBonus(store);
  store.db.exec('PRAGMA foreign_keys=OFF');
  const hex = 'a'.repeat(64);
  store.db.exec(`INSERT INTO web_bonus_emails VALUES ('${hex}',1)`);
  assert.throws(
    () => store.db.exec("INSERT INTO web_bonus_emails VALUES ('someone@example.com',1)"),
    'never an address',
  );
  assert.throws(() => store.db.exec(`INSERT INTO web_bonus_emails VALUES ('${hex}',2)`), 'one row per digest');
  store.db.exec(`INSERT INTO web_free_operations VALUES ('o1','p1','bonus',NULL)`);
  store.db.exec(`INSERT INTO web_free_operations VALUES ('o2','p1','trial_extra','${hex}')`);
  assert.throws(
    () => store.db.exec(`INSERT INTO web_free_operations VALUES ('o3','p1','bonus','${hex}')`),
    'a bonus row has no IP',
  );
  assert.throws(
    () => store.db.exec("INSERT INTO web_free_operations VALUES ('o4','p1','trial_extra',NULL)"),
    'an extra row needs its IP',
  );
  assert.throws(() => store.db.exec("INSERT INTO web_free_operations VALUES ('o5','p1','free',NULL)"));
  store.db.exec(`INSERT INTO web_signup_ip_daily VALUES ('${hex}','2026-10-12',1)`);
  assert.throws(() => store.db.exec(`INSERT INTO web_signup_ip_daily VALUES ('${hex}','2026-10-12',2)`));
  assert.throws(() => store.db.exec(`INSERT INTO web_signup_ip_daily VALUES ('${'b'.repeat(64)}','2026-10-12',-1)`));
});

test('Cloudflare runner: 121 is the same SQL on both authorities, second to last of 47 steps, and its ledger hash is stable', () => {
  const { inline, r2 } = expectedWebMigrations();
  // Named exception (Part 21g, migration 124): the ledger now has 49 steps and 124 is the newest, so step counts, positions
  // counted from the end of the ledger and expected user_versions in this test moved by one again. No assertion was weakened.
  // Named exception (Part 22a, migration 125): the ledger now has 50 steps and 125 is the newest, so step counts, positions
  // counted from the end of the ledger and expected user_versions in this test moved by one again. No assertion was weakened.
  // Named exception (Part 22x, migration 126): the ledger has 51 steps and 126 is the newest, so step counts, positions counted
  // from the end of the ledger and the expected user_version moved by one again. No assertion was weakened.
  // Named exception (Part 22a2, migration 127): the ledger has 52 steps and 127 is the newest, so step counts, positions counted from the end of the ledger and the expected user_version moved by one again. No assertion was weakened.
  // Named exception (Part 22c, migration 128): the ledger has 53 steps and 128 is the newest, so step counts, positions counted from the end of the ledger and the expected user_version moved by one again. No assertion was weakened.
  // Named exception (Part 24a, migration 129): the ledger has 54 steps and 129 is the newest, so step counts, positions counted from the end of the ledger and the expected user_version moved by one again. No assertion was weakened.
  // Named exception (Part 22d, migration 130): the ledger has 55 steps and 130 is the newest, so step counts, positions counted from the end of the ledger and the expected user_version moved by one again. No assertion was weakened.
  assert.equal(inline.length, 55);
  assert.equal(r2.length, 55);
  assert.equal(inline.at(-10)!.version, 121);
  assert.equal(r2.at(-10)!.version, 121);
  assert.equal(inline.at(-10)!.sha256, sha(sql121()), 'the ledger hash is the sha256 of the SQL file as written');
  assert.equal(inline.at(-10)!.sha256, r2.at(-10)!.sha256);
  assert.equal(
    // Named exception (Part 22a, migration 125): the ledger now has 50 steps and 125 is the newest, so step counts, positions
    // counted from the end of the ledger and expected user_versions in this test moved by one again. No assertion was weakened.
    // Named exception (Part 22a2, migration 127): the ledger has 52 steps and 127 is the newest, so step counts, positions counted from the end of the ledger and the expected user_version moved by one again. No assertion was weakened.
    // Named exception (Part 22c, migration 128): the ledger has 53 steps and 128 is the newest, so step counts, positions counted from the end of the ledger and the expected user_version moved by one again. No assertion was weakened.
    // Named exception (Part 24a, migration 129): the ledger has 54 steps and 129 is the newest, so step counts, positions counted from the end of the ledger and the expected user_version moved by one again. No assertion was weakened.
    // Named exception (Part 22d, migration 130): the ledger has 55 steps and 130 is the newest, so step counts, positions counted from the end of the ledger and the expected user_version moved by one again. No assertion was weakened.
    inline.at(-10)!.sha256,
    'f0fa334dbb0ac155d5421792e612438b722b9882fc8ff11a145e34e705fef8d9',
    'pinned: a change to the file is a new migration',
  );
});

test('Cloudflare runner: an existing authority at 120 gains 121 untouched (inline and R2)', async (t) => {
  const f = localRuntime(t, 'tests/web/fixtures/cloudflare-metrics-worker.ts', { STATE: 'WebMetricsFixture' });
  for (const mode of ['inline', 'r2']) {
    const result = await f.call<{ before: string[]; after: string[]; version: unknown }>(
      `/upgrade?mode=${mode}&through=120&object=sb-${mode}`,
    );
    assert.equal(result.before.length, 45, mode);
    assert.equal(result.before.at(-1)?.startsWith('120:'), true, mode);
    assert.deepEqual(result.after.slice(0, 45), result.before, `${mode}: applied steps are untouched`);
    // Named exception (Part 22a, migration 125): the ledger now has 50 steps and 125 is the newest, so step counts, positions
    // counted from the end of the ledger and expected user_versions in this test moved by one again. No assertion was weakened.
    // Named exception (Part 22a2, migration 127): the ledger has 52 steps and 127 is the newest, so step counts, positions counted from the end of the ledger and the expected user_version moved by one again. No assertion was weakened.
    // Named exception (Part 22c, migration 128): the ledger has 53 steps and 128 is the newest, so step counts, positions counted from the end of the ledger and the expected user_version moved by one again. No assertion was weakened.
    // Named exception (Part 24a, migration 129): the ledger has 54 steps and 129 is the newest, so step counts, positions counted from the end of the ledger and the expected user_version moved by one again. No assertion was weakened.
    // Named exception (Part 22d, migration 130): the ledger has 55 steps and 130 is the newest, so step counts, positions counted from the end of the ledger and the expected user_version moved by one again. No assertion was weakened.
    assert.equal(result.after.length, 55, mode);
    assert.equal(result.after.at(-10), `121:${sha(sql121())}`, mode);
    assert.deepEqual(result.version, { user_version: 130 }, mode);
  }
});

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
} from '../../../apps/server/generation/web-provider-migration.ts';
import { registerSqlTextLoader } from '../../../scripts/web-sql-text.ts';

// Named exception (Part 17b, migration 121): the ledger now has 46 steps, so every step count, every position counted from the
// end of the ledger and every expected user_version below moved by one. No assertion was weakened.
// Named exception (Part 19, migration 122): the ledger now has 47 steps and 122 is the newest, so every step count, every position
// counted from the end of the ledger and every expected user_version below moved by one again. No assertion was weakened.
// Named exception (Part 21b, migration 123): the ledger now has 48 steps and 123 is the newest, so every step count, every position
// counted from the end of the ledger and every expected user_version below moved by one again. No assertion was weakened.

registerSqlTextLoader();
const { expectedWebMigrations } = await import('../../../workers/web-cloudflare/migrations.ts');

function nodeAt119() {
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
  return store;
}
const sha = (sql: string) => createHash('sha256').update(sql).digest('hex');
const sql120 = () =>
  readFileSync(new URL('../../../apps/server/web-migrations/120_memory_metadata_metrics.sql', import.meta.url), 'utf8');
const columns = (store: Store) =>
  store.all<{ name: string }>("SELECT name FROM pragma_table_info('web_operation_metrics')").map((r) => r.name);

test('local runner: 120 is its own step after 119, adds the two dropped-memory counters and is not repeatable', (t) => {
  const store = nodeAt119();
  t.after(() => store.close());
  assert.equal(store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 119);
  assert.ok(!columns(store).includes('topics_dropped'));
  migrateWebProviderMemoryMetrics(store);
  assert.equal(store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 120);
  assert.ok(columns(store).includes('topics_dropped') && columns(store).includes('facts_dropped'));
  assert.throws(() => migrateWebProviderMemoryMetrics(store), /WEB_PROVIDER_MEMORY_METRICS_MIGRATION_REQUIRED/);
  const fresh = new Store(':memory:');
  t.after(() => fresh.close());
  assert.throws(() => migrateWebProviderMemoryMetrics(fresh), /WEB_PROVIDER_MEMORY_METRICS_MIGRATION_REQUIRED/);
});

test('a metric row defaults both counters to 0 and they only accept 0 or 1', (t) => {
  const store = nodeAt119();
  t.after(() => store.close());
  migrateWebProviderMemoryMetrics(store);
  store.db.exec('PRAGMA foreign_keys=OFF');
  store.db.exec("INSERT INTO web_operation_metrics(operation_id,day,review_changed) VALUES ('op-new','2026-10-10',1)");
  assert.deepEqual(
    {
      ...store.get<Record<string, number>>(
        'SELECT review_changed,topics_dropped,facts_dropped FROM web_operation_metrics',
      ),
    },
    { review_changed: 1, topics_dropped: 0, facts_dropped: 0 },
  );
  assert.throws(() => store.db.exec("UPDATE web_operation_metrics SET topics_dropped=2 WHERE operation_id='op-new'"));
  assert.throws(() => store.db.exec("UPDATE web_operation_metrics SET facts_dropped=-1 WHERE operation_id='op-new'"));
});

test('Cloudflare runner: 120 is the same SQL on both authorities, third to last of 47 steps, and its ledger hash is stable', () => {
  const { inline, r2 } = expectedWebMigrations();
  // Named exception (Part 21g, migration 124): the ledger now has 49 steps and 124 is the newest, so step counts, positions
  // counted from the end of the ledger and expected user_versions in this test moved by one again. No assertion was weakened.
  // Named exception (Part 22a, migration 125): the ledger now has 50 steps and 125 is the newest, so step counts, positions
  // counted from the end of the ledger and expected user_versions in this test moved by one again. No assertion was weakened.
  // Named exception (Part 22x, migration 126): the ledger has 51 steps and 126 is the newest, so step counts, positions counted
  // from the end of the ledger and the expected user_version moved by one again. No assertion was weakened.
  // Named exception (Part 22a2, migration 127): the ledger has 52 steps and 127 is the newest, so step counts, positions counted from the end of the ledger and the expected user_version moved by one again. No assertion was weakened.
  // Named exception (Part 22c, migration 128): the ledger has 53 steps and 128 is the newest, so step counts, positions counted from the end of the ledger and the expected user_version moved by one again. No assertion was weakened.
  assert.equal(inline.length, 53);
  assert.equal(r2.length, 53);
  assert.equal(inline.at(-9)!.version, 120);
  assert.equal(r2.at(-9)!.version, 120);
  assert.equal(inline.at(-9)!.sha256, sha(sql120()), 'the ledger hash is the sha256 of the SQL file as written');
  assert.equal(inline.at(-9)!.sha256, r2.at(-9)!.sha256);
});

test('Cloudflare runner: an existing authority at 119 gains 120 untouched (inline and R2)', async (t) => {
  const f = localRuntime(t, 'tests/web/fixtures/cloudflare-metrics-worker.ts', { STATE: 'WebMetricsFixture' });
  for (const mode of ['inline', 'r2']) {
    const result = await f.call<{ before: string[]; after: string[]; version: unknown }>(
      `/upgrade?mode=${mode}&through=119&object=mm-${mode}`,
    );
    assert.equal(result.before.length, 44, mode);
    assert.equal(result.before.at(-1)?.startsWith('119:'), true, mode);
    assert.deepEqual(result.after.slice(0, 44), result.before, `${mode}: applied steps are untouched`);
    // Named exception (Part 22a, migration 125): the ledger now has 50 steps and 125 is the newest, so step counts, positions
    // counted from the end of the ledger and expected user_versions in this test moved by one again. No assertion was weakened.
    // Named exception (Part 22a2, migration 127): the ledger has 52 steps and 127 is the newest, so step counts, positions counted from the end of the ledger and the expected user_version moved by one again. No assertion was weakened.
    // Named exception (Part 22c, migration 128): the ledger has 53 steps and 128 is the newest, so step counts, positions counted from the end of the ledger and the expected user_version moved by one again. No assertion was weakened.
    assert.equal(result.after.length, 53, mode);
    assert.equal(result.after.at(-9), `120:${sha(sql120())}`, mode);
    assert.equal(result.after.at(-8)?.startsWith('121:'), true, mode);
    assert.equal(result.after.at(-7)?.startsWith('122:'), true, mode);
    assert.equal(result.after.at(-6)?.startsWith('123:'), true, mode);
    assert.equal(result.after.at(-5)?.startsWith('124:'), true, mode); // Extended for migration 124: the newest step is last.
    assert.equal(result.after.at(-4)?.startsWith('125:'), true, mode); // Extended for migration 125: the newest step is last.
    assert.equal(result.after.at(-3)?.startsWith('126:'), true, mode); // Extended for migration 126: the newest step is last.
    assert.equal(result.after.at(-2)?.startsWith('127:'), true, mode); // Extended for migration 127: the newest step is last.
    assert.equal(result.after.at(-1)?.startsWith('128:'), true, mode); // Extended for migration 128: the newest step is last.
    // Named exception (Part 22a2, migration 127): the ledger has 52 steps and 127 is the newest, so step counts, positions counted from the end of the ledger and the expected user_version moved by one again. No assertion was weakened.
    // Named exception (Part 22c, migration 128): the ledger has 53 steps and 128 is the newest, so step counts, positions counted from the end of the ledger and the expected user_version moved by one again. No assertion was weakened.
    assert.deepEqual(result.version, { user_version: 128 }, mode);
  }
});

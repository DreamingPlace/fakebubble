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

test('Cloudflare runner: 120 is the same SQL on both authorities, last of 45 steps, and its ledger hash is stable', () => {
  const { inline, r2 } = expectedWebMigrations();
  assert.equal(inline.length, 45);
  assert.equal(r2.length, 45);
  assert.equal(inline.at(-1)!.version, 120);
  assert.equal(r2.at(-1)!.version, 120);
  assert.equal(inline.at(-1)!.sha256, sha(sql120()), 'the ledger hash is the sha256 of the SQL file as written');
  assert.equal(inline.at(-1)!.sha256, r2.at(-1)!.sha256);
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
    assert.equal(result.after.length, 45, mode);
    assert.equal(result.after.at(-1), `120:${sha(sql120())}`, mode);
    assert.deepEqual(result.version, { user_version: 120 }, mode);
  }
});

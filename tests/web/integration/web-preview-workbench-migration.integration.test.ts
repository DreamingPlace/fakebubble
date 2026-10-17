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

const TABLES = [
  'web_eval_set_versions',
  'web_eval_sets',
  'web_preview_marks',
  'web_preview_rejected',
  'web_preview_run_items',
  'web_preview_runs',
];
function nodeAt118() {
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
  return store;
}
const sha = (sql: string) => createHash('sha256').update(sql).digest('hex');
const sql119 = () =>
  readFileSync(new URL('../../../apps/server/web-migrations/119_preview_workbench.sql', import.meta.url), 'utf8');
const hex = 'd'.repeat(64);
const tables = (store: Store) =>
  store
    .all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name",
    )
    .map((r) => r.name);

test('local runner: 119 is its own step after 118, sets user_version=119 and is not repeatable', (t) => {
  const store = nodeAt118();
  t.after(() => store.close());
  assert.equal(store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 118);
  for (const table of TABLES) assert.equal(store.get('SELECT 1 FROM sqlite_master WHERE name=?', table), undefined);
  migrateWebProviderPreviewWorkbench(store);
  assert.equal(store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 119);
  for (const table of TABLES)
    assert.ok(store.get('SELECT 1 FROM sqlite_master WHERE type=? AND name=?', 'table', table), table);
  assert.throws(() => migrateWebProviderPreviewWorkbench(store), /WEB_PROVIDER_PREVIEW_WORKBENCH_MIGRATION_REQUIRED/);
  const fresh = new Store(':memory:');
  t.after(() => fresh.close());
  assert.throws(() => migrateWebProviderPreviewWorkbench(fresh), /WEB_PROVIDER_PREVIEW_WORKBENCH_MIGRATION_REQUIRED/);
});

test('a populated 118 database upgrades to 119 keeping every existing row; the new constraints hold', (t) => {
  const store = nodeAt118();
  t.after(() => store.close());
  store.db.exec('PRAGMA foreign_keys=ON');
  store.run("INSERT INTO web_instance(singleton,instance_id) VALUES (1,'fixture-instance')");
  store.run('INSERT INTO api_players VALUES (?,?)', 'player', 1);
  store.run('INSERT INTO worlds VALUES (?,?,?,?)', 'world', 'player', 'UTC', '{}');
  store.run("INSERT INTO web_principals(id,player_id,world_id,kind) VALUES ('principal','player','world','guest')");
  const before = Object.fromEntries(
    tables(store).map((name) => [name, store.all<Record<string, unknown>>(`SELECT * FROM ${name} ORDER BY rowid`)]),
  );
  migrateWebProviderPreviewWorkbench(store);
  for (const [name, rows] of Object.entries(before))
    assert.deepEqual(store.all(`SELECT * FROM ${name} ORDER BY rowid`), rows, `${name} is untouched`);
  assert.deepEqual(
    tables(store).filter((name) => !(name in before)),
    TABLES,
  );
  assert.equal(store.get('PRAGMA foreign_key_check'), undefined);
  // Constraints. A preview row to hang them on.
  // The admin tables are created by installers that this chain does not run: the prerequisites are inserted bare.
  store.db.exec('PRAGMA foreign_keys=OFF');
  store.run(`INSERT INTO character_draft_revisions VALUES ('c',1,NULL,'{}',?,1,'s')`, hex);
  store.run(
    `INSERT INTO admin_previews(id,character_id,draft_revision,content_hash,prompt_hash,request_id,request_hash,status,evidence_kind,request_json,created_at)
    VALUES ('p1','c',1,?,?,'r1',?,'queued','deepseek','{}',1)`,
    hex,
    hex,
    hex,
  );
  store.db.exec('PRAGMA foreign_keys=ON');
  const run = (id: string, over: Record<string, unknown> = {}) => {
    const v = { label: null, min: null, count: 1, ...over };
    store.run(
      `INSERT INTO web_preview_runs VALUES (?,?,?,'c',?,1,?,'friend',?,'Asia/Singapore',NULL,NULL,?,'m',1)`,
      id,
      'req-' + id,
      hex,
      v.label,
      hex,
      v.min,
      v.count,
    );
  };
  run('ok', { label: 'x'.repeat(60), min: 1439 });
  assert.throws(() => run('long', { label: 'x'.repeat(61) }));
  assert.throws(() => run('minute', { min: 1440 }));
  assert.throws(() => run('many', { count: 51 }));
  assert.throws(() => run('none', { count: 0 }));
  store.run("INSERT INTO web_preview_run_items VALUES ('ok',1,'p1',?)", 'n'.repeat(300));
  assert.throws(
    () => store.run("INSERT INTO web_preview_run_items VALUES ('ok',2,'p1',NULL)"),
    /UNIQUE/,
    'one run per preview',
  );
  assert.throws(() => store.run("INSERT INTO web_preview_run_items VALUES ('ok',3,'p1',NULL)"));
  store.run(
    `INSERT INTO admin_previews(id,character_id,draft_revision,content_hash,prompt_hash,request_id,request_hash,status,evidence_kind,request_json,created_at)
    VALUES ('p2','c',1,?,?,'r2',?,'queued','deepseek','{}',1)`,
    hex,
    hex,
    hex,
  );
  assert.throws(() => store.run("INSERT INTO web_preview_run_items VALUES ('missing',2,'p2',NULL)"), /FOREIGN KEY/);
  assert.throws(() => store.run("UPDATE web_preview_run_items SET note='y'"), /WEB_PREVIEW_RUN_IMMUTABLE/);
  assert.throws(() => store.run("INSERT INTO web_preview_marks VALUES ('p1',1440,'Asia/Singapore')"));
  store.run("INSERT INTO web_preview_marks VALUES ('p1',350,'Asia/Singapore')");
  assert.throws(() => store.run('UPDATE web_preview_marks SET simulated_minute=1'), /WEB_PREVIEW_RUN_IMMUTABLE/);
  store.run("INSERT INTO web_preview_rejected VALUES ('p1','draft','INVALID_TOPICS',?,40000,1,1)", 'a'.repeat(32832));
  assert.throws(() =>
    store.run("INSERT INTO web_preview_rejected VALUES ('p1','review','X',?,1,0,1)", 'a'.repeat(32833)),
  );
  assert.throws(() => store.run("INSERT INTO web_preview_rejected VALUES ('p1','other','X','a',1,0,1)"));
  const items = (n: number) => JSON.stringify(Array.from({ length: n }, () => ({ text: 'a' })));
  const set = (id: string, name: string, json: string) =>
    store.run('INSERT INTO web_eval_sets VALUES (?,?,1,?,?,1,?,1)', id, name, json, 'm', 'm');
  set('e1', 'fifty', items(50));
  assert.throws(() => set('e2', 'fifty-one', items(51)));
  assert.throws(() => set('e3', 'empty', '[]'));
  assert.throws(() => set('e4', 'fifty', items(1)), /UNIQUE/);
  assert.throws(() => set('e5', 'bad', '{'));
  // The only dangling reference is the bare prerequisite row inserted above (its admin session is not installed here).
  assert.deepEqual(
    store.all<{ table: string }>('PRAGMA foreign_key_check').map((r) => r.table),
    ['character_draft_revisions'],
  );
});

test('Cloudflare runner: 119 is the same SQL on both authorities, 47 steps, and its ledger hash is stable', () => {
  const { inline, r2 } = expectedWebMigrations();
  // Extended for migration 120: 119 is now second from last and the ledger has 47 steps.
  // Named exception (Part 21g, migration 124): the ledger now has 49 steps and 124 is the newest, so step counts, positions
  // counted from the end of the ledger and expected user_versions in this test moved by one again. No assertion was weakened.
  const last = (list: { version: number; sha256: string }[]) => list.at(-6)!;
  assert.equal(inline.length, 49);
  assert.equal(r2.length, 49);
  assert.equal(last(inline).version, 119);
  assert.equal(last(r2).version, 119);
  assert.equal(last(inline).sha256, sha(sql119()), 'the ledger hash is the sha256 of the SQL file as written');
  assert.equal(last(inline).sha256, last(r2).sha256, 'only the R2 schema-113 step differs between the lists');
  assert.deepEqual(
    inline.map((m) => m.version),
    [...Array.from({ length: 24 }, (_, i) => i + 1), ...Array.from({ length: 25 }, (_, i) => 100 + i)],
  );
  assert.deepEqual(
    inline.slice(0, 43).map((m) => m.version),
    r2.slice(0, 43).map((m) => m.version),
  );
});

test('Cloudflare runner: a fresh install and an existing authority at 118 both reach 119 (inline and R2)', async (t) => {
  const f = localRuntime(t, 'tests/web/fixtures/cloudflare-metrics-worker.ts', { STATE: 'WebMetricsFixture' });
  const fresh = await f.call<{ version: unknown; hashes: string[]; workbench: string[] }>(
    '/inline?object=wb-fresh-inline',
  );
  // Extended for migration 120: 119 is second from last.
  assert.deepEqual(fresh.version, { user_version: 124 });
  assert.equal(fresh.hashes.at(-6), `119:${sha(sql119())}`);
  assert.deepEqual(fresh.workbench, TABLES);
  const freshR2 = await f.call<{ version: unknown; hashes: string[]; workbench: string[] }>('/r2?object=wb-fresh-r2');
  assert.deepEqual(freshR2.version, { user_version: 124 });
  assert.equal(freshR2.hashes.at(-6), `119:${sha(sql119())}`);
  assert.deepEqual(freshR2.workbench, TABLES);
  for (const mode of ['inline', 'r2']) {
    const result = await f.call<{
      before: string[];
      after: string[];
      version: unknown;
      workbench: string[];
    }>(`/upgrade?mode=${mode}&through=118&object=wb-${mode}`);
    assert.equal(result.before.length, 43, mode);
    assert.equal(result.before.at(-1)?.startsWith('118:'), true, mode);
    assert.deepEqual(result.after.slice(0, 43), result.before, `${mode}: applied steps are untouched`);
    assert.equal(result.after.length, 49, mode);
    assert.equal(result.after.at(-6), `119:${sha(sql119())}`, mode);
    assert.equal(result.after.at(-5)?.startsWith('120:'), true, mode);
    assert.equal(result.after.at(-4)?.startsWith('121:'), true, mode);
    assert.equal(result.after.at(-3)?.startsWith('122:'), true, mode);
    assert.equal(result.after.at(-2)?.startsWith('123:'), true, mode);
    assert.equal(result.after.at(-1)?.startsWith('124:'), true, mode); // Extended for migration 124: the newest step is last.
    assert.deepEqual(result.version, { user_version: 124 }, mode);
    assert.deepEqual(result.workbench, TABLES, mode);
  }
});

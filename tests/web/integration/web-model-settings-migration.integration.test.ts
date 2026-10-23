import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { localRuntime } from '../../cloudflare/runtime.ts';
import { Store } from '../../../apps/server/platform/store.ts';
import { migrateWebProviderModelSettings } from '../../../apps/server/generation/web-provider-migration.ts';
import { DEFAULT_MODEL_SETTINGS } from '../../../packages/contracts/model-settings.ts';
import { registerSqlTextLoader } from '../../../scripts/web-sql-text.ts';
import { schema123 } from '../fixtures/model-choice.ts';

registerSqlTextLoader();
const { expectedWebMigrations } = await import('../../../workers/web-cloudflare/migrations.ts');

const sha = (sql: string) => createHash('sha256').update(sql).digest('hex');
const sql124 = () =>
  readFileSync(new URL('../../../apps/server/web-migrations/124_model_settings.sql', import.meta.url), 'utf8');
const NEW_TABLES = [
  'web_model_changes',
  'web_model_save_requests',
  'web_model_settings',
  'web_model_voice',
  'web_price_versions',
];
const tables = (store: Store) =>
  store
    .all<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name IN (${NEW_TABLES.map((n) => `'${n}'`).join(',')}) ORDER BY name`,
    )
    .map((row) => row.name);

test('local runner: 124 is its own step after 123, writes today’s defaults and is not repeatable', (t) => {
  const store = schema123();
  t.after(() => store.close());
  assert.equal(store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 123);
  assert.deepEqual(tables(store), []);
  migrateWebProviderModelSettings(store);
  assert.equal(store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 124);
  assert.deepEqual(tables(store), NEW_TABLES);
  assert.equal(store.get('PRAGMA foreign_key_check'), undefined);
  assert.deepEqual(
    store
      .all<{
        model: string;
        enabled: number;
        allowed_guest: number;
        allowed_registered: number;
        allowed_invited: number;
        points_per_reply: number;
        updated_by_admin: string | null;
      }>(
        'SELECT model,enabled,allowed_guest,allowed_registered,allowed_invited,points_per_reply,updated_by_admin FROM web_model_settings ORDER BY rowid',
      )
      .map((r) => ({
        model: r.model,
        enabled: r.enabled === 1,
        guest: r.allowed_guest === 1,
        registered: r.allowed_registered === 1,
        invited: r.allowed_invited === 1,
        points: r.points_per_reply,
        by: r.updated_by_admin,
      })),
    DEFAULT_MODEL_SETTINGS.models.map((m) => ({ ...m, by: null })),
  );
  assert.deepEqual(
    { ...store.get('SELECT voice_points,revision FROM web_model_voice')! },
    { voice_points: 2, revision: 1 },
  );
  assert.deepEqual(
    store.all<{ version: number }>('SELECT version FROM web_price_versions ORDER BY version').map((r) => r.version),
    [1, 2],
  );
  assert.throws(() => migrateWebProviderModelSettings(store), /WEB_PROVIDER_MODEL_SETTINGS_MIGRATION_REQUIRED/);
  const fresh = new Store(':memory:');
  t.after(() => fresh.close());
  assert.throws(() => migrateWebProviderModelSettings(fresh), /WEB_PROVIDER_MODEL_SETTINGS_MIGRATION_REQUIRED/);
});

test('the tables only accept what the page writes: the three models once each, switches 0/1, 1-200 and 0-20 points, one voice row', (t) => {
  const store = schema123();
  t.after(() => store.close());
  migrateWebProviderModelSettings(store);
  const row = (over: Partial<Record<string, string | number | null>> = {}) =>
    store.run(
      'INSERT INTO web_model_settings(model,enabled,allowed_guest,allowed_registered,allowed_invited,points_per_reply,updated_at,updated_by_admin) VALUES (?,?,?,?,?,?,?,?)',
      ...(Object.values({
        model: 'other',
        enabled: 1,
        g: 1,
        r: 1,
        i: 1,
        points: 10,
        at: 0,
        by: null,
        ...over,
      }) as never[]),
    );
  assert.throws(() => row({ model: 'deepseek' }), 'one row per model');
  assert.throws(() => row({ model: 'claude' }), 'only the three player models');
  store.run("DELETE FROM web_model_settings WHERE model='xai'");
  for (const bad of [{ enabled: 2 }, { g: 2 }, { points: 0 }, { points: 201 }])
    assert.throws(() => row({ model: 'xai', ...bad }), JSON.stringify(bad));
  assert.throws(() =>
    store.run('INSERT INTO web_model_voice(singleton,voice_points,revision,updated_at) VALUES (2,1,1,0)'),
  );
  assert.throws(() => store.run('UPDATE web_model_voice SET voice_points=21'));
  assert.throws(() => store.run('UPDATE web_model_voice SET voice_points=-1'));
  // The change log: a voice row has no model, a model row has one; old and new must differ.
  const log = (model: string | null, field: string, from: number, to: number) =>
    store.run(
      'INSERT INTO web_model_changes(save_id,admin_id,model,field,old_value,new_value,price_version,created_at) VALUES (?,?,?,?,?,?,?,?)',
      's1',
      'a1',
      model,
      field,
      from,
      to,
      2,
      1,
    );
  log('gemini', 'enabled', 1, 0);
  log(null, 'voice_points', 2, 3);
  assert.throws(() => log('gemini', 'voice_points', 2, 3));
  assert.throws(() => log(null, 'enabled', 1, 0));
  assert.throws(() => log('gemini', 'enabled', 1, 1));
  assert.throws(() => log('gemini', 'password', 1, 0));
});

// Named exception (Part 22a, migration 125): the ledger now has 50 steps and 125 is the newest, so 124 is second to last. Every
// pinned hash is unchanged; only counts and positions from the end moved by one. No assertion was weakened.
test('Cloudflare runner: 124 is the same SQL on both authorities, second to last of 50 steps, and nothing before it moved', () => {
  const { inline, r2 } = expectedWebMigrations();
  // Named exception (Part 22x, migration 126): the ledger has 51 steps and 126 is the newest, so step counts, positions counted
  // from the end of the ledger and the expected user_version moved by one again. No assertion was weakened.
  // Named exception (Part 22a2, migration 127): the ledger has 52 steps and 127 is the newest, so step counts, positions counted from the end of the ledger and the expected user_version moved by one again. No assertion was weakened.
  // Named exception (Part 22c, migration 128): the ledger has 53 steps and 128 is the newest, so step counts, positions counted from the end of the ledger and the expected user_version moved by one again. No assertion was weakened.
  assert.equal(inline.length, 53);
  assert.equal(r2.length, 53);
  assert.equal(inline.at(-5)!.version, 124);
  assert.equal(r2.at(-5)!.version, 124);
  assert.equal(inline.at(-5)!.sha256, sha(sql124()), 'the ledger hash is the sha256 of the SQL file as written');
  assert.equal(inline.at(-5)!.sha256, r2.at(-5)!.sha256);
  assert.equal(
    // Named exception (Part 22c, migration 128): the ledger has 53 steps and 128 is the newest, so step counts, positions counted from the end of the ledger and the expected user_version moved by one again. No assertion was weakened.
    inline.at(-5)!.sha256,
    '5754ab5882783ac356527db8904fd2a4661c6b9ff98ee796a49a438ec1301d17',
    'pinned: a change to the file is a new migration',
  );
  // 123 (Part 21b) is untouched, byte for byte.
  // Named exception (Part 22a2, migration 127): the ledger has 52 steps and 127 is the newest, so step counts, positions counted from the end of the ledger and the expected user_version moved by one again. No assertion was weakened.
  // Named exception (Part 22c, migration 128): the ledger has 53 steps and 128 is the newest, so step counts, positions counted from the end of the ledger and the expected user_version moved by one again. No assertion was weakened.
  assert.equal(inline.at(-6)!.version, 123);
  assert.equal(
    // Named exception (Part 22c, migration 128): the ledger has 53 steps and 128 is the newest, so step counts, positions counted from the end of the ledger and the expected user_version moved by one again. No assertion was weakened.
    inline.at(-6)!.sha256,
    '432c1237ea6f460652e6e5191ae269ed975950a6ecdf5e1ffd7d3f939728db41',
    'pinned: 123 is exactly what main applied',
  );
  // Named exception (Part 22c, migration 128): the ledger has 53 steps and 128 is the newest, so step counts, positions counted from the end of the ledger and the expected user_version moved by one again. No assertion was weakened.
  assert.equal(r2.at(-6)!.sha256, inline.at(-6)!.sha256);
});

test('Cloudflare runner: an existing authority at 123 gains 124 untouched (inline and R2)', async (t) => {
  const f = localRuntime(t, 'tests/web/fixtures/cloudflare-metrics-worker.ts', { STATE: 'WebMetricsFixture' });
  for (const mode of ['inline', 'r2']) {
    const result = await f.call<{ before: string[]; after: string[]; version: unknown }>(
      `/upgrade?mode=${mode}&through=123&object=ms-${mode}`,
    );
    assert.equal(result.before.length, 48, mode);
    assert.equal(result.before.at(-1)?.startsWith('123:'), true, mode);
    assert.deepEqual(result.after.slice(0, 48), result.before, `${mode}: applied steps are untouched`);
    // Named exception (Part 22a, migration 125): opening the authority now also applies 125 after 124.
    // Named exception (Part 22a2, migration 127): the ledger has 52 steps and 127 is the newest, so step counts, positions counted from the end of the ledger and the expected user_version moved by one again. No assertion was weakened.
    // Named exception (Part 22c, migration 128): the ledger has 53 steps and 128 is the newest, so step counts, positions counted from the end of the ledger and the expected user_version moved by one again. No assertion was weakened.
    assert.equal(result.after.length, 53, mode);
    assert.equal(result.after.at(-5), `124:${sha(sql124())}`, mode);
    assert.equal(result.after.at(-4)?.startsWith('125:'), true, mode);
    assert.equal(result.after.at(-3)?.startsWith('126:'), true, mode); // Extended for migration 126: the newest step is last.
    assert.equal(result.after.at(-2)?.startsWith('127:'), true, mode); // Extended for migration 127: the newest step is last.
    assert.equal(result.after.at(-1)?.startsWith('128:'), true, mode); // Extended for migration 128: the newest step is last.
    assert.deepEqual(result.version, { user_version: 128 }, mode);
  }
});

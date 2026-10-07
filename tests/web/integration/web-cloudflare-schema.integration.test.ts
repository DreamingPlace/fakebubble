import test from 'node:test';
import assert from 'node:assert/strict';
import { localRuntime } from '../../cloudflare/runtime.ts';
import { readFileSync, readdirSync } from 'node:fs';
import { Store } from '../../../apps/server/platform/store.ts';

test('web schema113 initializes in actual workerd SQLite without beta adoption', async (t) => {
  const f = localRuntime(t, 'tests/web/fixtures/cloudflare-schema-worker.ts', { STATE: 'WebSchemaFixture' });
  const node = new Store(':memory:');
  t.after(() => node.close());
  const directory = new URL('../../../apps/server/web-migrations/', import.meta.url);
  for (const file of readdirSync(directory).sort()) {
    node.db.exec(readFileSync(new URL(file, directory), 'utf8'));
    if (file.startsWith('105_'))
      node.db.exec(`DROP TABLE web_external_attempts;
      ALTER TABLE web_external_attempts_next RENAME TO web_external_attempts;
      CREATE INDEX web_external_attempts_state ON web_external_attempts(dispatch_state,operation_id);`);
  }
  node.db.exec('PRAGMA user_version=116');
  const tables = node.all<{ name: string }>(`SELECT name FROM sqlite_master
    WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name`);
  const expected = {
    version: node.get('PRAGMA user_version'),
    budgets: [],
    tables: tables.map(({ name }) => ({
      name,
      columns: node.all(`PRAGMA table_info("${name}")`),
      foreignKeys: node.all(`PRAGMA foreign_key_list("${name}")`),
      indexes: node.all(`PRAGMA index_list("${name}")`),
    })),
    triggers: node.all("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name"),
  };
  assert.deepEqual(await f.call('/'), JSON.parse(JSON.stringify(expected)));
  assert.deepEqual(await f.call('/contract'), {
    result: { changes: 1, lastInsertRowid: 1 },
    rolledBack: 'SQL_ERROR',
    errors: [
      'SQL_INTEGER_OUT_OF_RANGE',
      'SQL_INTEGER_OUT_OF_RANGE',
      'ASYNC_TRANSACTION_FORBIDDEN',
      'ASYNC_TRANSACTION_FORBIDDEN',
      'WEB_CLOUD_INSTANCE_MISMATCH',
      'WEB_CLOUD_INSTANCE_MISMATCH',
      'WEB_CLOUD_MIGRATION_MISMATCH',
    ],
    row: { value: 'outer', bytes: [1, 2, 3] },
  });
  await f.restart();
  assert.deepEqual(await f.call('/persisted'), { value: 'outer' });
  assert.deepEqual(await f.call('/foreign?object=foreign'), {
    error: 'WEB_CLOUD_EMPTY_REQUIRED',
    rows: [{ singleton: 1, instance_id: 'preserved' }],
  });
  assert.deepEqual(await f.call('/fail-init?object=fail'), { error: 'SQL_ERROR', tables: [] });
  for (const mode of ['r2-without-storage', 'inline-with-storage'])
    assert.deepEqual(await f.call(`/${mode}?object=${mode}`), {
      error: 'WEB_CLOUD_MEDIA_MODE_MISMATCH',
      tables: [],
    });
});

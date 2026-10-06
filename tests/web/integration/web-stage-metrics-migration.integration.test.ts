import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { localRuntime } from '../../cloudflare/runtime.ts';
import { Store } from '../../../apps/server/platform/store.ts';
import {
  migrateWebProviderMetrics,
  migrateWebProviderOffline,
} from '../../../apps/server/generation/web-provider-migration.ts';

function nodeAt113() {
  const store = new Store(':memory:');
  const folder = new URL('../../../apps/server/web-migrations/', import.meta.url);
  for (const file of readdirSync(folder).sort()) {
    if (Number(file.slice(0, 3)) > 112) break;
    store.db.exec(readFileSync(new URL(file, folder), 'utf8'));
  }
  store.db.exec('PRAGMA user_version=112');
  migrateWebProviderOffline(store);
  return store;
}

test('local runner: the metrics migration adds its tables to schema 113, keeps user_version and is not repeatable', (t) => {
  const store = nodeAt113();
  t.after(() => store.close());
  assert.equal(store.get('SELECT 1 FROM sqlite_master WHERE name=?', 'web_operation_metrics'), undefined);
  migrateWebProviderMetrics(store);
  assert.equal(store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 113);
  for (const name of ['web_operation_metrics', 'web_attempt_rejections'])
    assert.ok(store.get('SELECT 1 FROM sqlite_master WHERE type=? AND name=?', 'table', name), name);
  const media = store
    .all<{ name: string; notnull: number }>('PRAGMA table_info(web_publication_items)')
    .find((column) => column.name === 'media_id')!;
  assert.equal(media.notnull, 0, 'text fallback items have no audio');
  assert.deepEqual(
    store
      .all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='web_publication_items' ORDER BY name",
      )
      .map((row) => row.name),
    ['web_publication_items_no_delete', 'web_publication_items_no_update'],
  );
  assert.throws(() => migrateWebProviderMetrics(store), /WEB_PROVIDER_METRICS_MIGRATION_REQUIRED/);
});

test('Cloudflare runner: both authorities create the metrics tables at ledger version 113; Worker vars are validated', async (t) => {
  const f = localRuntime(t, 'tests/web/fixtures/cloudflare-metrics-worker.ts', { STATE: 'WebMetricsFixture' });
  const inline = await f.call<Record<string, unknown>>('/inline?object=inline');
  assert.equal(inline.metrics, true);
  assert.deepEqual(inline.version, { user_version: 113 });
  assert.equal(inline.mediaIdNotNull, 0);
  assert.deepEqual(inline.concurrency, {
    maxTextRunning: 20,
    maxAudioRunning: 4,
    maxWaitingOperations: 104,
    maxGlobalReservedOperations: 128,
    audioFallbackWaitMs: 8000,
  });
  const r2 = await f.call<Record<string, unknown>>('/r2?object=r2');
  assert.equal(r2.metrics, true);
  assert.deepEqual(r2.version, { user_version: 113 });
  assert.equal(r2.mediaIdNotNull, 0);
  assert.deepEqual(r2.itemTriggers, ['web_publication_items_no_delete', 'web_publication_items_no_update']);
  assert.deepEqual(
    r2.ledger,
    Array.from({ length: 24 }, (_, i) => i + 1).concat(Array.from({ length: 14 }, (_, i) => 100 + i)),
    'no extra ledger version: the metrics SQL rides with 113',
  );
  assert.deepEqual(r2.concurrency, {
    maxTextRunning: 7,
    maxAudioRunning: 3,
    maxWaitingOperations: 104,
    maxGlobalReservedOperations: 114,
    audioFallbackWaitMs: 8000,
  });
  assert.deepEqual(await f.call('/invalid?object=invalid'), {
    errors: [
      'WEB_CONCURRENCY_INVALID_TEXT',
      'WEB_CONCURRENCY_INVALID_TEXT',
      'WEB_CONCURRENCY_INVALID_TEXT',
      'WEB_CONCURRENCY_INVALID_AUDIO',
      'WEB_CONCURRENCY_INVALID_AUDIO',
      'WEB_CONCURRENCY_INVALID_FALLBACK_WAIT',
    ],
    tables: [],
  });
});

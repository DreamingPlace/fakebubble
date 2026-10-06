import { readFileSync } from 'node:fs';
import { ensure } from '../../../packages/domain/errors.ts';
import { WebStore, type Store } from '../platform/store.ts';

/** Node-only 112→113 migration; the cloud runtime initializes a separate empty authority. */
export function migrateWebProviderOffline(store: Store) {
  ensure(
    store.get<{ file: string }>('PRAGMA database_list')?.file === '' ||
      (store instanceof WebStore && store.providerRuntime),
    'WEB_PROVIDER_OFFLINE_ONLY',
  );
  store.transaction(() => {
    ensure(
      store.get<{ user_version: number }>('PRAGMA user_version')?.user_version === 112 &&
        store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_v7_requests'") &&
        store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_invite_grants'"),
      'WEB_PROVIDER_MIGRATION_REQUIRED',
    );
    store.db.exec(readFileSync(new URL('../web-migrations/113_provider_offline.sql', import.meta.url), 'utf8'));
    ensure(!store.get('PRAGMA foreign_key_check'), 'WEB_PROVIDER_MIGRATION_FOREIGN_KEY_INVALID');
    store.db.exec('PRAGMA user_version = 113');
  });
}

/**
 * Node-only: add the stage metrics and 429 bookkeeping tables (114_stage_metrics.sql) to a schema-113 database.
 * user_version stays 113 (the Cloudflare runner folds the same file into its final step), so every schema-113
 * check keeps holding; the new tables are detected by presence.
 */
export function migrateWebProviderMetrics(store: Store) {
  ensure(
    store.get<{ file: string }>('PRAGMA database_list')?.file === '' ||
      (store instanceof WebStore && store.providerRuntime),
    'WEB_PROVIDER_OFFLINE_ONLY',
  );
  store.transaction(() => {
    ensure(
      store.get<{ user_version: number }>('PRAGMA user_version')?.user_version === 113 &&
        store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_provider_attempts'") &&
        !store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_operation_metrics'"),
      'WEB_PROVIDER_METRICS_MIGRATION_REQUIRED',
    );
    store.db.exec(readFileSync(new URL('../web-migrations/114_stage_metrics.sql', import.meta.url), 'utf8'));
    ensure(!store.get('PRAGMA foreign_key_check'), 'WEB_PROVIDER_MIGRATION_FOREIGN_KEY_INVALID');
  });
}

import { readFileSync } from 'node:fs';
import { ensure } from '../../packages/domain/errors.ts';
import { WebStore, type Store } from './store.ts';

/** Node-only 112→113 migration; the cloud runtime initializes a separate empty authority. */
export function migrateWebProviderOffline(store: Store) {
  ensure(store.get<{ file: string }>('PRAGMA database_list')?.file === '' ||
    store instanceof WebStore && store.providerRuntime, 'WEB_PROVIDER_OFFLINE_ONLY');
  store.transaction(() => {
    ensure(store.get<{ user_version: number }>('PRAGMA user_version')?.user_version === 112 &&
      store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_v7_requests'") &&
      store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_invite_grants'"),
    'WEB_PROVIDER_MIGRATION_REQUIRED');
    store.db.exec(readFileSync(new URL('./web-migrations/113_provider_offline.sql', import.meta.url), 'utf8'));
    ensure(!store.get('PRAGMA foreign_key_check'), 'WEB_PROVIDER_MIGRATION_FOREIGN_KEY_INVALID');
    store.db.exec('PRAGMA user_version = 113');
  });
}

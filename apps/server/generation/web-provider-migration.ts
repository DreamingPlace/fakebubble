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

/** Node-only 113→114: stage metrics and 429 bookkeeping (114_stage_metrics.sql), applied like every other step. */
export function migrateWebProviderMetrics(store: Store) {
  ensure(
    store.get<{ file: string }>('PRAGMA database_list')?.file === '' ||
      (store instanceof WebStore && store.providerRuntime),
    'WEB_PROVIDER_OFFLINE_ONLY',
  );
  store.transaction(() => {
    ensure(
      store.get<{ user_version: number }>('PRAGMA user_version')?.user_version === 113 &&
        store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_provider_attempts'"),
      'WEB_PROVIDER_METRICS_MIGRATION_REQUIRED',
    );
    store.db.exec(readFileSync(new URL('../web-migrations/114_stage_metrics.sql', import.meta.url), 'utf8'));
    ensure(!store.get('PRAGMA foreign_key_check'), 'WEB_PROVIDER_MIGRATION_FOREIGN_KEY_INVALID');
    store.db.exec('PRAGMA user_version = 114');
  });
}

/** Node-only 114→115: memory importance, player facts and the review_changed metric (115_memory_importance.sql). */
export function migrateWebProviderMemory(store: Store) {
  ensure(
    store.get<{ file: string }>('PRAGMA database_list')?.file === '' ||
      (store instanceof WebStore && store.providerRuntime),
    'WEB_PROVIDER_OFFLINE_ONLY',
  );
  store.transaction(() => {
    ensure(
      store.get<{ user_version: number }>('PRAGMA user_version')?.user_version === 114 &&
        store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_operation_metrics'"),
      'WEB_PROVIDER_MEMORY_MIGRATION_REQUIRED',
    );
    store.db.exec(readFileSync(new URL('../web-migrations/115_memory_importance.sql', import.meta.url), 'utf8'));
    ensure(!store.get('PRAGMA foreign_key_check'), 'WEB_PROVIDER_MIGRATION_FOREIGN_KEY_INVALID');
    store.db.exec('PRAGMA user_version = 115');
  });
}

/** Node-only 115→116: memory topic embeddings, the embedding dispatch ledger and its daily counters (116_memory_embeddings.sql). */
export function migrateWebProviderEmbeddings(store: Store) {
  ensure(
    store.get<{ file: string }>('PRAGMA database_list')?.file === '' ||
      (store instanceof WebStore && store.providerRuntime),
    'WEB_PROVIDER_OFFLINE_ONLY',
  );
  store.transaction(() => {
    ensure(
      store.get<{ user_version: number }>('PRAGMA user_version')?.user_version === 115 &&
        store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_facts'"),
      'WEB_PROVIDER_EMBEDDING_MIGRATION_REQUIRED',
    );
    store.db.exec(readFileSync(new URL('../web-migrations/116_memory_embeddings.sql', import.meta.url), 'utf8'));
    ensure(!store.get('PRAGMA foreign_key_check'), 'WEB_PROVIDER_MIGRATION_FOREIGN_KEY_INVALID');
    store.db.exec('PRAGMA user_version = 116');
  });
}

/** Node-only 116→117: player co-creation submissions and their answers (117_cocreation.sql). */
export function migrateWebProviderCocreation(store: Store) {
  ensure(
    store.get<{ file: string }>('PRAGMA database_list')?.file === '' ||
      (store instanceof WebStore && store.providerRuntime),
    'WEB_PROVIDER_OFFLINE_ONLY',
  );
  store.transaction(() => {
    ensure(
      store.get<{ user_version: number }>('PRAGMA user_version')?.user_version === 116 &&
        store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_embeddings'"),
      'WEB_PROVIDER_COCREATION_MIGRATION_REQUIRED',
    );
    store.db.exec(readFileSync(new URL('../web-migrations/117_cocreation.sql', import.meta.url), 'utf8'));
    ensure(!store.get('PRAGMA foreign_key_check'), 'WEB_PROVIDER_MIGRATION_FOREIGN_KEY_INVALID');
    store.db.exec('PRAGMA user_version = 117');
  });
}

/** Node-only 117→118: player email logins, email challenges and send counters (118_player_logins.sql). */
export function migrateWebProviderLogins(store: Store) {
  ensure(
    store.get<{ file: string }>('PRAGMA database_list')?.file === '' ||
      (store instanceof WebStore && store.providerRuntime),
    'WEB_PROVIDER_OFFLINE_ONLY',
  );
  store.transaction(() => {
    ensure(
      store.get<{ user_version: number }>('PRAGMA user_version')?.user_version === 117 &&
        store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_cocreation_submissions'"),
      'WEB_PROVIDER_LOGIN_MIGRATION_REQUIRED',
    );
    store.db.exec(readFileSync(new URL('../web-migrations/118_player_logins.sql', import.meta.url), 'utf8'));
    ensure(!store.get('PRAGMA foreign_key_check'), 'WEB_PROVIDER_MIGRATION_FOREIGN_KEY_INVALID');
    store.db.exec('PRAGMA user_version = 118');
  });
}

/** Node-only 118→119: preview runs, time marks, rejected stage output and eval sets (119_preview_workbench.sql). */
export function migrateWebProviderPreviewWorkbench(store: Store) {
  ensure(
    store.get<{ file: string }>('PRAGMA database_list')?.file === '' ||
      (store instanceof WebStore && store.providerRuntime),
    'WEB_PROVIDER_OFFLINE_ONLY',
  );
  store.transaction(() => {
    ensure(
      store.get<{ user_version: number }>('PRAGMA user_version')?.user_version === 118 &&
        store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_player_logins'"),
      'WEB_PROVIDER_PREVIEW_WORKBENCH_MIGRATION_REQUIRED',
    );
    store.db.exec(readFileSync(new URL('../web-migrations/119_preview_workbench.sql', import.meta.url), 'utf8'));
    ensure(!store.get('PRAGMA foreign_key_check'), 'WEB_PROVIDER_MIGRATION_FOREIGN_KEY_INVALID');
    store.db.exec('PRAGMA user_version = 119');
  });
}

/** Node-only 119→120: daily counters for dropped topics / factOps (120_memory_metadata_metrics.sql). */
export function migrateWebProviderMemoryMetrics(store: Store) {
  ensure(
    store.get<{ file: string }>('PRAGMA database_list')?.file === '' ||
      (store instanceof WebStore && store.providerRuntime),
    'WEB_PROVIDER_OFFLINE_ONLY',
  );
  store.transaction(() => {
    ensure(
      store.get<{ user_version: number }>('PRAGMA user_version')?.user_version === 119 &&
        store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_preview_runs'"),
      'WEB_PROVIDER_MEMORY_METRICS_MIGRATION_REQUIRED',
    );
    store.db.exec(readFileSync(new URL('../web-migrations/120_memory_metadata_metrics.sql', import.meta.url), 'utf8'));
    ensure(!store.get('PRAGMA foreign_key_check'), 'WEB_PROVIDER_MIGRATION_FOREIGN_KEY_INVALID');
    store.db.exec('PRAGMA user_version = 120');
  });
}

/** Node-only 120→121: signup bonus tables (121_signup_bonus.sql). */
export function migrateWebProviderSignupBonus(store: Store) {
  ensure(
    store.get<{ file: string }>('PRAGMA database_list')?.file === '' ||
      (store instanceof WebStore && store.providerRuntime),
    'WEB_PROVIDER_OFFLINE_ONLY',
  );
  store.transaction(() => {
    ensure(
      store.get<{ user_version: number }>('PRAGMA user_version')?.user_version === 120 &&
        store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_operation_metrics'"),
      'WEB_PROVIDER_SIGNUP_BONUS_MIGRATION_REQUIRED',
    );
    store.db.exec(readFileSync(new URL('../web-migrations/121_signup_bonus.sql', import.meta.url), 'utf8'));
    ensure(!store.get('PRAGMA foreign_key_check'), 'WEB_PROVIDER_MIGRATION_FOREIGN_KEY_INVALID');
    store.db.exec('PRAGMA user_version = 121');
  });
}

/** Node-only 121→122: tester chat review tables (122_chat_review.sql). */
export function migrateWebProviderChatReview(store: Store) {
  ensure(
    store.get<{ file: string }>('PRAGMA database_list')?.file === '' ||
      (store instanceof WebStore && store.providerRuntime),
    'WEB_PROVIDER_OFFLINE_ONLY',
  );
  store.transaction(() => {
    ensure(
      store.get<{ user_version: number }>('PRAGMA user_version')?.user_version === 121 &&
        store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_signup_bonus'"),
      'WEB_PROVIDER_CHAT_REVIEW_MIGRATION_REQUIRED',
    );
    store.db.exec(readFileSync(new URL('../web-migrations/122_chat_review.sql', import.meta.url), 'utf8'));
    ensure(!store.get('PRAGMA foreign_key_check'), 'WEB_PROVIDER_MIGRATION_FOREIGN_KEY_INVALID');
    store.db.exec('PRAGMA user_version = 122');
  });
}

/** Node-only 122→123: player model choice, points, backup log and usage aggregates (123_model_choice.sql). */
export function migrateWebProviderModelChoice(store: Store) {
  ensure(
    store.get<{ file: string }>('PRAGMA database_list')?.file === '' ||
      (store instanceof WebStore && store.providerRuntime),
    'WEB_PROVIDER_OFFLINE_ONLY',
  );
  store.transaction(() => {
    ensure(
      store.get<{ user_version: number }>('PRAGMA user_version')?.user_version === 122 &&
        store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_review_codes'"),
      'WEB_PROVIDER_MODEL_CHOICE_MIGRATION_REQUIRED',
    );
    store.db.exec(readFileSync(new URL('../web-migrations/123_model_choice.sql', import.meta.url), 'utf8'));
    ensure(!store.get('PRAGMA foreign_key_check'), 'WEB_PROVIDER_MIGRATION_FOREIGN_KEY_INVALID');
    store.db.exec('PRAGMA user_version = 123');
  });
}

/** Node-only 123→124: owner-controlled reply models and prices (124_model_settings.sql). */
export function migrateWebProviderModelSettings(store: Store) {
  ensure(
    store.get<{ file: string }>('PRAGMA database_list')?.file === '' ||
      (store instanceof WebStore && store.providerRuntime),
    'WEB_PROVIDER_OFFLINE_ONLY',
  );
  store.transaction(() => {
    ensure(
      store.get<{ user_version: number }>('PRAGMA user_version')?.user_version === 123 &&
        store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_operation_models'"),
      'WEB_PROVIDER_MODEL_SETTINGS_MIGRATION_REQUIRED',
    );
    store.db.exec(readFileSync(new URL('../web-migrations/124_model_settings.sql', import.meta.url), 'utf8'));
    ensure(!store.get('PRAGMA foreign_key_check'), 'WEB_PROVIDER_MIGRATION_FOREIGN_KEY_INVALID');
    store.db.exec('PRAGMA user_version = 124');
  });
}

/** Node-only 124→125: invite tiers - entitlements, batches, player numbers (125_invite_tiers.sql). */
export function migrateWebProviderInviteTiers(store: Store) {
  ensure(
    store.get<{ file: string }>('PRAGMA database_list')?.file === '' ||
      (store instanceof WebStore && store.providerRuntime),
    'WEB_PROVIDER_OFFLINE_ONLY',
  );
  store.transaction(() => {
    ensure(
      store.get<{ user_version: number }>('PRAGMA user_version')?.user_version === 124 &&
        store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_model_settings'"),
      'WEB_PROVIDER_INVITE_TIERS_MIGRATION_REQUIRED',
    );
    store.db.exec(readFileSync(new URL('../web-migrations/125_invite_tiers.sql', import.meta.url), 'utf8'));
    ensure(!store.get('PRAGMA foreign_key_check'), 'WEB_PROVIDER_MIGRATION_FOREIGN_KEY_INVALID');
    store.db.exec('PRAGMA user_version = 125');
  });
}

/** Node-only 125→126: the legacy invite principals become guests (126_legacy_invites_retired.sql, data only). */
export function migrateWebProviderLegacyInvites(store: Store) {
  ensure(
    store.get<{ file: string }>('PRAGMA database_list')?.file === '' ||
      (store instanceof WebStore && store.providerRuntime),
    'WEB_PROVIDER_OFFLINE_ONLY',
  );
  store.transaction(() => {
    ensure(
      store.get<{ user_version: number }>('PRAGMA user_version')?.user_version === 125 &&
        store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_entitlements'"),
      'WEB_PROVIDER_LEGACY_INVITES_MIGRATION_REQUIRED',
    );
    store.db.exec(readFileSync(new URL('../web-migrations/126_legacy_invites_retired.sql', import.meta.url), 'utf8'));
    ensure(!store.get('PRAGMA foreign_key_check'), 'WEB_PROVIDER_MIGRATION_FOREIGN_KEY_INVALID');
    store.db.exec('PRAGMA user_version = 126');
  });
}

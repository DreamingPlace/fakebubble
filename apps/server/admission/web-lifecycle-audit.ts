import { DetailedError, ensure } from '../../../packages/domain/errors.ts';
import { isWorkerdReservedTable } from '../platform/workerd-reserved-tables.ts';
import type { WebRuntimeStore as WebStore } from '../platform/web-store-contract.ts';
import { cocreationRemains } from '../cocreation/web-cocreation-purge.ts';
import { playerLoginsRemain } from '../identity/web-player-purge.ts';
import { archiveHasIdentityColumn, closedAccountsHaveIdentityColumn } from '../review/web-chat-review.ts';

/**
 * Part 24h. The one refusal of this audit that says WHICH check failed: a table name (only a name read from sqlite_master that
 * matches the identifier pattern) or one of the fixed labels: reply_items, invite_grant_live, cocreation, player_logins,
 * archive_identity, closed_accounts_identity, legacy_non_web. Never an id, a world, a principal or any content.
 */
const UNEXPECTED_WORLD_DATA = 'WEB_RETENTION_UNEXPECTED_WORLD_DATA';
const SAFE_DETAIL = /^[A-Za-z_][A-Za-z0-9_]*$/;
export function unexpectedWorldData(table: string): DetailedError {
  return new DetailedError(UNEXPECTED_WORLD_DATA, { table: SAFE_DETAIL.test(table) ? table.slice(0, 64) : 'unknown' });
}
/** Throws the labelled refusal when `clean` is false. */
function ensureClean(clean: unknown, table: string): asserts clean {
  if (!clean) throw unexpectedWorldData(table);
}

const shells = new Set([
  'web_principals',
  'web_operations',
  'web_external_attempts',
  'web_guest_retention',
  'web_retention_file_cleanup',
  'contacts',
  'conversations',
  'world_characters',
  'participants',
  // Part 17 (删除我的账号): an invited player's REVOKED grant stays as a shell - ids and times only, no content, the
  // record that a code was redeemed. A live grant never survives a cleared world (checked below).
  'web_invite_grants',
]);
const handled = new Set([
  'web_local_events',
  'web_user_events',
  'web_input_snapshots',
  'web_v7_requests',
  'web_private_audio_assets',
  'web_publications',
  'messages',
  'jobs',
  'memory_facts',
  'memory_embeddings',
  'web_embed_attempts',
  'memory_episode_sources',
  'memory_mentions',
  'memory_episodes',
  'memory_corrections',
  'memory_catalog',
  'memory_context_versions',
  'memory_topics',
  'relationship_corrections',
  'relationship_reviews',
  'relationship_events',
  'relationship_job_contexts',
  'relationship_daily_budgets',
  'relationship_states',
  'scene_events',
  'scene_job_contexts',
  'scene_end_requests',
  'scene_states',
  'job_evidence_snapshots',
  'dialogue_bubbles',
  'outbox',
  // Nickname 名片 revisions written at signup; the cleaners delete them with the player (schema 118).
  'player_profile_versions',
  'player_profile_requests',
  // Part 24k-2: the welcome line a player was given for a character; deleted with the player (purgePlayerLogins).
  'web_welcome_choices',
]);

/** Check the actual schema, not merely the list of tables current code knows to delete. */
export function auditWebLifecycleWorld(
  store: WebStore,
  worldId: string,
  phase: 'source' | 'cleared',
  mode: 'synthetic' | 'provider' = 'synthetic',
) {
  const provider = mode === 'provider';
  if (provider)
    ensure(
      store.providerAudio &&
        (store.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? -1) >= 113 &&
        store.get("SELECT 1 FROM sqlite_master WHERE name='cf_web_audio_objects'"),
      'WEB_RETENTION_SCOPE_UNSAFE',
    );
  // web_operation_metrics and web_attempt_rejections hold only counters and timings keyed by operation (no content),
  // like the attempt shells that outlive a purge.
  const providerShells = new Set([
    'web_provider_attempts',
    'cf_web_audio_objects',
    'web_character_deletion_scopes',
    'web_operation_metrics',
    'web_attempt_rejections',
    // Part 17b: one row per operation admitted on a free allowance: ids, a tier and (trial_extra) the keyed IP hash, no content.
    // The 'bonus' rows are deleted with the player and checked gone by playerLoginsRemain; 'trial_extra' rows stay like the IP quota.
    'web_free_operations',
    // Part 21b: per-operation model choice and the log of models a provider proved did not run: ids, enums and counts,
    // no principal id and no content (the points events themselves are removed with the player, below).
    'web_operation_models',
    'web_provider_backups',
    // Part 22d: the frozen user type of an operation (an enum next to the operation id, like the model row).
    'web_operation_user_types',
    // Part 26b: the review model frozen at admission (an operation id and an enum, no content)
    'web_operation_review_models',
  ]);
  const operationContent = new Set([
    'web_provider_outputs',
    'web_provider_candidates',
    'web_provider_voice_segments',
    'web_provider_media_assets',
    'web_stage_attempts',
    'web_synthetic_voice_segments',
    'web_reviewed_candidates',
    'web_input_snapshots',
    'web_private_audio_assets',
    'web_v7_requests',
    'web_v7_candidates',
    'web_publications',
    'web_publication_items',
    'web_local_text_outputs',
    'web_local_audio_outputs',
    'web_local_events',
    'web_user_events',
    // Part 21b: removed with the player by purgePlayerLogins; playerLoginsRemain checks they are gone.
    'web_points_events',
    // Part 24h: the reply-time embedding of an account / signup-bonus player's input (schema 116, kind 'query') names the
    // operation as well as the world, so this operation_id check saw it before the cleaner (DELETE ... WHERE world_id=?)
    // had run, and a guest with one could never be purged (table web_embed_attempts, audit_source, for ever). The row holds
    // ids, an enum, counts and times (never the text or the vector); it is deleted with the player in the same transaction
    // and is checked gone in the cleared phase, where this list no longer applies. An unsent hold is returned by
    // releaseUnsentEmbedHolds first; a sent or UNKNOWN hold stays in web_provider_spending, as everywhere.
    'web_embed_attempts',
  ]);
  const tables = store.all<{ name: string }>(`SELECT name FROM sqlite_master
    WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`);
  for (const { name } of tables) {
    ensure(/^[A-Za-z_][A-Za-z0-9_]*$/.test(name), 'WEB_RETENTION_UNRECOGNIZED_TABLE');
    // workerd's own tables (_cf_METADATA for alarms, _cf_KV for ctx.storage.put/get) deny even table_info, and workerd
    // refuses an application table with that prefix, so skipping them never hides application data. Every other
    // unknown table still fails closed below.
    if (provider && isWorkerdReservedTable(name)) continue;
    const columns = store.all<{ name: string }>(`PRAGMA table_info("${name}")`);
    if (
      provider &&
      columns.some((column) => column.name === 'operation_id') &&
      !shells.has(name) &&
      !providerShells.has(name) &&
      !(phase === 'source' && operationContent.has(name))
    )
      ensureClean(
        !store.get(
          `SELECT 1 FROM "${name}"
        WHERE operation_id IN (SELECT id FROM web_operations WHERE world_id=?) LIMIT 1`,
          worldId,
        ),
        name,
      );
    if (!columns.some((column) => column.name === 'world_id')) continue;
    if (
      shells.has(name) ||
      (provider && providerShells.has(name)) ||
      (phase === 'source' && (handled.has(name) || (provider && operationContent.has(name))))
    )
      continue;
    ensureClean(!store.get(`SELECT 1 FROM "${name}" WHERE world_id=? LIMIT 1`, worldId), name);
  }
  ensureClean(
    !store.get(
      `SELECT 1 FROM reply_items r WHERE
    EXISTS (SELECT 1 FROM messages m WHERE m.id=r.message_id AND m.world_id=?) OR
    EXISTS (SELECT 1 FROM jobs j WHERE j.id=r.job_id AND j.world_id=?) LIMIT 1`,
      worldId,
      worldId,
    ),
    'reply_items',
  );
  // Part 22c: xAI and Gemini attempts (Part 21b: a reply written by the chosen model, or the last model of an exhausted chain) are
  // provider attempts too; without them in this list a player with such a reply could never be purged.
  if (provider)
    ensure(
      !store.get(
        `SELECT 1 FROM web_external_attempts a JOIN web_operations o ON o.id=a.operation_id
    WHERE o.world_id=? AND (a.provider_request_id<>a.operation_id||':'||a.phase||':'||a.ordinal OR NOT EXISTS (
      SELECT 1 FROM web_provider_attempts p WHERE p.operation_id=a.operation_id AND p.phase=a.phase AND p.ordinal=a.ordinal
        AND p.principal_id=a.principal_id AND p.world_id=a.world_id AND p.conversation_id=a.conversation_id
        AND p.input_message_id=a.input_message_id AND p.provider=a.provider AND p.provider IN ('deepseek','fish','xai','gemini'))) LIMIT 1`,
        worldId,
      ),
      'WEB_RETENTION_EXTERNAL_INTENT_UNSAFE',
    );
  else
    ensure(
      !store.get(
        `SELECT 1 FROM web_external_attempts a JOIN web_operations o
    ON o.id=a.operation_id WHERE o.world_id=? AND
    (a.provider<>'synthetic-local' OR a.provider_request_id<>CASE
      WHEN a.stage='text' THEN a.operation_id||':'||a.phase
      ELSE a.operation_id||':speech:'||a.ordinal END) LIMIT 1`,
        worldId,
      ),
      'WEB_RETENTION_EXTERNAL_INTENT_UNSAFE',
    );
  if (phase === 'cleared' && store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_invite_grants'"))
    ensureClean(
      !store.get('SELECT 1 FROM web_invite_grants WHERE world_id=? AND revoked_at IS NULL LIMIT 1', worldId),
      'invite_grant_live',
    );
  // Co-creation ideas (117) carry the principal, not the world: a cleared world has none left for its principals.
  if (phase === 'cleared')
    ensureClean(
      !cocreationRemains(store, {
        principalIds: store
          .all<{ id: string }>('SELECT id FROM web_principals WHERE world_id=?', worldId)
          .map((row) => row.id),
      }),
      'cocreation',
    );
  // The email login (118) carries the principal too: a cleared world leaves none of its players' logins or challenges.
  if (phase === 'cleared')
    ensureClean(
      !playerLoginsRemain(
        store,
        store.all<{ id: string }>('SELECT id FROM web_principals WHERE world_id=?', worldId).map((row) => row.id),
      ),
      'player_logins',
    );
  // Part 19: the anonymous review archive may never name an account: no principal / world / player / ... column at all.
  ensureClean(!archiveHasIdentityColumn(store), 'archive_identity');
  // Part 31: the 已关闭账号 table holds a 玩家编号, a code and two times: no other column, ever.
  ensureClean(!closedAccountsHaveIdentityColumn(store), 'closed_accounts_identity');
  if (phase === 'source') {
    ensure(
      !store.get(
        `SELECT 1 FROM messages m WHERE m.world_id=?
      AND NOT EXISTS (SELECT 1 FROM web_operations o WHERE o.input_message_id=m.id)
      AND NOT EXISTS (SELECT 1 FROM web_publication_items i WHERE i.message_id=m.id) LIMIT 1`,
        worldId,
      ) &&
        !store.get(
          `SELECT 1 FROM jobs j WHERE j.world_id=? AND NOT EXISTS
        (SELECT 1 FROM web_publications p WHERE p.job_id=j.id) LIMIT 1`,
          worldId,
        ),
      'WEB_RETENTION_UNRECOGNIZED_CONTENT',
    );
  }
}

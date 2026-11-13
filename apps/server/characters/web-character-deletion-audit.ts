import { DetailedError, RetryAfterError, ensure } from '../../../packages/domain/errors.ts';
import { isWorkerdReservedTable } from '../platform/workerd-reserved-tables.ts';
import type { BusinessStore } from '../platform/store-contract.ts';
import { cocreationRemains } from '../cocreation/web-cocreation-purge.ts';
export const operationContent = [
  'web_publication_items',
  'web_publications',
  'web_provider_media_assets',
  'web_provider_voice_segments',
  'web_provider_candidates',
  'web_provider_outputs',
  'web_local_text_outputs',
  'web_local_audio_outputs',
  'web_v7_candidates',
  'web_v7_requests',
  'web_input_snapshots',
  'web_reviewed_candidates',
  'web_private_audio_assets',
  'web_synthetic_voice_segments',
  'web_stage_attempts',
];
export const conversationContent = [
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
  'scene_events',
  'scene_job_contexts',
  'scene_end_requests',
  'scene_states',
  'job_evidence_snapshots',
  'dialogue_bubbles',
  'outbox',
];
export const worldCharacterContent = ['relationship_daily_budgets', 'relationship_states'];
/**
 * Part 24g: account-level ledgers that a character deletion neither reads nor writes. The player purge
 * (identity/web-player-purge.ts) erases them and the lifecycle audit lists them as account-level; a character's
 * conversation is not their owner. Each is skipped by the audit ONLY while its columns are exactly the list below
 * (in table order, as PRAGMA table_info reports them). A table that gains or loses a column fails closed with
 * CHARACTER_DELETION_SCHEMA_CHANGED until someone has reviewed the new column and updated this list.
 */
export const accountLedgerColumns: Readonly<Record<string, readonly string[]>> = {
  // the player's own name card (world_id)
  player_profile_versions: ['world_id', 'revision', 'profile_json', 'updated_at'],
  player_profile_requests: ['world_id', 'request_id', 'request_hash', 'revision'],
  // quota, points, model choice and backup receipts (operation_id): kept as quota history and financial receipts
  web_free_operations: ['operation_id', 'principal_id', 'tier', 'ip_hash'],
  web_points_events: [
    'id',
    'principal_id',
    'operation_id',
    'source',
    'reason',
    'delta',
    'admin_id',
    'price_version',
    'created_at',
    'ref',
  ],
  web_operation_models: [
    'operation_id',
    'chosen',
    'voice',
    'points_charged',
    'price_version',
    'settled',
    'draft_provider',
    'draft_model',
    'review_provider',
    'review_model',
    'backup',
    'created_at',
  ],
  web_provider_backups: [
    'operation_id',
    'phase',
    'generation',
    'provider',
    'model',
    'code',
    'held_micros',
    'abandoned_at',
  ],
};
/** The refusal names the TABLE (a name read from sqlite_master that matched the identifier pattern; never an id or content). */
const unhandled = (table: string) => new DetailedError('CHARACTER_DELETION_UNHANDLED_CONTENT', { table });
function ensureClear(condition: unknown, table: string): asserts condition {
  if (!condition) throw unhandled(table);
}
/** Retry hint (ms) while a retention purge holds one of the scope's principals. */
const RETENTION_BUSY_RETRY_MS = 5000;
export interface DeletionScope {
  deletion_id: string;
  principal_id: string;
  world_id: string;
  conversation_id: string;
  character_id: string;
  db_cleared_at: number | null;
  audio_cleared_at: number | null;
}
export const operationScope =
  'SELECT id FROM web_operations WHERE principal_id=? AND world_id=? AND conversation_id=? AND character_id=?';
export const scopeArgs = (s: DeletionScope) => [s.principal_id, s.world_id, s.conversation_id, s.character_id] as const;

/** Fail closed for unknown private tables; prove one private conversation before touching any content. */
export function auditCharacterDeletionScope(
  store: BusinessStore,
  s: DeletionScope,
  cleared = false,
  /** Part 31: the owner's deletion of ONE conversation (not of a character): other players' ideas for the character are not its business. */
  conversationOnly = false,
) {
  ensure(
    store.get(
      `SELECT 1 FROM conversations c JOIN web_principals p ON p.world_id=c.world_id
    JOIN worlds w ON w.id=c.world_id AND w.owner_id=p.player_id WHERE c.world_id=? AND c.id=? AND c.kind='private'
      AND c.private_character_id=? AND p.id=?`,
      s.world_id,
      s.conversation_id,
      s.character_id,
      s.principal_id,
    ),
    'CHARACTER_DELETION_SCOPE_UNSAFE',
  );
  // A retention purge in flight for this principal or world owns the same rows: wait for it, write nothing.
  if (
    store.get(
      'SELECT 1 FROM web_retention_purge_gate WHERE principal_id=? OR world_id=? LIMIT 1',
      s.principal_id,
      s.world_id,
    )
  )
    throw new RetryAfterError('CHARACTER_DELETION_BUSY', RETENTION_BUSY_RETRY_MS);
  const allowed = new Set([
    'web_operations',
    'web_external_attempts',
    'web_provider_attempts',
    'cf_web_audio_objects',
    'conversations',
    'participants',
    'contacts',
    'world_characters',
    'web_character_deletion_scopes',
    'web_character_purge_gate',
    // Part 31: the owner's conversation deletion: its gate (present only inside its transaction) and the audio-erase record (a pair of ids and times).
    'web_conversation_purge_gate',
    'web_conversation_deletions',
    'web_principals',
    'web_guest_retention',
    'web_retention_file_cleanup',
    'web_invite_grants',
    // counters and timings keyed by operation, no content
    'web_operation_metrics',
    'web_attempt_rejections',
    // Part 22d: the frozen user type of an operation: an operation id and an enum, no content
    'web_operation_user_types',
    // Part 26b: the review model frozen at admission (an operation id and an enum, no content)
    'web_operation_review_models',
  ]);
  // Part 24k-2: the welcome line a player was given (world + character). It is the character's own to remove (the deletion deletes it
  // at once and again per scope), so it may exist BEFORE the purge and must be gone AFTER it: the generic world+character check below
  // then proves it.
  if (!cleared)
    for (const name of [
      'web_welcome_choices',
      ...operationContent,
      ...conversationContent,
      ...worldCharacterContent,
      'messages',
      'jobs',
      'web_local_events',
      'web_user_events',
    ])
      allowed.add(name);
  for (const { name } of store.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
  )) {
    if (isWorkerdReservedTable(name)) continue;
    ensure(/^[A-Za-z_][A-Za-z0-9_]*$/.test(name), 'CHARACTER_DELETION_SCOPE_UNSAFE');
    if (allowed.has(name)) continue;
    const columnList = store.all<{ name: string }>(`PRAGMA table_info("${name}")`).map((c) => c.name);
    const pinned = accountLedgerColumns[name];
    if (pinned) {
      if (columnList.length !== pinned.length || columnList.some((c, i) => c !== pinned[i]))
        throw new DetailedError('CHARACTER_DELETION_SCHEMA_CHANGED', { table: name });
      continue;
    }
    const columns = new Set(columnList);
    if (columns.has('world_id') && columns.has('conversation_id'))
      ensureClear(
        !store.get(
          `SELECT 1 FROM "${name}" WHERE world_id=? AND conversation_id=? LIMIT 1`,
          s.world_id,
          s.conversation_id,
        ),
        name,
      );
    else if (columns.has('world_id') && columns.has('character_id'))
      ensureClear(
        !store.get(`SELECT 1 FROM "${name}" WHERE world_id=? AND character_id=? LIMIT 1`, s.world_id, s.character_id),
        name,
      );
    else if (columns.has('world_id'))
      ensureClear(!store.get(`SELECT 1 FROM "${name}" WHERE world_id=? LIMIT 1`, s.world_id), name);
    if (columns.has('operation_id'))
      ensureClear(
        !store.get(`SELECT 1 FROM "${name}" WHERE operation_id IN (${operationScope}) LIMIT 1`, ...scopeArgs(s)),
        name,
      );
  }
  ensure(
    !store.get(
      `SELECT 1 FROM reply_items WHERE message_id IN (SELECT id FROM messages WHERE world_id=? AND conversation_id=?)
    OR job_id IN (SELECT id FROM jobs WHERE world_id=? AND conversation_id=?) LIMIT 1`,
      s.world_id,
      s.conversation_id,
      s.world_id,
      s.conversation_id,
    ),
    'CHARACTER_DELETION_UNHANDLED_CONTENT',
  );
  if (!cleared)
    ensure(
      !store.get(
        `SELECT 1 FROM messages m WHERE m.world_id=? AND m.conversation_id=? AND NOT EXISTS
    (SELECT 1 FROM web_operations o WHERE o.input_message_id=m.id AND o.world_id=m.world_id AND o.conversation_id=m.conversation_id)
    AND NOT EXISTS(SELECT 1 FROM web_publication_items i JOIN web_publications p ON p.operation_id=i.operation_id
      WHERE i.message_id=m.id AND p.world_id=m.world_id AND p.conversation_id=m.conversation_id) LIMIT 1`,
        s.world_id,
        s.conversation_id,
      ),
      'CHARACTER_DELETION_UNHANDLED_CONTENT',
    );
  // Players' co-creation ideas (117) are keyed by character, not by conversation: none may survive the purge.
  if (cleared && !conversationOnly)
    ensure(!cocreationRemains(store, { characterId: s.character_id }), 'CHARACTER_DELETION_UNHANDLED_CONTENT');
}

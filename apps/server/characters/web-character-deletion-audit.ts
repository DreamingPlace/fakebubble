import { ensure } from '../../../packages/domain/errors.ts';
import type { BusinessStore } from '../platform/store-contract.ts';
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
export function auditCharacterDeletionScope(store: BusinessStore, s: DeletionScope, cleared = false) {
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
    'web_principals',
    'web_guest_retention',
    'web_retention_file_cleanup',
    'web_invite_grants',
    // counters and timings keyed by operation, no content
    'web_operation_metrics',
    'web_attempt_rejections',
  ]);
  if (!cleared)
    for (const name of [
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
    if (name === '_cf_METADATA') continue;
    ensure(/^[A-Za-z_][A-Za-z0-9_]*$/.test(name), 'CHARACTER_DELETION_SCOPE_UNSAFE');
    if (allowed.has(name)) continue;
    const columns = new Set(store.all<{ name: string }>(`PRAGMA table_info("${name}")`).map((c) => c.name));
    if (columns.has('world_id') && columns.has('conversation_id'))
      ensure(
        !store.get(
          `SELECT 1 FROM "${name}" WHERE world_id=? AND conversation_id=? LIMIT 1`,
          s.world_id,
          s.conversation_id,
        ),
        'CHARACTER_DELETION_UNHANDLED_CONTENT',
      );
    else if (columns.has('world_id') && columns.has('character_id'))
      ensure(
        !store.get(`SELECT 1 FROM "${name}" WHERE world_id=? AND character_id=? LIMIT 1`, s.world_id, s.character_id),
        'CHARACTER_DELETION_UNHANDLED_CONTENT',
      );
    else if (columns.has('world_id'))
      ensure(
        !store.get(`SELECT 1 FROM "${name}" WHERE world_id=? LIMIT 1`, s.world_id),
        'CHARACTER_DELETION_UNHANDLED_CONTENT',
      );
    if (columns.has('operation_id'))
      ensure(
        !store.get(`SELECT 1 FROM "${name}" WHERE operation_id IN (${operationScope}) LIMIT 1`, ...scopeArgs(s)),
        'CHARACTER_DELETION_UNHANDLED_CONTENT',
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
}

import { ensure } from '../../../packages/domain/errors.ts';
import type { WebRuntimeStore as WebStore } from '../platform/web-store-contract.ts';
import { cocreationRemains } from '../cocreation/web-cocreation-purge.ts';
import { playerLoginsRemain } from '../identity/web-player-purge.ts';

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
  ]);
  const tables = store.all<{ name: string }>(`SELECT name FROM sqlite_master
    WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`);
  for (const { name } of tables) {
    ensure(/^[A-Za-z_][A-Za-z0-9_]*$/.test(name), 'WEB_RETENTION_UNRECOGNIZED_TABLE');
    // workerd creates this protected Alarm metadata table; even table_info is denied.
    // Exclude only that exact platform table, never arbitrary unknown application tables.
    if (provider && name === '_cf_METADATA') continue;
    const columns = store.all<{ name: string }>(`PRAGMA table_info("${name}")`);
    if (
      provider &&
      columns.some((column) => column.name === 'operation_id') &&
      !shells.has(name) &&
      !providerShells.has(name) &&
      !(phase === 'source' && operationContent.has(name))
    )
      ensure(
        !store.get(
          `SELECT 1 FROM "${name}"
        WHERE operation_id IN (SELECT id FROM web_operations WHERE world_id=?) LIMIT 1`,
          worldId,
        ),
        'WEB_RETENTION_UNEXPECTED_WORLD_DATA',
      );
    if (!columns.some((column) => column.name === 'world_id')) continue;
    if (
      shells.has(name) ||
      (provider && providerShells.has(name)) ||
      (phase === 'source' && (handled.has(name) || (provider && operationContent.has(name))))
    )
      continue;
    ensure(
      !store.get(`SELECT 1 FROM "${name}" WHERE world_id=? LIMIT 1`, worldId),
      'WEB_RETENTION_UNEXPECTED_WORLD_DATA',
    );
  }
  ensure(
    !store.get(
      `SELECT 1 FROM reply_items r WHERE
    EXISTS (SELECT 1 FROM messages m WHERE m.id=r.message_id AND m.world_id=?) OR
    EXISTS (SELECT 1 FROM jobs j WHERE j.id=r.job_id AND j.world_id=?) LIMIT 1`,
      worldId,
      worldId,
    ),
    'WEB_RETENTION_UNEXPECTED_WORLD_DATA',
  );
  if (provider)
    ensure(
      !store.get(
        `SELECT 1 FROM web_external_attempts a JOIN web_operations o ON o.id=a.operation_id
    WHERE o.world_id=? AND (a.provider_request_id<>a.operation_id||':'||a.phase||':'||a.ordinal OR NOT EXISTS (
      SELECT 1 FROM web_provider_attempts p WHERE p.operation_id=a.operation_id AND p.phase=a.phase AND p.ordinal=a.ordinal
        AND p.principal_id=a.principal_id AND p.world_id=a.world_id AND p.conversation_id=a.conversation_id
        AND p.input_message_id=a.input_message_id AND p.provider=a.provider AND p.provider IN ('deepseek','fish'))) LIMIT 1`,
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
  // Co-creation ideas (117) carry the principal, not the world: a cleared world has none left for its principals.
  if (phase === 'cleared')
    ensure(
      !cocreationRemains(store, {
        principalIds: store
          .all<{ id: string }>('SELECT id FROM web_principals WHERE world_id=?', worldId)
          .map((row) => row.id),
      }),
      'WEB_RETENTION_UNEXPECTED_WORLD_DATA',
    );
  // The email login (118) carries the principal too: a cleared world leaves none of its players' logins or challenges.
  if (phase === 'cleared')
    ensure(
      !playerLoginsRemain(
        store,
        store.all<{ id: string }>('SELECT id FROM web_principals WHERE world_id=?', worldId).map((row) => row.id),
      ),
      'WEB_RETENTION_UNEXPECTED_WORLD_DATA',
    );
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

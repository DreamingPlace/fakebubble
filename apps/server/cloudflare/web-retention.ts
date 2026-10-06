import type { Clock } from '../../../packages/contracts/index.ts';
import { DomainError, ensure } from '../../../packages/domain/errors.ts';
import { emptySession } from '../../../packages/domain/schedule.ts';
import type { WebRuntimeStore } from '../platform/web-store-contract.ts';
import { auditWebLifecycleWorld } from '../admission/web-lifecycle-audit.ts';
import { WebProviderOffline } from '../generation/web-provider-offline.ts';
import { settleWebLifetimeReservation, webReceiptDigest, type WebRetentionRow } from '../admission/web-retention.ts';
import { checkAudioReference, speechObjectScope } from '../audio/web-provider-media.ts';
import type { MediaObjectReference } from './media-objects.ts';

type Retention = WebRetentionRow & { db_cleared_at: number | null };
type ObjectIntent = {
  operation_id: string;
  ordinal: number;
  principal_id: string;
  world_id: string;
  reference_json: string;
  erased_at: number | null;
};

/** Only this new cloud113 authority. No legacy Node paths, account deletion or shared fixed media. */
export class WebCloudRetention {
  private readonly store: WebRuntimeStore;
  private readonly clock: Clock;
  lastError: string | null = null;
  constructor(store: WebRuntimeStore, clock: Clock) {
    store.requireProviderRuntime();
    ensure(
      store.providerAudio && store.get("SELECT 1 FROM sqlite_master WHERE name='cf_web_audio_objects'"),
      'WEB_CLOUD_MEDIA_MODE_MISMATCH',
    );
    this.store = store;
    this.clock = clock;
  }
  private guest(principalId: string) {
    const row = this.store.get<Retention>('SELECT * FROM web_guest_retention WHERE principal_id=?', principalId);
    ensure(
      row &&
        this.store.get(
          `SELECT 1 FROM web_principals p WHERE p.id=? AND p.world_id=? AND p.kind='guest'
      AND NOT EXISTS (SELECT 1 FROM web_accounts a WHERE a.principal_id=p.id)
      AND NOT EXISTS (SELECT 1 FROM web_invite_grants g WHERE g.principal_id=p.id)`,
          principalId,
          row.world_id,
        ),
      'WEB_RETENTION_SCOPE_UNSAFE',
    );
    return row;
  }
  nextDue() {
    const row = this.store.get<{ due: number | null }>(
      `SELECT min(CASE WHEN r.state='purging' THEN ? ELSE r.expires_at END) due
      FROM web_guest_retention r JOIN web_principals p ON p.id=r.principal_id AND p.world_id=r.world_id
      WHERE p.kind='guest' AND r.state IN ('active','purging')`,
      this.clock.now() + 30_000,
    );
    return row?.due ?? null;
  }
  async sweep(limit = 8) {
    ensure(Number.isSafeInteger(limit) && limit > 0 && limit <= 16, 'WEB_RETENTION_SWEEP_INVALID');
    const rows = this.store.all<{ principal_id: string }>(
      `SELECT r.principal_id FROM web_guest_retention r
      JOIN web_principals p ON p.id=r.principal_id AND p.world_id=r.world_id WHERE p.kind='guest'
      AND (r.state='purging' OR r.state='active' AND r.expires_at<=?) ORDER BY r.expires_at,r.principal_id LIMIT ?`,
      this.clock.now(),
      limit,
    );
    this.lastError = null;
    let failed = 0;
    for (const { principal_id } of rows)
      try {
        this.markExpired(principal_id);
        this.clearDatabase(principal_id);
        await this.eraseAudio(principal_id);
      } catch (error) {
        failed++;
        this.lastError ??= error instanceof DomainError ? error.code : 'WEB_RETENTION_FAILED';
      }
    return { processed: rows.length, failed };
  }
  markExpired(principalId: string) {
    this.store.transaction(() => {
      const row = this.guest(principalId),
        now = this.clock.now();
      if (['purging', 'purged'].includes(row.state)) return;
      ensure(row.state === 'active' && row.expires_at !== null && row.expires_at <= now, 'WEB_RETENTION_NOT_EXPIRED');
      this.store.run(
        "UPDATE web_guest_retention SET state='purging',revision=revision+1 WHERE principal_id=?",
        principalId,
      );
      for (const operation of this.store.all<{ id: string; ip_window_id: string | null; metering_type: string }>(
        "SELECT * FROM web_operations WHERE principal_id=? AND world_id=? AND quota_state='reserved'",
        principalId,
        row.world_id,
      )) {
        ensure(
          this.store.run(
            `UPDATE web_operations SET status='failed',quota_state='released',failure_code='TRIAL_EXPIRED',
          stage_version=stage_version+1,lease_epoch=NULL,lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL
          WHERE id=? AND status NOT IN ('published','cancelled','failed') AND quota_state='reserved'`,
            operation.id,
          ).changes === 1,
          'WEB_RETENTION_STALE',
        );
        ensure(operation.metering_type === 'trial' && operation.ip_window_id, 'WEB_RETENTION_SCOPE_UNSAFE');
        ensure(
          this.store.run(
            'UPDATE web_ip_windows SET reserved=reserved-1 WHERE id=? AND reserved>0',
            operation.ip_window_id,
          ).changes === 1,
          'WEB_QUOTA_STATE_INVALID',
        );
        settleWebLifetimeReservation(this.store, operation.ip_window_id, 'released');
        ensure(
          this.store.run(
            'UPDATE web_principals SET trial_reserved=trial_reserved-1,revision=revision+1 WHERE id=? AND trial_reserved>0',
            principalId,
          ).changes === 1,
          'WEB_QUOTA_STATE_INVALID',
        );
      }
      const ledger = new WebProviderOffline(this.store, this.clock);
      for (const attempt of this.store.all<{
        operation_id: string;
        phase: 'draft' | 'review' | 'speech';
        ordinal: number;
        player_id: string;
        conversation_id: string;
        character_id: string;
        input_message_id: string;
        state: string;
      }>(
        "SELECT * FROM web_provider_attempts WHERE principal_id=? AND world_id=? AND state IN ('not_sent','sent')",
        principalId,
        row.world_id,
      )) {
        const key = { operationId: attempt.operation_id, phase: attempt.phase, ordinal: attempt.ordinal };
        const scope = {
          principalId,
          worldId: row.world_id,
          playerId: attempt.player_id,
          conversationId: attempt.conversation_id,
          characterId: attempt.character_id,
          inputMessageId: attempt.input_message_id,
        };
        if (attempt.state === 'not_sent') ledger.releaseUnsent(key, scope);
        else {
          ledger.markUnknown(key, scope);
          this.store.run(
            `UPDATE web_external_attempts SET dispatch_state='unknown'
            WHERE operation_id=? AND phase=? AND ordinal=? AND dispatch_state='sent'`,
            attempt.operation_id,
            attempt.phase,
            attempt.ordinal,
          );
        }
      }
    });
  }
  clearDatabase(principalId: string) {
    this.store.transaction(() => {
      const row = this.guest(principalId),
        world = row.world_id;
      ensure(row.state === 'purging' || row.state === 'purged', 'WEB_RETENTION_NOT_PURGING');
      if (row.db_cleared_at !== null) return;
      ensure(
        row.state === 'purging' &&
          this.store.get<{ foreign_keys: number }>('PRAGMA foreign_keys')?.foreign_keys === 1 &&
          this.store.get<{ policy_json: string }>('SELECT policy_json FROM worlds WHERE id=?', world)?.policy_json ===
            '{}' &&
          !this.store.get('SELECT 1 FROM web_principals WHERE world_id=? AND id<>?', world, principalId) &&
          !this.store.get('SELECT 1 FROM web_retention_purge_gate'),
        'WEB_RETENTION_SCOPE_UNSAFE',
      );
      auditWebLifecycleWorld(this.store, world, 'source', 'provider');
      for (const table of ['web_provider_outputs', 'web_provider_media_assets'])
        ensure(
          !this.store.get(
            `SELECT 1 FROM ${table} m
        JOIN web_operations o ON o.id=m.operation_id WHERE o.world_id=? AND m.audio_ref_json IS NOT NULL AND NOT EXISTS
        (SELECT 1 FROM cf_web_audio_objects c WHERE c.operation_id=m.operation_id AND c.ordinal=m.ordinal
          AND c.principal_id=o.principal_id AND c.world_id=o.world_id AND c.reference_json=m.audio_ref_json) LIMIT 1`,
            world,
          ),
          'WEB_RETENTION_MEDIA_INTENT_REQUIRED',
        );
      this.store.run('INSERT INTO web_retention_purge_gate VALUES (?,?,?)', principalId, world, row.revision);
      const operations = 'SELECT id FROM web_operations WHERE principal_id=? AND world_id=?';
      for (const table of ['web_local_events', 'web_user_events'])
        this.store.run(`DELETE FROM ${table} WHERE principal_id=? AND world_id=?`, principalId, world);
      for (const table of [
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
      ])
        this.store.run(`DELETE FROM ${table} WHERE operation_id IN (${operations})`, principalId, world);
      for (const table of [
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
      ])
        this.store.run(`DELETE FROM ${table} WHERE world_id=?`, world);
      this.store.run('UPDATE jobs SET published_message_id=NULL WHERE world_id=?', world);
      this.store.run('DELETE FROM jobs WHERE world_id=?', world);
      for (const operation of this.store.all<{ id: string; payload_hash: string }>(
        'SELECT id,payload_hash FROM web_operations WHERE principal_id=? AND world_id=?',
        principalId,
        world,
      ))
        this.store.run(
          'UPDATE web_operations SET input_message_id=NULL,payload_hash=? WHERE id=?',
          webReceiptDigest(this.store, 'receipt', `purged-payload\0${operation.payload_hash}`),
          operation.id,
        );
      for (const attempt of this.store.all<{
        operation_id: string;
        stage: string;
        phase: string;
        ordinal: number;
        receipt_json: string | null;
        usage_json: string | null;
      }>(
        `SELECT * FROM web_external_attempts
        WHERE operation_id IN (${operations}) AND dispatch_state='known'`,
        principalId,
        world,
      ))
        this.store.run(
          `UPDATE web_external_attempts SET receipt_json=NULL,usage_json=NULL,receipt_digest=coalesce(receipt_digest,?),usage_digest=coalesce(usage_digest,?)
          WHERE operation_id=? AND stage=? AND phase=? AND ordinal=?`,
          attempt.receipt_json === null ? null : webReceiptDigest(this.store, 'receipt', attempt.receipt_json),
          attempt.usage_json === null ? null : webReceiptDigest(this.store, 'usage', attempt.usage_json),
          attempt.operation_id,
          attempt.stage,
          attempt.phase,
          attempt.ordinal,
        );
      this.store.run('DELETE FROM messages WHERE world_id=?', world);
      this.store.run('UPDATE contacts SET state_json=? WHERE world_id=?', JSON.stringify(emptySession()), world);
      this.store.run("UPDATE world_characters SET relationship='new' WHERE world_id=?", world);
      this.store.run('DELETE FROM web_retention_purge_gate WHERE principal_id=?', principalId);
      auditWebLifecycleWorld(this.store, world, 'cleared', 'provider');
      ensure(!this.store.get('PRAGMA foreign_key_check'), 'WEB_RETENTION_CLEANUP_INCOMPLETE');
      this.store.run(
        'UPDATE web_guest_retention SET db_cleared_at=?,revision=revision+1 WHERE principal_id=?',
        this.clock.now(),
        principalId,
      );
    });
  }
  async eraseAudio(principalId: string) {
    const row = this.guest(principalId);
    ensure(['purging', 'purged'].includes(row.state) && row.db_cleared_at !== null, 'WEB_RETENTION_DB_NOT_CLEARED');
    for (const intent of this.store.all<ObjectIntent>(
      `SELECT * FROM cf_web_audio_objects
      WHERE principal_id=? AND world_id=? AND erased_at IS NULL ORDER BY operation_id,ordinal`,
      principalId,
      row.world_id,
    )) {
      const reference = JSON.parse(intent.reference_json) as MediaObjectReference;
      const authorize = async () => {
        const current = this.guest(principalId);
        ensure(
          ['purging', 'purged'].includes(current.state) &&
            current.db_cleared_at !== null &&
            current.world_id === row.world_id &&
            this.store.get(
              'SELECT 1 FROM cf_web_audio_objects WHERE operation_id=? AND ordinal=? AND principal_id=? AND world_id=? AND reference_json=?',
              intent.operation_id,
              intent.ordinal,
              principalId,
              row.world_id,
              intent.reference_json,
            ),
          'WEB_RETENTION_SCOPE_UNSAFE',
        );
        const a = this.store.get<{
          player_id: string;
          conversation_id: string;
          character_id: string;
          input_message_id: string;
        }>(
          "SELECT * FROM web_provider_attempts WHERE operation_id=? AND phase='speech' AND ordinal=? AND principal_id=? AND world_id=?",
          intent.operation_id,
          intent.ordinal,
          principalId,
          row.world_id,
        );
        ensure(a, 'WEB_RETENTION_SCOPE_UNSAFE');
        checkAudioReference(
          reference,
          speechObjectScope(this.store, intent.operation_id, intent.ordinal, {
            principalId,
            worldId: row.world_id,
            playerId: a.player_id,
            conversationId: a.conversation_id,
            characterId: a.character_id,
            inputMessageId: a.input_message_id,
          }),
        );
      };
      await this.store.providerAudio!.erase(reference, authorize);
      this.store.run(
        'UPDATE cf_web_audio_objects SET erased_at=? WHERE operation_id=? AND ordinal=? AND erased_at IS NULL',
        this.clock.now(),
        intent.operation_id,
        intent.ordinal,
      );
    }
    this.store.transaction(() => {
      this.guest(principalId);
      ensure(
        !this.store.get(
          'SELECT 1 FROM cf_web_audio_objects WHERE principal_id=? AND world_id=? AND erased_at IS NULL',
          principalId,
          row.world_id,
        ),
        'WEB_RETENTION_FILES_PENDING',
      );
      this.store.run(
        "UPDATE web_guest_retention SET state='purged',revision=revision+1 WHERE principal_id=? AND state='purging' AND db_cleared_at IS NOT NULL",
        principalId,
      );
    });
  }
}

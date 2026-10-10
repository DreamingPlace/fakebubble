import { createHmac } from 'node:crypto';
import type { Clock } from '../../../packages/contracts/index.ts';
import { emptySession } from '../../../packages/domain/schedule.ts';
import { ensure } from '../../../packages/domain/errors.ts';
import type { WebStore } from '../platform/store.ts';
import { readLocalConfig } from '../platform/web-local-config.ts';
import { WebPrivateAudioFiles } from '../audio/web-private-audio-files.ts';
import { settleWebLifetimeReservation, webReceiptDigest, type WebRetentionRow } from './web-retention.ts';
import { auditWebLifecycleWorld } from './web-lifecycle-audit.ts';
import { LATE_TABLES, embeddingTableExists, releaseUnsentEmbedHolds } from '../budget/web-embed-purge.ts';
import { purgeCocreation } from '../cocreation/web-cocreation-purge.ts';

type Operation = {
  id: string;
  principal_id: string;
  world_id: string;
  ip_window_id: string | null;
  metering_type: string;
  status: string;
  quota_state: string;
  stage_version: number;
};
type FileRow = {
  media_id: string;
  principal_id: string;
  world_id: string;
  byte_length: number;
  sha256: string;
  duration_ms: number;
  state: string;
};

/** Synthetic-only guest maintenance. Protected invite worlds never enter T1/T2/F. */
export class WebRetentionCleaner {
  private readonly store: WebStore;
  private readonly clock: Clock;
  private readonly files: WebPrivateAudioFiles;
  private readonly requestKey: Buffer;
  constructor(store: WebStore, clock: Clock) {
    ensure(
      [110, 112].includes(store.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? -1),
      'WEB_DATA_MIGRATION_REQUIRED',
    );
    const config = readLocalConfig(store.root);
    ensure(config.instanceId === store.instanceId && config.mode === 'synthetic-local', 'WEB_LOCAL_INSTANCE_MISMATCH');
    this.store = store;
    this.clock = clock;
    this.requestKey = Buffer.from(config.requestKey, 'base64url');
    this.files = new WebPrivateAudioFiles(store.root);
  }

  private now() {
    const now = this.clock.now();
    ensure(Number.isSafeInteger(now) && now >= 0, 'INVALID_TIME');
    return now;
  }

  /** Bounded maintenance pass; failures stay visible and never re-open content access. */
  sweep(limit = 8) {
    ensure(Number.isSafeInteger(limit) && limit >= 1 && limit <= 64, 'WEB_RETENTION_SWEEP_INVALID');
    const now = this.now();
    const principals = this.store.all<{ principal_id: string }>(
      `SELECT r.principal_id
      FROM web_guest_retention r JOIN web_principals p ON p.id=r.principal_id
      WHERE p.kind='guest' AND p.world_id=r.world_id
        AND (r.state='purging' OR r.state='active' AND r.expires_at<=?)
      ORDER BY r.expires_at,r.principal_id LIMIT ?`,
      now,
      limit,
    );
    let firstError: unknown = null;
    for (const { principal_id } of principals) {
      try {
        this.markExpired(principal_id);
        this.clearDatabase(principal_id);
        this.clearFiles(principal_id);
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError) throw firstError;
    return principals.length;
  }

  /** T1 is a short CAS transaction: first deny content, then fence every old operation. */
  markExpired(principalId: string) {
    return this.store.transaction(() => {
      const now = this.now();
      const row = this.store.get<WebRetentionRow>(
        'SELECT * FROM web_guest_retention WHERE principal_id=?',
        principalId,
      );
      const principal = this.store.get<{ world_id: string; kind: string }>(
        'SELECT world_id,kind FROM web_principals WHERE id=?',
        principalId,
      );
      ensure(
        row && principal && principal.kind === 'guest' && row.world_id === principal.world_id,
        'WEB_RETENTION_SCOPE_INVALID',
      );
      if (row.state === 'purging' || row.state === 'purged') return { duplicate: true as const };
      ensure(
        principal.kind === 'guest' && row.state === 'active' && row.expires_at !== null && now >= row.expires_at,
        'WEB_RETENTION_NOT_EXPIRED',
      );
      ensure(
        this.store.run(
          `UPDATE web_guest_retention SET state='purging',revision=revision+1
        WHERE principal_id=? AND world_id=? AND state='active' AND revision=?`,
          principalId,
          row.world_id,
          row.revision,
        ).changes === 1,
        'WEB_RETENTION_STALE',
      );
      const operations = this.store.all<Operation>(
        `SELECT * FROM web_operations
        WHERE principal_id=? AND world_id=? ORDER BY admission_seq`,
        principalId,
        row.world_id,
      );
      for (const operation of operations) {
        if (operation.quota_state === 'reserved') {
          ensure(
            !['published', 'cancelled', 'failed'].includes(operation.status) &&
              this.store.run(
                `UPDATE web_operations SET status='failed',quota_state='released',
              failure_code='TRIAL_EXPIRED',stage_version=stage_version+1,
              lease_epoch=NULL,lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL
              WHERE id=? AND principal_id=? AND world_id=? AND status=? AND stage_version=?
                AND quota_state='reserved'`,
                operation.id,
                principalId,
                row.world_id,
                operation.status,
                operation.stage_version,
              ).changes === 1,
            'WEB_RETENTION_STALE',
          );
          if (operation.metering_type === 'trial') {
            ensure(
              operation.ip_window_id &&
                this.store.run(
                  `UPDATE web_ip_windows
              SET reserved=reserved-1 WHERE id=? AND reserved>0`,
                  operation.ip_window_id,
                ).changes === 1,
              'WEB_QUOTA_STATE_INVALID',
            );
            settleWebLifetimeReservation(this.store, operation.ip_window_id!, 'released');
            ensure(
              this.store.run(
                `UPDATE web_principals SET trial_reserved=trial_reserved-1,
              revision=revision+1 WHERE id=? AND world_id=? AND trial_reserved>0`,
                principalId,
                row.world_id,
              ).changes === 1,
              'WEB_QUOTA_STATE_INVALID',
            );
          }
        }
        for (const attempt of this.store.all<{
          stage: string;
          phase: string;
          ordinal: number;
          provider: string;
          dispatch_state: string;
        }>(
          `SELECT stage,phase,ordinal,provider,dispatch_state
          FROM web_external_attempts WHERE operation_id=? AND dispatch_state IN ('not_sent','sent')`,
          operation.id,
        )) {
          if (attempt.dispatch_state === 'not_sent') {
            ensure(
              this.store.run(
                `UPDATE web_external_attempts
              SET dispatch_state='known',outcome='not_dispatched',settled_at=?
              WHERE operation_id=? AND stage=? AND phase=? AND ordinal=? AND dispatch_state='not_sent'`,
                now,
                operation.id,
                attempt.stage,
                attempt.phase,
                attempt.ordinal,
              ).changes === 1,
              'WEB_DISPATCH_STALE',
            );
            ensure(
              this.store.run(
                `UPDATE web_external_budgets SET reserved=reserved-1
              WHERE provider=? AND stage=? AND phase=? AND reserved>0`,
                attempt.provider,
                attempt.stage,
                attempt.phase,
              ).changes === 1,
              'WEB_EXTERNAL_BUDGET_INVALID',
            );
          } else
            ensure(
              this.store.run(
                `UPDATE web_external_attempts SET dispatch_state='unknown'
            WHERE operation_id=? AND stage=? AND phase=? AND ordinal=? AND dispatch_state='sent'`,
                operation.id,
                attempt.stage,
                attempt.phase,
                attempt.ordinal,
              ).changes === 1,
              'WEB_DISPATCH_STALE',
            );
        }
      }
      for (const asset of this.store.all<{
        media_id: string;
        byte_length: number;
        sha256: string;
        duration_ms: number;
      }>(
        `SELECT media_id,byte_length,sha256,duration_ms FROM web_private_audio_assets
          WHERE principal_id=? AND world_id=?`,
        principalId,
        row.world_id,
      )) {
        ensure(
          !this.store.get('SELECT 1 FROM web_footer_assets WHERE media_id=?', asset.media_id),
          'WEB_PRIVATE_AUDIO_SHARED',
        );
        this.store.run(
          `INSERT INTO web_retention_file_cleanup
          (media_id,principal_id,world_id,byte_length,sha256,duration_ms,state,queued_at)
          VALUES (?,?,?,?,?,?,'pending',?) ON CONFLICT(media_id) DO NOTHING`,
          asset.media_id,
          principalId,
          row.world_id,
          asset.byte_length,
          asset.sha256,
          asset.duration_ms,
          now,
        );
      }
      return { duplicate: false as const };
    });
  }

  /** T2 removes 109 content with FK enforcement and a transaction-local scoped trigger gate. */
  clearDatabase(principalId: string) {
    return this.store.transaction(() => {
      const now = this.now();
      const row = this.store.get<WebRetentionRow & { db_cleared_at: number | null }>(
        'SELECT * FROM web_guest_retention WHERE principal_id=?',
        principalId,
      );
      ensure(row?.state === 'purging', 'WEB_RETENTION_NOT_PURGING');
      ensure(
        this.store.get(
          `SELECT 1 FROM web_principals WHERE id=? AND world_id=? AND kind='guest'`,
          principalId,
          row.world_id,
        ),
        'WEB_RETENTION_SCOPE_UNSAFE',
      );
      if (row.db_cleared_at !== null) return { duplicate: true as const };
      const world = row.world_id;
      ensure(
        this.store.get<{ foreign_keys: number }>('PRAGMA foreign_keys')?.foreign_keys === 1 &&
          this.store.get<{ policy_json: string }>('SELECT policy_json FROM worlds WHERE id=?', world)?.policy_json ===
            '{}' &&
          !this.store.get(`SELECT 1 FROM web_principals WHERE world_id=? AND id<>? LIMIT 1`, world, principalId) &&
          !this.store.get(`SELECT 1 FROM web_accounts WHERE principal_id=? LIMIT 1`, principalId) &&
          !this.store.get(`SELECT 1 FROM web_retention_purge_gate LIMIT 1`),
        'WEB_RETENTION_SCOPE_UNSAFE',
      );
      auditWebLifecycleWorld(this.store, world, 'source');
      // Non-Web rows require an explicit, separately audited cleanup graph.
      for (const table of [
        'proactive_intents',
        'media',
        'moment_threads',
        'group_conversations',
        'speech_tasks',
        'player_profile_versions',
      ]) {
        if (this.store.get(`SELECT 1 FROM ${table} WHERE world_id=? LIMIT 1`, world))
          ensure(false, 'WEB_RETENTION_UNEXPECTED_WORLD_DATA');
      }
      this.store.run('INSERT INTO web_retention_purge_gate VALUES (?,?,?)', principalId, world, row.revision);
      const operationScope = `SELECT id FROM web_operations WHERE principal_id=? AND world_id=?`;
      this.store.run('DELETE FROM web_local_events WHERE principal_id=? AND world_id=?', principalId, world);
      this.store.run('DELETE FROM web_user_events WHERE principal_id=? AND world_id=?', principalId, world);
      for (const table of [
        'web_publication_items',
        'web_publications',
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
        this.store.run(`DELETE FROM ${table} WHERE operation_id IN (${operationScope})`, principalId, world);
      // memory_facts exists from schema 115 and the embedding tables from 116; an older database has nothing there.
      releaseUnsentEmbedHolds(this.store, world);
      // Co-creation ideas (schema 117) are the player's data and go with the player.
      purgeCocreation(this.store, { principalId });
      for (const table of [
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
      ])
        if (!LATE_TABLES.has(table) || embeddingTableExists(this.store, table))
          this.store.run(`DELETE FROM ${table} WHERE world_id=?`, world);
      this.store.run('UPDATE jobs SET published_message_id=NULL WHERE world_id=?', world);
      this.store.run('DELETE FROM jobs WHERE world_id=?', world);
      // Preserve immutable metering/identity IDs, but no longer retain a naked hash of the input.
      for (const operation of this.store.all<{ id: string; payload_hash: string }>(
        'SELECT id,payload_hash FROM web_operations WHERE principal_id=? AND world_id=?',
        principalId,
        world,
      )) {
        const mac = createHmac('sha256', this.requestKey)
          .update('purged-payload\0')
          .update(operation.payload_hash)
          .digest('hex');
        this.store.run('UPDATE web_operations SET input_message_id=NULL,payload_hash=? WHERE id=?', mac, operation.id);
      }
      for (const attempt of this.store.all<{
        operation_id: string;
        stage: string;
        phase: string;
        ordinal: number;
        receipt_json: string | null;
        usage_json: string | null;
      }>(
        `SELECT operation_id,stage,phase,ordinal,receipt_json,usage_json FROM web_external_attempts
          WHERE operation_id IN (${operationScope}) AND dispatch_state='known'`,
        principalId,
        world,
      )) {
        this.store.run(
          `UPDATE web_external_attempts SET receipt_json=NULL,usage_json=NULL,
          receipt_digest=?,usage_digest=? WHERE operation_id=? AND stage=? AND phase=? AND ordinal=?`,
          attempt.receipt_json === null ? null : webReceiptDigest(this.store, 'receipt', attempt.receipt_json),
          attempt.usage_json === null ? null : webReceiptDigest(this.store, 'usage', attempt.usage_json),
          attempt.operation_id,
          attempt.stage,
          attempt.phase,
          attempt.ordinal,
        );
      }
      this.store.run('DELETE FROM messages WHERE world_id=?', world);
      this.store.run('UPDATE contacts SET state_json=? WHERE world_id=?', JSON.stringify(emptySession()), world);
      this.store.run("UPDATE world_characters SET relationship='new' WHERE world_id=?", world);
      ensure(
        !this.store.get('PRAGMA foreign_key_check') &&
          !this.store.get('SELECT 1 FROM messages WHERE world_id=? LIMIT 1', world),
        'WEB_RETENTION_CLEANUP_INCOMPLETE',
      );
      this.store.run('DELETE FROM web_retention_purge_gate WHERE principal_id=?', principalId);
      auditWebLifecycleWorld(this.store, world, 'cleared');
      ensure(
        this.store.run(
          `UPDATE web_guest_retention SET db_cleared_at=?,revision=revision+1
        WHERE principal_id=? AND state='purging' AND revision=?`,
          now,
          principalId,
          row.revision,
        ).changes === 1,
        'WEB_RETENTION_STALE',
      );
      return { duplicate: false as const };
    });
  }

  /** F uses only a committed manifest; missing files after unlink are safe to retry. */
  clearFiles(principalId: string) {
    const row = this.store.get<WebRetentionRow & { db_cleared_at: number | null }>(
      'SELECT * FROM web_guest_retention WHERE principal_id=?',
      principalId,
    );
    ensure(
      row && (row.state === 'purging' || row.state === 'purged') && row.db_cleared_at !== null,
      'WEB_RETENTION_DB_NOT_CLEARED',
    );
    ensure(
      this.store.get(
        `SELECT 1 FROM web_principals WHERE id=? AND world_id=? AND kind='guest'`,
        principalId,
        row.world_id,
      ),
      'WEB_RETENTION_SCOPE_UNSAFE',
    );
    for (const file of this.store.all<FileRow>(
      `SELECT * FROM web_retention_file_cleanup
      WHERE principal_id=? AND world_id=? AND state='pending' ORDER BY media_id`,
      principalId,
      row.world_id,
    )) {
      ensure(
        !this.store.get('SELECT 1 FROM web_footer_assets WHERE media_id=?', file.media_id) &&
          !this.store.get('SELECT 1 FROM web_private_audio_assets WHERE media_id=?', file.media_id),
        'WEB_PRIVATE_AUDIO_SHARED',
      );
      this.files.deletePrivate(file.media_id, {
        byteLength: file.byte_length,
        sha256: file.sha256,
        durationMs: file.duration_ms,
      });
      this.store.transaction(() => {
        ensure(
          this.store.run(
            `UPDATE web_retention_file_cleanup SET state='deleted',deleted_at=?
          WHERE media_id=? AND principal_id=? AND world_id=? AND state='pending'`,
            this.now(),
            file.media_id,
            principalId,
            row.world_id,
          ).changes === 1,
          'WEB_RETENTION_STALE',
        );
      });
    }
    this.store.transaction(() => {
      ensure(
        !this.store.get(
          `SELECT 1 FROM web_retention_file_cleanup
        WHERE principal_id=? AND world_id=? AND state='pending' LIMIT 1`,
          principalId,
          row.world_id,
        ),
        'WEB_RETENTION_FILES_PENDING',
      );
      this.store.run(
        `UPDATE web_guest_retention SET state='purged',revision=revision+1
        WHERE principal_id=? AND world_id=? AND state='purging' AND db_cleared_at IS NOT NULL`,
        principalId,
        row.world_id,
      );
    });
  }
}

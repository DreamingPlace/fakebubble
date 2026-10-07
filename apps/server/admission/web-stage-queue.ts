import { webCharacterPreviewsRunning } from '../characters/web-character-preview-schema.ts';
import { createHash } from 'node:crypto';
import type { Clock } from '../../../packages/contracts/index.ts';
import { ensure } from '../../../packages/domain/errors.ts';
import { WEB_LIMITS } from '../../../config/web-v1.ts';
import { webConcurrency } from '../../../config/web-concurrency.ts';
import type { WebRuntimeStore as WebStore } from '../platform/web-store-contract.ts';
import {
  freezeInputSnapshot,
  readInputSnapshot,
  requireCurrentInputSnapshot,
} from '../generation/web-input-snapshot.ts';
import { requireWebContent, webDataLifecycleEnabled } from './web-retention.ts';
import { freezeWebV7Request } from '../generation/web-v7-request.ts';
import { readWebV7Request } from '../generation/web-v7-request.ts';
import { applyTextReview, parseTextDraft } from '../generation/accepted-text-protocol.ts';
import type { SnapshotScope } from '../generation/web-input-snapshot.ts';
import { audioStartedExpr, metricsEnabled, recordAudioClaim, recordTextClaim } from './web-stage-metrics.ts';
import type { QueryVector } from '../generation/web-embed-runner.ts';

type Stage = 'text' | 'audio';
export interface WebCoordinatorLease {
  epoch: number;
  token: string;
  owner: string;
  expiresAt: number;
}
export interface WebStageClaim {
  operationId: string;
  stage: Stage;
  stageVersion: number;
  epoch: number;
  token: string;
  owner: string;
  principalId: string;
  worldId: string;
  conversationId: string;
  characterId: string;
  inputMessageId: string;
  deadlineAt: number;
  leaseExpiresAt: number;
  ordinal?: number;
  textDigest?: string;
  voiceVersion?: string;
}
interface SchedulerRow {
  epoch: number;
  coordinator_token: string | null;
  coordinator_expires_at: number;
  text_last_principal_id: string | null;
  audio_last_principal_id: string | null;
}
interface OperationRow {
  id: string;
  principal_id: string;
  world_id: string;
  conversation_id: string;
  character_id: string;
  input_message_id: string;
  stage_version: number;
  deadline_at: number;
  text_queued_at?: number;
  audio_wait_used_ms?: number | null;
  audio_wait_started_at?: number | null;
}

export function claimRetention(schema: number, now: number) {
  if (schema !== 110 && schema !== 111 && schema !== 112 && schema < 113) return { sql: '', args: [] as number[] };
  return {
    sql: `AND EXISTS (SELECT 1 FROM web_guest_retention r
      JOIN web_principals p ON p.id=r.principal_id WHERE r.principal_id=o.principal_id
      AND r.world_id=o.world_id AND ((p.kind='account' AND r.state='protected') OR
      (p.kind='guest' AND r.state='active' AND r.expires_at>?)
      ${
        schema >= 111
          ? `OR (p.kind='invite' AND r.state='protected' AND EXISTS
        (SELECT 1 FROM web_invite_grants g WHERE g.principal_id=p.id
          AND g.player_id=p.player_id AND g.world_id=p.world_id AND g.revoked_at IS NULL
          AND (g.expires_at IS NULL OR g.expires_at>?)))`
          : ''
      }))`,
    args: schema >= 111 ? [now, now] : [now],
  };
}

/** Internal durable stage primitives. No provider dispatch or successful publication. */
export class WebStageQueue {
  private readonly store: WebStore;
  private readonly clock: Clock;
  private readonly nextId: () => string;
  /**
   * Query embeddings computed for operations that are not frozen yet, by operation id. In memory only: the vector
   * lives exactly until the request that needs it is frozen, and is never written to the database.
   */
  private readonly queryVectors: Map<string, QueryVector> | undefined;
  constructor(store: WebStore, clock: Clock, nextId: () => string, queryVectors?: Map<string, QueryVector>) {
    this.store = store;
    this.clock = clock;
    this.nextId = nextId;
    this.queryVectors = queryVectors;
  }

  /**
   * Attempts a provider rejected with HTTP 429 and that wait out a backoff still hold their provider slot, so a
   * retry never has to compete for capacity it already counted against.
   */
  private backingOff(stage: Stage) {
    if (!metricsEnabled(this.store)) return 0;
    return this.store.get<{ n: number }>(
      `SELECT count(*) n FROM web_attempt_rejections r JOIN web_provider_attempts a
        ON a.operation_id=r.operation_id AND a.phase=r.phase AND a.ordinal=r.ordinal
      WHERE a.state='not_sent' AND ${stage === 'text' ? "r.phase IN ('draft','review')" : "r.phase='speech'"}`,
    )!.n;
  }

  private now() {
    const now = this.clock.now();
    ensure(Number.isSafeInteger(now) && now >= 0, 'INVALID_TIME');
    return now;
  }

  private scheduler() {
    const schema = this.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? -1;
    ensure(
      [102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112].includes(schema) ||
        (schema >= 113 && webDataLifecycleEnabled(this.store)),
      'WEB_ADMISSION_ORDER_MIGRATION_REQUIRED',
    );
    const row = this.store.get<SchedulerRow>('SELECT * FROM web_scheduler_state WHERE singleton=1');
    ensure(row, 'WEB_SCHEDULER_MISSING');
    return row;
  }

  /** Only an expired/missing coordinator may advance the epoch; ordinary opens never do. */
  acquireCoordinator(owner: string): WebCoordinatorLease {
    ensure(owner.length > 0, 'WEB_COORDINATOR_OWNER_REQUIRED');
    return this.store.transaction(() => {
      const now = this.now(),
        row = this.scheduler();
      ensure(row.coordinator_expires_at <= now, 'WEB_COORDINATOR_BUSY');
      const token = this.nextId(),
        epoch = row.epoch + 1,
        expiresAt = now + WEB_LIMITS.coordinatorLeaseMs;
      ensure(
        this.store.run(
          `UPDATE web_scheduler_state SET epoch=?,coordinator_token=?,coordinator_expires_at=?
        WHERE singleton=1 AND epoch=? AND coordinator_expires_at<=?`,
          epoch,
          token,
          expiresAt,
          row.epoch,
          now,
        ).changes === 1,
        'WEB_COORDINATOR_STALE',
      );
      return { epoch, token, owner, expiresAt };
    });
  }

  renewCoordinator(lease: WebCoordinatorLease): WebCoordinatorLease {
    return this.store.transaction(() => {
      const now = this.now();
      this.validateCoordinator(lease, now);
      const expiresAt = now + WEB_LIMITS.coordinatorLeaseMs;
      ensure(
        this.store.run(
          `UPDATE web_scheduler_state SET coordinator_expires_at=?
        WHERE singleton=1 AND epoch=? AND coordinator_token=? AND coordinator_expires_at>?`,
          expiresAt,
          lease.epoch,
          lease.token,
          now,
        ).changes === 1,
        'WEB_COORDINATOR_STALE',
      );
      return { ...lease, expiresAt };
    });
  }

  releaseCoordinator(lease: WebCoordinatorLease) {
    return this.store.transaction(() => {
      const now = this.now();
      this.validateCoordinator(lease, now);
      ensure(
        this.store.run(
          `UPDATE web_scheduler_state SET coordinator_expires_at=? WHERE singleton=1
        AND epoch=? AND coordinator_token=? AND coordinator_expires_at>?`,
          now,
          lease.epoch,
          lease.token,
          now,
        ).changes === 1,
        'WEB_COORDINATOR_STALE',
      );
    });
  }

  private validateCoordinator(lease: WebCoordinatorLease, now: number) {
    const row = this.scheduler();
    ensure(
      row.epoch === lease.epoch && row.coordinator_token === lease.token && row.coordinator_expires_at > now,
      'WEB_COORDINATOR_STALE',
    );
    return row;
  }

  claimText(coordinator: WebCoordinatorLease, owner: string): WebStageClaim | null {
    const claim = this.claim('text', coordinator, owner);
    // The claim committed: its request is frozen (with or without the vector), so the vector has served its purpose.
    if (claim) this.queryVectors?.delete(claim.operationId);
    return claim;
  }

  /** Reclaims only trusted known output; already sent phases are never resent. */
  resumeKnownText(coordinator: WebCoordinatorLease, operationId: string, owner: string): WebStageClaim {
    const schema = this.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? -1;
    ensure(
      owner.length > 0 &&
        ([109, 110, 111, 112].includes(schema) || (schema >= 113 && webDataLifecycleEnabled(this.store))),
      'WEB_LOCAL_MIGRATION_REQUIRED',
    );
    return this.store.transaction(() => {
      const now = this.now();
      this.validateCoordinator(coordinator, now);
      const op = this.store.get<OperationRow & { lease_epoch: number | null; lease_expires_at: number | null }>(
        `SELECT * FROM web_operations WHERE id=? AND status='text_running' AND quota_state='reserved'
          AND deadline_at>?`,
        operationId,
        now,
      );
      ensure(
        op && (op.lease_epoch !== coordinator.epoch || op.lease_expires_at === null || op.lease_expires_at <= now),
        'WEB_STAGE_STALE',
      );
      requireWebContent(this.store, this.clock, op.principal_id, op.world_id);
      const request = readWebV7Request(this.store, operationId);
      if (schema >= 113) {
        const known = this.store.all<{
          phase: string;
          request_digest: string;
          payload_json: string;
          sha256: string;
          state: string;
          outcome: string;
        }>(
          `SELECT x.phase,x.request_digest,x.payload_json,x.sha256,a.state,a.outcome
            FROM web_provider_outputs x JOIN web_provider_attempts a
              ON a.operation_id=x.operation_id AND a.phase=x.phase AND a.ordinal=x.ordinal
            WHERE x.operation_id=? AND x.phase IN ('draft','review') ORDER BY x.phase`,
          operationId,
        );
        ensure(
          known.length >= 1 &&
            known.length <= 2 &&
            known.some((row) => row.phase === 'draft') &&
            known.every(
              (row) =>
                row.request_digest === request.row.request_digest &&
                row.state === 'known' &&
                row.outcome === 'succeeded' &&
                createHash('sha256').update(row.payload_json).digest('hex') === row.sha256,
            ),
          'WEB_TEXT_OUTPUT_INCOMPLETE',
        );
      } else {
        const known = this.store.all<{
          phase: string;
          request_digest: string;
          output_json: string;
          output_digest: string;
        }>(`SELECT * FROM web_local_text_outputs WHERE operation_id=? ORDER BY phase`, operationId);
        ensure(
          known.length >= 1 &&
            known.length <= 2 &&
            known.some((row) => row.phase === 'draft') &&
            known.every(
              (row) =>
                row.request_digest === request.row.request_digest &&
                createHash('sha256').update(row.output_json).digest('hex') === row.output_digest,
            ),
          'WEB_TEXT_OUTPUT_INCOMPLETE',
        );
      }
      ensure(
        !this.store.get(
          `SELECT 1 FROM web_external_attempts WHERE operation_id=? AND
        (dispatch_state!='known' OR outcome!='succeeded')`,
          operationId,
        ),
        'WEB_DISPATCH_IN_FLIGHT',
      );
      ensure(
        !this.store.get(
          schema >= 113
            ? `SELECT 1 FROM web_external_attempts a
        LEFT JOIN web_provider_outputs x ON x.operation_id=a.operation_id AND x.phase=a.phase
        WHERE a.operation_id=? AND a.stage='text' AND a.dispatch_state='known'
          AND a.outcome='succeeded' AND x.operation_id IS NULL`
            : `SELECT 1 FROM web_external_attempts a
        LEFT JOIN web_local_text_outputs x ON x.operation_id=a.operation_id AND x.phase=a.phase
        WHERE a.operation_id=? AND a.stage='text' AND a.dispatch_state='known'
          AND a.outcome='succeeded' AND x.operation_id IS NULL`,
          operationId,
        ),
        'WEB_TEXT_OUTPUT_INCOMPLETE',
      );
      const token = this.nextId(),
        until = Math.min(now + WEB_LIMITS.textLeaseMs, op.deadline_at);
      ensure(
        this.store.run(
          `UPDATE web_operations SET stage_version=stage_version+1,lease_epoch=?,
        lease_token=?,lease_owner=?,lease_expires_at=? WHERE id=? AND status='text_running'
        AND stage_version=? AND quota_state='reserved' AND deadline_at>?`,
          coordinator.epoch,
          token,
          owner,
          until,
          operationId,
          op.stage_version,
          now,
        ).changes === 1,
        'WEB_STAGE_STALE',
      );
      return {
        operationId,
        stage: 'text',
        stageVersion: op.stage_version + 1,
        epoch: coordinator.epoch,
        token,
        owner,
        principalId: op.principal_id,
        worldId: op.world_id,
        conversationId: op.conversation_id,
        characterId: op.character_id,
        inputMessageId: op.input_message_id,
        deadlineAt: op.deadline_at,
        leaseExpiresAt: until,
      };
    });
  }

  claimAudio(coordinator: WebCoordinatorLease, owner: string): WebStageClaim | null {
    if (
      [105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116].includes(
        this.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? -1,
      )
    )
      return this.claimSyntheticAudio(coordinator, owner);
    return this.claim('audio', coordinator, owner);
  }

  private claimSyntheticAudio(coordinator: WebCoordinatorLease, owner: string): WebStageClaim | null {
    ensure(owner.length > 0, 'WEB_STAGE_OWNER_REQUIRED');
    return this.store.transaction(() => {
      const now = this.now(),
        scheduler = this.validateCoordinator(coordinator, now);
      const schema = this.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? -1;
      ensure(
        [105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116].includes(schema) &&
          (schema < 113 || webDataLifecycleEnabled(this.store)),
        'WEB_SYNTHETIC_VOICE_MIGRATION_REQUIRED',
      );
      const table = schema >= 113 ? 'web_provider_voice_segments' : 'web_synthetic_voice_segments';
      const retention = claimRetention(schema, now);
      if (
        this.store.get<{ n: number }>("SELECT count(*) n FROM web_operations WHERE status='audio_running'")!.n +
          this.backingOff('audio') >=
        webConcurrency(this.store).maxAudioRunning
      )
        return null;
      const operation = this.store.get<OperationRow & { ordinal: number; text_digest: string; voice_version: string }>(
        `SELECT o.*,s.ordinal,s.text_digest,s.voice_version FROM web_operations o
          JOIN ${table} s ON s.operation_id=o.id AND s.state='pending'
            AND s.ordinal=(SELECT min(other.ordinal) FROM ${table} other
              WHERE other.operation_id=o.id AND other.state='pending')
          WHERE o.status IN ('text_ready','audio_pending') AND o.quota_state='reserved'
            AND o.audio_wait_started_at IS NOT NULL AND o.audio_wait_used_ms IS NOT NULL
            AND o.audio_wait_started_at<=?
            AND (o.audio_wait_used_ms+?-o.audio_wait_started_at<? OR ${audioStartedExpr(this.store, 'o')})
            AND o.deadline_at>?
            ${retention.sql}
            ${
              metricsEnabled(this.store)
                ? 'AND NOT EXISTS (SELECT 1 FROM web_operation_metrics f WHERE f.operation_id=o.id AND f.fallback_reason IS NOT NULL)'
                : ''
            }
            AND (SELECT count(*) FROM web_operations other WHERE other.principal_id=o.principal_id
              AND other.id<>o.id AND other.status IN
              ('text_running','text_ready','audio_pending','audio_running','ready_to_publish','retryable_failed','unknown'))<?
            AND (SELECT count(*) FROM web_operations other WHERE other.conversation_id=o.conversation_id
              AND other.id<>o.id AND other.status IN
              ('text_running','text_ready','audio_pending','audio_running','ready_to_publish','retryable_failed','unknown'))<?
          ORDER BY CASE WHEN o.principal_id>? THEN 0 ELSE 1 END,o.principal_id,o.admission_seq LIMIT 1`,
        now,
        now,
        WEB_LIMITS.queueWaitMs,
        now,
        ...retention.args,
        WEB_LIMITS.maxPrincipalActive,
        WEB_LIMITS.maxConversationActive,
        scheduler.audio_last_principal_id ?? '',
      );
      if (!operation) return null;
      requireWebContent(this.store, this.clock, operation.principal_id, operation.world_id);
      const token = this.nextId(),
        leaseExpiresAt = Math.min(now + WEB_LIMITS.audioLeaseMs, operation.deadline_at);
      const version = operation.stage_version + 1;
      ensure(
        this.store.run(
          `UPDATE web_operations SET status='audio_running',stage_version=stage_version+1,
        lease_epoch=?,lease_token=?,lease_owner=?,lease_expires_at=?,
        audio_wait_used_ms=audio_wait_used_ms+?-audio_wait_started_at,audio_wait_started_at=NULL
        WHERE id=? AND stage_version=? AND status IN ('text_ready','audio_pending')
          AND quota_state='reserved' AND audio_wait_started_at IS NOT NULL AND deadline_at>?`,
          coordinator.epoch,
          token,
          owner,
          leaseExpiresAt,
          now,
          operation.id,
          operation.stage_version,
          now,
        ).changes === 1,
        'WEB_STAGE_STALE',
      );
      ensure(
        this.store.run(
          `UPDATE ${table} SET state='running',claim_stage_version=?,
        claim_epoch=?,claim_token=? WHERE operation_id=? AND ordinal=? AND state='pending'`,
          version,
          coordinator.epoch,
          token,
          operation.id,
          operation.ordinal,
        ).changes === 1,
        'WEB_VOICE_SEGMENT_STALE',
      );
      this.store.run(
        `UPDATE web_scheduler_state SET audio_last_principal_id=? WHERE singleton=1 AND epoch=?`,
        operation.principal_id,
        coordinator.epoch,
      );
      recordAudioClaim(
        this.store,
        operation.id,
        now,
        (operation.audio_wait_used_ms ?? 0) + now - (operation.audio_wait_started_at ?? now),
      );
      return {
        operationId: operation.id,
        stage: 'audio',
        stageVersion: version,
        epoch: coordinator.epoch,
        token,
        owner,
        principalId: operation.principal_id,
        worldId: operation.world_id,
        conversationId: operation.conversation_id,
        characterId: operation.character_id,
        inputMessageId: operation.input_message_id,
        deadlineAt: operation.deadline_at,
        leaseExpiresAt,
        ordinal: operation.ordinal,
        textDigest: operation.text_digest,
        voiceVersion: operation.voice_version,
      };
    });
  }

  private claim(stage: Stage, coordinator: WebCoordinatorLease, owner: string): WebStageClaim | null {
    ensure(owner.length > 0, 'WEB_STAGE_OWNER_REQUIRED');
    return this.store.transaction(() => {
      const now = this.now(),
        scheduler = this.validateCoordinator(coordinator, now);
      const running = stage === 'text' ? 'text_running' : 'audio_running';
      const limit =
        stage === 'text' ? webConcurrency(this.store).maxTextRunning : webConcurrency(this.store).maxAudioRunning;
      const count = this.store.get<{ n: number }>('SELECT count(*) n FROM web_operations WHERE status=?', running)!.n;
      if (count + (stage === 'text' ? webCharacterPreviewsRunning(this.store) : 0) + this.backingOff(stage) >= limit)
        return null;
      const cursor = stage === 'text' ? scheduler.text_last_principal_id : scheduler.audio_last_principal_id;
      const schema = this.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? -1;
      const statuses = stage === 'text' ? "o.status='queued'" : "o.status IN ('text_ready','audio_pending')";
      const queuedAt = stage === 'text' ? 'o.text_queued_at' : 'o.audio_queued_at';
      // An operation whose query embedding is in flight is not claimed yet: the request is frozen with the final recall
      // result. The embedding has its own short timeout, after which it is no longer in flight.
      const embedGate =
        schema >= 116
          ? `AND NOT EXISTS (SELECT 1 FROM web_embed_attempts q WHERE q.operation_id=o.id AND q.kind='query'
        AND q.state IN ('not_sent','sent'))`
          : '';
      const candidate =
        stage === 'text' ? embedGate : 'AND EXISTS (SELECT 1 FROM web_reviewed_candidates c WHERE c.operation_id=o.id)';
      const retention = claimRetention(schema, now);
      // A principal's earlier operation waiting out a provider 429 backoff keeps its place: later ones do not jump it.
      const backoffGuard = `AND NOT EXISTS (SELECT 1 FROM web_operations earlier WHERE earlier.principal_id=o.principal_id
        AND earlier.admission_seq<o.admission_seq AND earlier.status='queued' AND earlier.text_queued_at>?)`;
      const operation = this.store.get<OperationRow>(
        `SELECT o.* FROM web_operations o WHERE ${statuses}
        AND o.quota_state='reserved' AND ${queuedAt} IS NOT NULL
        AND ${queuedAt}<=? AND ?<min(${queuedAt}+?,o.deadline_at)
        ${candidate} ${retention.sql} ${stage === 'text' ? backoffGuard : ''}
        AND (SELECT count(*) FROM web_operations other WHERE other.principal_id=o.principal_id
          AND other.id<>o.id AND other.status IN
          ('text_running','text_ready','audio_pending','audio_running','ready_to_publish','retryable_failed','unknown'))<?
        AND (SELECT count(*) FROM web_operations other WHERE other.conversation_id=o.conversation_id
          AND other.id<>o.id AND other.status IN
          ('text_running','text_ready','audio_pending','audio_running','ready_to_publish','retryable_failed','unknown'))<?
        ORDER BY CASE WHEN o.principal_id>? THEN 0 ELSE 1 END,o.principal_id,o.admission_seq LIMIT 1`,
        now,
        now,
        WEB_LIMITS.queueWaitMs,
        ...retention.args,
        ...(stage === 'text' ? [now] : []),
        WEB_LIMITS.maxPrincipalActive,
        WEB_LIMITS.maxConversationActive,
        cursor ?? '',
      );
      if (!operation) return null;
      requireWebContent(this.store, this.clock, operation.principal_id, operation.world_id);
      // A stage returned after an HTTP 429 is claimed again against the same frozen input and request.
      if (
        stage === 'text' &&
        schema >= 106 &&
        !this.store.get('SELECT 1 FROM web_input_snapshots WHERE operation_id=?', operation.id)
      )
        freezeInputSnapshot(this.store, operation.id, now);
      if (
        stage === 'text' &&
        schema >= 108 &&
        !this.store.get('SELECT 1 FROM web_v7_requests WHERE operation_id=?', operation.id)
      )
        freezeWebV7Request(this.store, operation.id, now, this.queryVectors?.get(operation.id));
      const token = this.nextId(),
        leaseExpiresAt = Math.min(
          now + (stage === 'text' ? WEB_LIMITS.textLeaseMs : WEB_LIMITS.audioLeaseMs),
          operation.deadline_at,
        );
      ensure(
        this.store.run(
          `UPDATE web_operations SET status=?,stage_version=stage_version+1,
        lease_epoch=?,lease_token=?,lease_owner=?,lease_expires_at=?
        WHERE id=? AND stage_version=? AND deadline_at>? AND status ${stage === 'text' ? "='queued'" : "IN ('text_ready','audio_pending')"}`,
          running,
          coordinator.epoch,
          token,
          owner,
          leaseExpiresAt,
          operation.id,
          operation.stage_version,
          now,
        ).changes === 1,
        'WEB_STAGE_STALE',
      );
      const cursorColumn = stage === 'text' ? 'text_last_principal_id' : 'audio_last_principal_id';
      this.store.run(
        `UPDATE web_scheduler_state SET ${cursorColumn}=? WHERE singleton=1 AND epoch=?`,
        operation.principal_id,
        coordinator.epoch,
      );
      if (stage === 'text') recordTextClaim(this.store, operation.id, operation.text_queued_at ?? now, now);
      return {
        operationId: operation.id,
        stage,
        stageVersion: operation.stage_version + 1,
        epoch: coordinator.epoch,
        token,
        owner,
        principalId: operation.principal_id,
        worldId: operation.world_id,
        conversationId: operation.conversation_id,
        characterId: operation.character_id,
        inputMessageId: operation.input_message_id,
        deadlineAt: operation.deadline_at,
        leaseExpiresAt,
      };
    });
  }

  /** Scoped read of committed source material; does not grant a stage lease. */
  inputSnapshot(scope: SnapshotScope) {
    ensure(
      (this.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? -1) >= 106,
      'WEB_INPUT_SNAPSHOT_MIGRATION_REQUIRED',
    );
    return readInputSnapshot(this.store, scope);
  }

  /** Fake-provider draft and independent audit must pass the accepted v7 protocol before release. */
  completeReviewedText(claim: WebStageClaim, input: { draft: unknown; review: unknown }) {
    ensure(claim.stage === 'text', 'WEB_STAGE_STALE');
    ensure(
      [108, 109, 110, 111, 112].includes(
        this.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? -1,
      ),
      'WEB_FULL_REVIEW_MIGRATION_REQUIRED',
    );
    const frozen = readWebV7Request(this.store, claim.operationId);
    const candidate = applyTextReview(input.review, parseTextDraft(input.draft, frozen.request), frozen.request);
    const serialized = JSON.stringify(candidate),
      candidateDigest = createHash('sha256').update(serialized).digest('hex');
    const outputDigests = {
      draft: createHash('sha256').update(JSON.stringify(input.draft)).digest('hex'),
      review: createHash('sha256').update(JSON.stringify(input.review)).digest('hex'),
    };
    return this.store.transaction(() => {
      const now = this.now(),
        scheduler = this.scheduler();
      requireWebContent(this.store, this.clock, claim.principalId, claim.worldId);
      ensure(scheduler.epoch === claim.epoch && scheduler.coordinator_expires_at > now, 'WEB_COORDINATOR_STALE');
      const snapshot = requireCurrentInputSnapshot(this.store, {
        operation_id: claim.operationId,
        principal_id: claim.principalId,
        world_id: claim.worldId,
        conversation_id: claim.conversationId,
        character_id: claim.characterId,
        input_message_id: claim.inputMessageId,
      });
      const current = readWebV7Request(this.store, claim.operationId);
      ensure(
        current.row.request_digest === frozen.row.request_digest &&
          current.row.player_id === snapshot.player_id &&
          current.row.principal_id === claim.principalId,
        'WEB_V7_REQUEST_STALE',
      );
      const attempts = this.store.all<{
        phase: string;
        dispatch_state: string;
        outcome: string;
        receipt_json: string;
        usage_json: string;
      }>(
        `SELECT phase,dispatch_state,outcome,receipt_json,usage_json
          FROM web_external_attempts WHERE operation_id=? AND stage='text'`,
        claim.operationId,
      );
      ensure(
        attempts.length === 2 &&
          ['draft', 'review'].every((phase) =>
            attempts.some(
              (a) =>
                a.phase === phase &&
                a.dispatch_state === 'known' &&
                a.outcome === 'succeeded' &&
                a.receipt_json !== null &&
                a.usage_json !== null,
            ),
          ),
        'WEB_TEXT_RECEIPTS_INCOMPLETE',
      );
      for (const phase of ['draft', 'review'] as const) {
        let receipt: unknown;
        try {
          receipt = JSON.parse(attempts.find((a) => a.phase === phase)!.receipt_json);
        } catch {
          receipt = null;
        }
        ensure(
          receipt !== null &&
            typeof receipt === 'object' &&
            !Array.isArray(receipt) &&
            (receipt as Record<string, unknown>).origin === 'synthetic_test' &&
            (receipt as Record<string, unknown>).outputDigest === outputDigests[phase],
          'WEB_TEXT_RECEIPT_OUTPUT_MISMATCH',
        );
      }
      ensure(
        this.store.run(
          `UPDATE web_operations SET status='text_ready',stage_version=stage_version+1,
        audio_queued_at=?,audio_wait_used_ms=0,audio_wait_started_at=?,
        lease_epoch=NULL,lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL
        WHERE id=? AND status='text_running' AND stage_version=? AND lease_epoch=? AND lease_token=?
          AND lease_owner=? AND lease_expires_at>? AND deadline_at>? AND principal_id=? AND world_id=?
          AND conversation_id=? AND character_id=? AND input_message_id=?`,
          now,
          now,
          claim.operationId,
          claim.stageVersion,
          claim.epoch,
          claim.token,
          claim.owner,
          now,
          now,
          claim.principalId,
          claim.worldId,
          claim.conversationId,
          claim.characterId,
          claim.inputMessageId,
        ).changes === 1,
        'WEB_STAGE_STALE',
      );
      this.store.run(
        `INSERT INTO web_v7_candidates VALUES (?,?,?,?,?,?,?,?)`,
        claim.operationId,
        current.row.request_digest,
        serialized,
        candidateDigest,
        attempts.find((a) => a.phase === 'draft')!.receipt_json,
        attempts.find((a) => a.phase === 'review')!.receipt_json,
        'synthetic_test',
        now,
      );
      this.store.run(
        `INSERT INTO web_reviewed_candidates(operation_id,input_message_id,narrative_json,
        input_version,character_version,template_version,voice_version,access_revision,
        text_usage_json,reviewed_at,asset_eligible) VALUES (?,?,?,?,?,?,?,?,?,?,1)`,
        claim.operationId,
        claim.inputMessageId,
        JSON.stringify(candidate.bubbles.map((b) => b.text)),
        snapshot.input_digest,
        String(snapshot.template_version),
        snapshot.template_digest,
        current.row.voice_version,
        snapshot.access_revision,
        JSON.stringify(Object.fromEntries(attempts.map((a) => [a.phase, JSON.parse(a.usage_json)]))),
        now,
      );
      for (const [ordinal, bubble] of candidate.bubbles.entries())
        this.store.run(
          `INSERT INTO
        web_synthetic_voice_segments(operation_id,ordinal,text_digest,voice_version,state,asset_eligible)
        VALUES (?,?,?,?,'pending',1)`,
          claim.operationId,
          ordinal,
          createHash('sha256').update(bubble.text).digest('hex'),
          current.row.voice_version,
        );
      return {
        operationId: claim.operationId,
        candidateDigest,
        status: 'text_ready' as const,
        stageVersion: claim.stageVersion + 1,
      };
    });
  }

  /** A reviewed synthetic candidate releases the text slot, but remains private and unpublished. */
  completeText(
    claim: WebStageClaim,
    candidate: {
      narrative: string[];
      inputVersion: string;
      characterVersion: string;
      templateVersion: string;
      voiceVersion: string;
      accessRevision: number;
      usage: unknown;
    },
  ) {
    ensure(
      claim.stage === 'text' &&
        candidate.narrative.length > 0 &&
        candidate.narrative.every((text) => typeof text === 'string' && text.length > 0) &&
        [candidate.inputVersion, candidate.characterVersion, candidate.templateVersion, candidate.voiceVersion].every(
          Boolean,
        ) &&
        Number.isSafeInteger(candidate.accessRevision) &&
        candidate.accessRevision > 0 &&
        candidate.usage !== undefined,
      'WEB_CANDIDATE_INVALID',
    );
    return this.store.transaction(() => {
      const now = this.now(),
        scheduler = this.scheduler();
      ensure(scheduler.epoch === claim.epoch, 'WEB_STAGE_STALE');
      const schema = this.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version;
      ensure(schema !== undefined && schema < 108, 'WEB_FULL_REVIEW_REQUIRED');
      if (schema === 104 || schema === 105 || schema === 106 || schema === 107) {
        ensure(scheduler.coordinator_expires_at > now, 'WEB_COORDINATOR_STALE');
        ensure(
          !this.store.get(
            `SELECT 1 FROM web_external_attempts
          WHERE operation_id=? AND (dispatch_state!='known' OR outcome!='succeeded') LIMIT 1`,
            claim.operationId,
          ),
          'WEB_DISPATCH_UNSETTLED',
        );
      }
      if (schema === 106 || schema === 107) {
        const snapshot = requireCurrentInputSnapshot(this.store, {
          operation_id: claim.operationId,
          principal_id: claim.principalId,
          world_id: claim.worldId,
          conversation_id: claim.conversationId,
          character_id: claim.characterId,
          input_message_id: claim.inputMessageId,
        });
        ensure(
          candidate.inputVersion === snapshot.input_digest &&
            candidate.characterVersion === String(snapshot.template_version) &&
            candidate.templateVersion === snapshot.template_digest &&
            candidate.accessRevision === snapshot.access_revision,
          'WEB_CANDIDATE_SNAPSHOT_MISMATCH',
        );
      }
      ensure(
        this.store.run(
          `UPDATE web_operations SET status='text_ready',stage_version=stage_version+1,
        audio_queued_at=?,lease_epoch=NULL,lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL
        WHERE id=? AND status='text_running' AND stage_version=? AND lease_epoch=? AND lease_token=? AND lease_owner=?
        AND lease_expires_at>? AND deadline_at>? AND principal_id=? AND world_id=? AND conversation_id=?
        AND character_id=? AND input_message_id=?`,
          now,
          claim.operationId,
          claim.stageVersion,
          claim.epoch,
          claim.token,
          claim.owner,
          now,
          now,
          claim.principalId,
          claim.worldId,
          claim.conversationId,
          claim.characterId,
          claim.inputMessageId,
        ).changes === 1,
        'WEB_STAGE_STALE',
      );
      this.store.run(
        `INSERT INTO web_reviewed_candidates(operation_id,input_message_id,narrative_json,input_version,
        character_version,template_version,voice_version,access_revision,text_usage_json,reviewed_at${schema === 107 ? ',asset_eligible' : ''})
        VALUES (?,?,?,?,?,?,?,?,?,?${schema === 107 ? ',1' : ''})`,
        claim.operationId,
        claim.inputMessageId,
        JSON.stringify(candidate.narrative),
        candidate.inputVersion,
        candidate.characterVersion,
        candidate.templateVersion,
        candidate.voiceVersion,
        candidate.accessRevision,
        JSON.stringify(candidate.usage),
        now,
      );
      if (schema === 105 || schema === 106 || schema === 107) {
        this.store.run(
          `UPDATE web_operations SET audio_wait_used_ms=0,audio_wait_started_at=? WHERE id=?`,
          now,
          claim.operationId,
        );
        for (const [ordinal, body] of candidate.narrative.entries())
          this.store.run(
            `INSERT INTO
          web_synthetic_voice_segments(operation_id,ordinal,text_digest,voice_version,state${schema === 107 ? ',asset_eligible' : ''})
          VALUES (?,?,?,?,'pending'${schema === 107 ? ',1' : ''})`,
            claim.operationId,
            ordinal,
            createHash('sha256').update(body).digest('hex'),
            candidate.voiceVersion,
          );
      }
      return { operationId: claim.operationId, status: 'text_ready' as const, stageVersion: claim.stageVersion + 1 };
    });
  }
}

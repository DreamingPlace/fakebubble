import { createHash, randomUUID } from 'node:crypto';
import type { Clock } from '../../packages/contracts/index.ts';
import { DomainError } from '../../packages/domain/errors.ts';
import { WEB_LIMITS } from '../../config/web-v1.ts';
import type { WebStore } from './store.ts';
import { WebStageQueue, type WebCoordinatorLease, type WebStageClaim } from './web-stage-queue.ts';
import { WebDispatchLedger } from './web-dispatch-ledger.ts';
import { WebSyntheticPrivateAudio } from './web-private-audio.ts';
import { WebVerticalPublisher } from './web-vertical-publisher.ts';
import { readWebV7Request } from './web-v7-request.ts';
import { readKnownAudioOutput, readKnownTextOutput } from './web-local-output.ts';
import { syntheticText, syntheticTone } from './web-local-fake.ts';
import { requireWebContent, webDataLifecycleEnabled } from './web-retention.ts';
import { WebRetentionCleaner } from './web-retention-cleaner.ts';

const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

/** A single-instance, deliberately synthetic business client. It never owns a second Store. */
export class WebLocalExecutor {
  private readonly store: WebStore;
  private readonly clock: Clock;
  private readonly queue: WebStageQueue;
  private readonly ledger: WebDispatchLedger;
  private readonly audio: WebSyntheticPrivateAudio;
  private readonly publisher: WebVerticalPublisher;
  private readonly retention: WebRetentionCleaner | null;
  private coordinator: WebCoordinatorLease | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly tasks = new Set<Promise<void>>();
  private readonly textDelayMs: number;
  private readonly audioDelayMs: number;
  private readonly afterSpeechConfirm: (() => void) | undefined;
  private readonly afterSpeechSent: (() => void) | undefined;
  private stopped = true;
  lastError: string | null = null;

  /** Optional hooks are for synthetic-only process fault tests; no real supplier is wired here. */
  constructor(
    store: WebStore,
    clock: Clock,
    options: {
      textDelayMs?: number;
      audioDelayMs?: number;
      afterSpeechSent?: () => void;
      afterSpeechConfirm?: () => void;
    } = {},
  ) {
    this.store = store;
    this.clock = clock;
    this.textDelayMs = options.textDelayMs ?? 0;
    this.audioDelayMs = options.audioDelayMs ?? 0;
    this.afterSpeechConfirm = options.afterSpeechConfirm;
    this.afterSpeechSent = options.afterSpeechSent;
    if (
      ![this.textDelayMs, this.audioDelayMs].every(
        (value) => Number.isSafeInteger(value) && value >= 0 && value <= 120_000,
      )
    )
      throw new DomainError('WEB_SYNTHETIC_DELAY_INVALID');
    this.queue = new WebStageQueue(store, clock, randomUUID);
    this.ledger = new WebDispatchLedger(store, clock);
    this.audio = new WebSyntheticPrivateAudio(store, clock);
    this.publisher = new WebVerticalPublisher(store, clock);
    this.retention = webDataLifecycleEnabled(store) ? new WebRetentionCleaner(store, clock) : null;
  }

  start() {
    if (this.coordinator) throw new DomainError('WEB_COORDINATOR_BUSY');
    this.coordinator = this.queue.acquireCoordinator(`local-${process.pid}`);
    this.stopped = false;
    try {
      for (const phase of ['draft', 'review'] as const) this.ensureBudget('text', phase);
      this.ensureBudget('audio', 'speech');
      for (const row of this.store.all<{ id: string }>('SELECT id FROM character_templates'))
        this.publisher.registerSyntheticFooter(row.id, syntheticTone());
      this.pump();
      this.timer = setInterval(() => {
        try {
          this.pump();
        } catch (error) {
          this.lastError = error instanceof DomainError ? error.code : 'INTERNAL_ERROR';
        }
      }, 25);
      this.timer.unref();
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.coordinator) {
      try {
        this.queue.releaseCoordinator(this.coordinator);
      } catch {
        /* A stale owner cannot release a successor's lease. */
      }
    }
    this.coordinator = null;
  }

  cancel(operationId: string, principalId: string) {
    if (!this.coordinator) throw new DomainError('WEB_COORDINATOR_STALE');
    if (this.coordinator.expiresAt - this.clock.now() < WEB_LIMITS.coordinatorLeaseMs / 2)
      this.coordinator = this.queue.renewCoordinator(this.coordinator);
    const fence = this.ledger.fence(operationId);
    if (fence.principalId !== principalId) throw new DomainError('WEB_OPERATION_NOT_FOUND');
    return this.ledger.terminate(this.coordinator, fence, principalId, 'cancelled', 'cancel');
  }

  private schedule(task: Promise<void>) {
    this.tasks.add(task);
    void task
      .catch((error) => {
        this.lastError = error instanceof DomainError ? error.code : 'INTERNAL_ERROR';
      })
      .finally(() => this.tasks.delete(task));
  }

  private async pause(ms: number) {
    if (ms > 0) await new Promise((resolveWait) => setTimeout(resolveWait, ms));
  }

  private ensureBudget(stage: 'text' | 'audio', phase: 'draft' | 'review' | 'speech') {
    if (
      this.store.get(
        'SELECT 1 FROM web_external_budgets WHERE provider=? AND stage=? AND phase=?',
        'synthetic-local',
        stage,
        phase,
      )
    )
      return;
    this.ledger.configureBudget({
      provider: 'synthetic-local',
      stage,
      phase,
      capacity: stage === 'text' ? WEB_LIMITS.maxTextRunning : WEB_LIMITS.maxAudioRunning,
    });
  }

  private failInvalid(operationId: string, error: unknown) {
    const code = error instanceof DomainError ? error.code : '';
    const reason = code.startsWith('SCENE_')
      ? 'SCENE_INVALIDATED'
      : code.startsWith('WEB_INPUT_')
        ? 'INPUT_INVALIDATED'
        : code === 'WEB_PUBLICATION_ENTITLEMENT_CHANGED' ||
            code === 'WEB_OPERATION_AUTH_REVOKED' ||
            code === 'WEB_INVITE_ACCESS_REQUIRED'
          ? 'AUTH_REVOKED'
          : null;
    if (!reason || !this.coordinator) throw error;
    const fence = this.ledger.fence(operationId);
    this.ledger.terminate(this.coordinator, fence, fence.principalId, 'failed', 'system_invalid', reason);
  }

  private failLocalAudio(operationId: string, error: unknown): boolean {
    if (
      !(error instanceof DomainError) ||
      !['WEB_PRIVATE_AUDIO_INTEGRITY', 'WEB_PRIVATE_AUDIO_UNAVAILABLE', 'WEB_PRIVATE_AUDIO_INTENT_CONFLICT'].includes(
        error.code,
      )
    )
      return false;
    if (!this.coordinator) throw error;
    const fence = this.ledger.fence(operationId);
    this.ledger.terminate(this.coordinator, fence, fence.principalId, 'failed', 'system_invalid', 'INTERNAL_FAILURE');
    return true;
  }

  private entitlement(operationId: string) {
    const operation = this.store.get<{
      metering_type: string;
      principal_id: string;
      player_id: string;
      world_id: string;
      kind: string;
    }>(
      `SELECT o.metering_type,o.principal_id,p.player_id,o.world_id,p.kind
        FROM web_operations o JOIN web_principals p ON p.id=o.principal_id AND p.world_id=o.world_id
        WHERE o.id=?`,
      operationId,
    );
    if (!operation) throw new DomainError('WEB_OPERATION_NOT_FOUND');
    requireWebContent(this.store, this.clock, operation.principal_id, operation.world_id);
    if (operation.metering_type === 'entitled') {
      if (
        operation.kind === 'invite' &&
        this.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version === 112
      ) {
        if (
          !this.store.get(
            `SELECT 1 FROM web_invite_grants WHERE principal_id=? AND player_id=?
          AND world_id=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)`,
            operation.principal_id,
            operation.player_id,
            operation.world_id,
            this.clock.now(),
          )
        )
          throw new DomainError('WEB_OPERATION_AUTH_REVOKED');
      } else if (
        !this.store.get(
          `SELECT 1 FROM web_accounts
        WHERE principal_id=? AND active=1`,
          operation.principal_id,
        )
      )
        throw new DomainError('WEB_OPERATION_AUTH_REVOKED');
    }
  }

  private async text(claim: WebStageClaim) {
    let synthetic: ReturnType<typeof syntheticText> | undefined;
    try {
      this.entitlement(claim.operationId);
      const { request } = readWebV7Request(this.store, claim.operationId);
      for (const phase of ['draft', 'review'] as const) {
        if (
          this.store.get(
            'SELECT 1 FROM web_local_text_outputs WHERE operation_id=? AND phase=?',
            claim.operationId,
            phase,
          )
        )
          continue;
        synthetic ??= syntheticText(request);
        const output = synthetic[phase],
          key = this.ledger.reserve(claim, {
            phase,
            ordinal: -1,
            provider: 'synthetic-local',
            providerRequestId: `${claim.operationId}:${phase}`,
          });
        this.ledger.markSent(claim, key);
        if (this.textDelayMs > 0) await this.pause(this.textDelayMs);
        if (this.stopped) return; // A sent attempt remains UNKNOWN after a stopped owner.
        this.entitlement(claim.operationId);
        this.ledger.confirm(key, {
          outcome: 'succeeded',
          receipt: { origin: 'synthetic_test', outputDigest: digest(JSON.stringify(output)) },
          usage: { calls: 1 },
          output,
        });
      }
      const draft = readKnownTextOutput(this.store, claim.operationId, 'draft');
      const review = readKnownTextOutput(this.store, claim.operationId, 'review');
      this.queue.completeReviewedText(claim, { draft, review });
    } catch (error) {
      this.failInvalid(claim.operationId, error);
    }
  }

  private async audioClaim(claim: WebStageClaim) {
    try {
      this.entitlement(claim.operationId);
      const bytes = syntheticTone();
      const key = this.ledger.reserve(claim, {
        phase: 'speech',
        ordinal: claim.ordinal!,
        provider: 'synthetic-local',
        providerRequestId: `${claim.operationId}:speech:${claim.ordinal}`,
      });
      this.ledger.markSent(claim, key);
      this.afterSpeechSent?.();
      if (this.audioDelayMs > 0) await this.pause(this.audioDelayMs);
      if (this.stopped) return;
      this.entitlement(claim.operationId);
      this.ledger.confirm(key, {
        outcome: 'succeeded',
        receipt: { origin: 'synthetic_test', outputDigest: digest(bytes) },
        usage: { calls: 1 },
        output: bytes,
      });
      this.afterSpeechConfirm?.();
      this.attachAudio(claim.operationId, claim.ordinal!);
    } catch (error) {
      if (!this.failLocalAudio(claim.operationId, error)) this.failInvalid(claim.operationId, error);
    }
  }

  private attachAudio(operationId: string, ordinal: number) {
    this.entitlement(operationId);
    const row = this.store.get<{
      principal_id: string;
      player_id: string;
      world_id: string;
      conversation_id: string;
      character_id: string;
      input_message_id: string;
    }>(
      `SELECT o.principal_id,p.player_id,o.world_id,o.conversation_id,o.character_id,o.input_message_id
        FROM web_operations o JOIN web_principals p ON p.id=o.principal_id WHERE o.id=?`,
      operationId,
    );
    if (!row || !this.coordinator) throw new DomainError('WEB_OPERATION_NOT_FOUND');
    this.audio.stage(
      {
        operationId,
        ordinal,
        principalId: row.principal_id,
        playerId: row.player_id,
        worldId: row.world_id,
        conversationId: row.conversation_id,
        characterId: row.character_id,
        inputMessageId: row.input_message_id,
      },
      this.coordinator,
      readKnownAudioOutput(this.store, operationId, ordinal),
    );
  }

  /** One bounded scheduler pass. The timer calls again; no synthetic social delay is introduced. */
  pump() {
    if (!this.coordinator) throw new DomainError('WEB_COORDINATOR_STALE');
    if (this.retention) {
      try {
        this.retention.sweep();
      } catch (error) {
        this.lastError = error instanceof DomainError ? error.code : 'INTERNAL_ERROR';
      }
    }
    if (this.coordinator.expiresAt - this.clock.now() < WEB_LIMITS.coordinatorLeaseMs / 2)
      this.coordinator = this.queue.renewCoordinator(this.coordinator);
    const stale = this.store.all<{ id: string; status: string }>(
      `SELECT id,status FROM web_operations
      WHERE status IN ('text_running','audio_running','ready_to_publish')
        AND (lease_epoch<>? OR lease_expires_at<=?) LIMIT 16`,
      this.coordinator.epoch,
      this.clock.now(),
    );
    for (const row of stale) {
      if (row.status === 'ready_to_publish') this.publisher.recover(this.coordinator, row.id);
      else if (row.status === 'text_running') {
        try {
          this.schedule(this.text(this.queue.resumeKnownText(this.coordinator, row.id, 'local-text-resume')));
        } catch {
          this.ledger.recover(this.coordinator, this.ledger.fence(row.id));
        }
      } else this.ledger.recover(this.coordinator, this.ledger.fence(row.id));
    }
    for (const row of this.store.all<{ id: string }>(
      `SELECT id FROM web_operations WHERE
      status NOT IN ('published','cancelled','failed') AND
      (deadline_at<=? OR status='queued' AND text_queued_at+?<=? OR
        status IN ('text_ready','audio_pending') AND audio_wait_started_at IS NOT NULL AND
        audio_wait_used_ms+?-audio_wait_started_at>=?) LIMIT 16`,
      this.clock.now(),
      WEB_LIMITS.queueWaitMs,
      this.clock.now(),
      this.clock.now(),
      WEB_LIMITS.queueWaitMs,
    )) {
      const fence = this.ledger.fence(row.id);
      this.ledger.terminate(this.coordinator, fence, fence.principalId, 'failed', 'expired');
    }
    for (const row of this.store.all<{ operation_id: string; ordinal: number }>(
      `SELECT x.operation_id,x.ordinal
      FROM web_local_audio_outputs x JOIN web_synthetic_voice_segments s
        ON s.operation_id=x.operation_id AND s.ordinal=x.ordinal
      JOIN web_operations o ON o.id=x.operation_id
      LEFT JOIN web_private_audio_assets a ON a.operation_id=x.operation_id AND a.ordinal=x.ordinal
      WHERE s.state='synthetic_complete' AND o.quota_state='reserved' AND o.deadline_at>?
        AND (a.state IS NULL OR a.state='preparing' AND
          (a.lease_until<=? OR a.lease_epoch<>?)) LIMIT 16`,
      this.clock.now(),
      this.clock.now(),
      this.coordinator.epoch,
    )) {
      try {
        this.attachAudio(row.operation_id, row.ordinal);
      } catch (error) {
        if (!this.failLocalAudio(row.operation_id, error)) throw error;
      }
    }
    const textClaim = this.queue.claimText(this.coordinator, 'local-text');
    if (textClaim) this.schedule(this.text(textClaim));
    const audioClaim = this.queue.claimAudio(this.coordinator, 'local-audio');
    if (audioClaim) this.schedule(this.audioClaim(audioClaim));
    for (const row of this.store.all<{ id: string }>(
      `SELECT id FROM web_operations WHERE
      status='audio_pending' AND audio_wait_started_at IS NULL AND quota_state='reserved'
      AND deadline_at>? LIMIT 16`,
      this.clock.now(),
    )) {
      try {
        this.entitlement(row.id);
        this.publisher.publish(this.publisher.claim(this.coordinator, row.id, 'local-publisher'));
      } catch (error) {
        this.failInvalid(row.id, error);
      }
    }
  }
}

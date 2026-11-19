import { webOperationDeleted } from '../characters/web-character-deleted.ts';
import { createHash } from 'node:crypto';
import type { Clock } from '../../../packages/contracts/index.ts';
import { DomainError, ensure } from '../../../packages/domain/errors.ts';
import { WEB_LIMITS } from '../../../config/web-v1.ts';
import { audioStartedExpr } from '../admission/web-stage-metrics.ts';
import type { WebRuntimeStore as WebStore } from '../platform/web-store-contract.ts';
import type { WebCoordinatorLease, WebStageClaim } from '../admission/web-stage-queue.ts';
import { readInputSnapshot, requireCurrentInputSnapshot } from '../generation/web-input-snapshot.ts';
import { checkWebV7SceneAtDispatch } from '../generation/web-v7-request.ts';
import {
  requireWebContent,
  settleWebLifetimeReservation,
  webReceiptDigest,
  webDataLifecycleEnabled,
  webRegisteredSql,
} from '../admission/web-retention.ts';

/** Part 43: a stage that provably never crossed the send gate is re-queued at most this many times after a restart. */
export const WEB_REQUEUE_LIMIT = 2;
type Stage = 'text' | 'audio';
type Phase = 'draft' | 'review' | 'speech';
type AttemptKey = { operationId: string; stage: Stage; phase: Phase; ordinal: number };
type AttemptRow = AttemptKey & {
  provider: string;
  dispatch_state: 'not_sent' | 'sent' | 'unknown' | 'known';
  outcome: string | null;
  receipt_json: string | null;
  usage_json: string | null;
  receipt_digest?: string | null | undefined;
  usage_digest?: string | null | undefined;
};
export type WebOperationFence = {
  operationId: string;
  principalId: string;
  worldId: string;
  conversationId: string;
  characterId: string;
  inputMessageId: string;
  ipWindowId: string | null;
  meteringType: 'trial' | 'entitled';
  status: string;
  stageVersion: number;
  deadlineAt: number;
  textQueuedAt: number;
  audioQueuedAt: number | null;
  audioWaitUsedMs: number | null;
  audioWaitStartedAt: number | null;
  leaseEpoch: number | null;
  leaseToken: string | null;
};

/** Internal fake dispatch ledger. It never calls a provider or publishes a response. */
export class WebDispatchLedger {
  private readonly store: WebStore;
  private readonly clock: Clock;
  constructor(store: WebStore, clock: Clock) {
    this.store = store;
    this.clock = clock;
  }

  private now() {
    const now = this.clock.now();
    ensure(Number.isSafeInteger(now) && now >= 0, 'INVALID_TIME');
    return now;
  }

  private schema() {
    const schema = this.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? -1;
    ensure(
      [104, 105, 106, 107, 108, 109, 110, 112].includes(schema) ||
        (schema >= 113 && webDataLifecycleEnabled(this.store)),
      'WEB_DISPATCH_MIGRATION_REQUIRED',
    );
  }

  private coordinator(lease: WebCoordinatorLease, now: number) {
    const row = this.store.get<{ epoch: number; coordinator_token: string | null; coordinator_expires_at: number }>(
      'SELECT epoch,coordinator_token,coordinator_expires_at FROM web_scheduler_state WHERE singleton=1',
    );
    ensure(
      row?.epoch === lease.epoch && row.coordinator_token === lease.token && row.coordinator_expires_at > now,
      'WEB_COORDINATOR_STALE',
    );
  }

  /** Unknown/absent provider capacity is deliberately not configured as unlimited. */
  configureBudget(input: { provider: string; stage: Stage; phase: Phase; capacity: number }) {
    ensure(
      input.provider.length > 0 &&
        input.provider.length <= 128 &&
        Number.isSafeInteger(input.capacity) &&
        input.capacity > 0 &&
        validPhase(input.stage, input.phase, input.stage === 'text' ? -1 : 0),
      'WEB_EXTERNAL_BUDGET_INVALID',
    );
    return this.store.transaction(() => {
      this.schema();
      this.store.run(
        'INSERT INTO web_external_budgets(provider,stage,phase,capacity) VALUES (?,?,?,?)',
        input.provider,
        input.stage,
        input.phase,
        input.capacity,
      );
    });
  }

  /**
   * A persisted provider capacity row follows the configured stage limit. It is never lowered below the tickets
   * still reserved, so an in-flight or UNKNOWN call keeps its ticket; a later pass retries the alignment.
   */
  alignBudget(input: { provider: string; stage: Stage; phase: Phase; capacity: number }) {
    ensure(Number.isSafeInteger(input.capacity) && input.capacity > 0, 'WEB_EXTERNAL_BUDGET_INVALID');
    return this.store.transaction(() => {
      this.schema();
      return (
        this.store.run(
          `UPDATE web_external_budgets SET capacity=? WHERE provider=? AND stage=? AND phase=?
          AND capacity<>? AND reserved<=?`,
          input.capacity,
          input.provider,
          input.stage,
          input.phase,
          input.capacity,
          input.capacity,
        ).changes === 1
      );
    });
  }

  /** Budget reservation and not-sent intent are one short transaction after a live stage claim. */
  reserve(claim: WebStageClaim, input: { phase: Phase; ordinal: number; provider: string; providerRequestId: string }) {
    ensure(
      validPhase(claim.stage, input.phase, input.ordinal) &&
        input.provider.length > 0 &&
        input.providerRequestId.length > 0,
      'WEB_DISPATCH_INVALID',
    );
    return this.store.transaction(() => {
      this.schema();
      const now = this.now();
      this.liveClaim(claim, now);
      requireWebContent(this.store, this.clock, claim.principalId, claim.worldId);
      const schema = this.store.get<{ user_version: number }>('PRAGMA user_version')!.user_version;
      if (schema >= 106) this.currentInput(claim);
      if (schema >= 108 && claim.stage === 'audio') checkWebV7SceneAtDispatch(this.store, claim.operationId, now);
      if (schema >= 105 && claim.stage === 'audio') {
        ensure(
          claim.ordinal === input.ordinal &&
            typeof claim.textDigest === 'string' &&
            typeof claim.voiceVersion === 'string',
          'WEB_VOICE_SEGMENT_STALE',
        );
        const table = schema >= 113 ? 'web_provider_voice_segments' : 'web_synthetic_voice_segments';
        ensure(
          this.store.get(
            `SELECT 1 FROM ${table}
          WHERE operation_id=? AND ordinal=? AND state='running' AND claim_stage_version=?
          AND claim_epoch=? AND claim_token=? AND text_digest=? AND voice_version=?`,
            claim.operationId,
            input.ordinal,
            claim.stageVersion,
            claim.epoch,
            claim.token,
            claim.textDigest,
            claim.voiceVersion,
          ),
          'WEB_VOICE_SEGMENT_STALE',
        );
      }
      ensure(
        !this.store.get(
          `SELECT 1 FROM web_external_attempts WHERE operation_id=? AND dispatch_state!='known' LIMIT 1`,
          claim.operationId,
        ),
        'WEB_DISPATCH_IN_FLIGHT',
      );
      ensure(
        this.store.run(
          `UPDATE web_external_budgets SET reserved=reserved+1
        WHERE provider=? AND stage=? AND phase=? AND reserved<capacity`,
          input.provider,
          claim.stage,
          input.phase,
        ).changes === 1,
        'WEB_EXTERNAL_CAPACITY_UNAVAILABLE',
      );
      // Part 43: the ticket row of an attempt released by a re-queue is reset in place (its key is the primary key).
      const released =
        !!this.store.get(
          `SELECT 1 FROM web_external_attempts WHERE operation_id=? AND stage=? AND phase=? AND ordinal=?
          AND dispatch_state='known' AND outcome='not_dispatched'`,
          claim.operationId,
          claim.stage,
          input.phase,
          input.ordinal,
        ) &&
        !!this.store.get(
          'SELECT 1 FROM web_stage_attempts WHERE operation_id=? AND stage=? AND provider_request_id=?',
          claim.operationId,
          claim.stage,
          `requeue:${input.phase}:${input.ordinal}`,
        );
      if (released)
        this.store.run(
          `UPDATE web_external_attempts SET provider=?,provider_request_id=?,dispatch_state='not_sent',outcome=NULL,
          sent_at=NULL,settled_at=NULL,receipt_json=NULL,usage_json=NULL,
          ${schema >= 113 ? 'receipt_digest=NULL,usage_digest=NULL,' : ''}
          stage_version=?,lease_epoch=?,lease_token=?,created_at=?
          WHERE operation_id=? AND stage=? AND phase=? AND ordinal=?`,
          input.provider,
          input.providerRequestId,
          claim.stageVersion,
          claim.epoch,
          claim.token,
          now,
          claim.operationId,
          claim.stage,
          input.phase,
          input.ordinal,
        );
      else
        this.store.run(
          `INSERT INTO web_external_attempts(operation_id,stage,phase,ordinal,provider,provider_request_id,
        dispatch_state,stage_version,lease_epoch,lease_token,principal_id,world_id,conversation_id,input_message_id,created_at)
        VALUES (?,?,?,?,?,?,'not_sent',?,?,?,?,?,?,?,?)`,
          claim.operationId,
          claim.stage,
          input.phase,
          input.ordinal,
          input.provider,
          input.providerRequestId,
          claim.stageVersion,
          claim.epoch,
          claim.token,
          claim.principalId,
          claim.worldId,
          claim.conversationId,
          claim.inputMessageId,
          now,
        );
      return { operationId: claim.operationId, stage: claim.stage, phase: input.phase, ordinal: input.ordinal };
    });
  }

  /** Persist before even a fake executor is permitted to observe an outbound intent. */
  markSent(claim: WebStageClaim, key: AttemptKey) {
    return this.store.transaction(() => {
      this.schema();
      const now = this.now();
      this.liveClaim(claim, now);
      requireWebContent(this.store, this.clock, claim.principalId, claim.worldId);
      if ((this.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? -1) >= 106)
        this.currentInput(claim);
      if (
        (this.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? -1) >= 108 &&
        claim.stage === 'audio'
      )
        checkWebV7SceneAtDispatch(this.store, claim.operationId, now);
      ensure(key.operationId === claim.operationId && key.stage === claim.stage, 'WEB_DISPATCH_STALE');
      if (
        claim.stage === 'audio' &&
        (this.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? -1) >= 105
      ) {
        const schema = this.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? -1;
        const table = schema >= 113 ? 'web_provider_voice_segments' : 'web_synthetic_voice_segments';
        ensure(
          key.ordinal === claim.ordinal &&
            typeof claim.textDigest === 'string' &&
            typeof claim.voiceVersion === 'string' &&
            this.store.get(
              `SELECT 1 FROM ${table}
            WHERE operation_id=? AND ordinal=? AND state='running' AND claim_stage_version=?
              AND claim_epoch=? AND claim_token=? AND text_digest=? AND voice_version=?`,
              key.operationId,
              key.ordinal,
              claim.stageVersion,
              claim.epoch,
              claim.token,
              claim.textDigest,
              claim.voiceVersion,
            ),
          'WEB_VOICE_SEGMENT_STALE',
        );
      }
      ensure(
        this.store.run(
          `UPDATE web_external_attempts SET dispatch_state='sent',sent_at=?
        WHERE operation_id=? AND stage=? AND phase=? AND ordinal=? AND dispatch_state='not_sent'
        AND stage_version=? AND lease_epoch=? AND lease_token=? AND principal_id=? AND world_id=?
        AND conversation_id=? AND input_message_id=?`,
          now,
          key.operationId,
          key.stage,
          key.phase,
          key.ordinal,
          claim.stageVersion,
          claim.epoch,
          claim.token,
          claim.principalId,
          claim.worldId,
          claim.conversationId,
          claim.inputMessageId,
        ).changes === 1,
        'WEB_DISPATCH_STALE',
      );
    });
  }

  /** A 113 intent proven not sent releases only its original capacity ticket. */
  abandonProviderUnsent(
    key: AttemptKey,
    scope: { principalId: string; worldId: string; conversationId: string; inputMessageId: string },
  ) {
    return this.store.transaction(() => {
      this.schema();
      ensure(
        (this.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? -1) >= 113,
        'WEB_DISPATCH_MIGRATION_REQUIRED',
      );
      const row = this.store.get<
        AttemptRow & { principal_id: string; world_id: string; conversation_id: string; input_message_id: string }
      >(
        `SELECT * FROM web_external_attempts
        WHERE operation_id=? AND stage=? AND phase=? AND ordinal=?`,
        key.operationId,
        key.stage,
        key.phase,
        key.ordinal,
      );
      ensure(
        row &&
          row.dispatch_state === 'not_sent' &&
          row.principal_id === scope.principalId &&
          row.world_id === scope.worldId &&
          row.conversation_id === scope.conversationId &&
          row.input_message_id === scope.inputMessageId,
        'WEB_DISPATCH_STALE',
      );
      ensure(
        this.store.run(
          `UPDATE web_external_attempts SET dispatch_state='known',
        outcome='not_dispatched',receipt_json='{}',usage_json='{}',settled_at=?
        WHERE operation_id=? AND stage=? AND phase=? AND ordinal=? AND dispatch_state='not_sent'`,
          this.now(),
          key.operationId,
          key.stage,
          key.phase,
          key.ordinal,
        ).changes === 1,
        'WEB_DISPATCH_STALE',
      );
      this.releaseBudget(row);
    });
  }

  /**
   * A provider rejected the request with HTTP 429 and the retries are over: settle the capacity ticket as a known,
   * zero-usage failure. Unlike confirm(), this never fails the operation (a voice request falls back to text).
   */
  settleRejected(key: AttemptKey) {
    return this.store.transaction(() => {
      this.schema();
      const row = this.attempt(key);
      ensure(row && (row.dispatch_state === 'sent' || row.dispatch_state === 'not_sent'), 'WEB_DISPATCH_STALE');
      ensure(
        this.store.run(
          `UPDATE web_external_attempts SET dispatch_state='known',outcome='failed',receipt_json='{"rateLimited":true}',
          usage_json='{}',settled_at=? WHERE operation_id=? AND stage=? AND phase=? AND ordinal=?
          AND dispatch_state IN ('sent','not_sent')`,
          this.now(),
          key.operationId,
          key.stage,
          key.phase,
          key.ordinal,
        ).changes === 1,
        'WEB_DISPATCH_STALE',
      );
      this.releaseBudget(row);
    });
  }

  /** On-time fake audio success advances only synthetic metadata; late receipts settle external cost only. */
  confirm(
    key: AttemptKey,
    result: {
      outcome: 'succeeded' | 'failed';
      receipt: unknown;
      usage: unknown;
      /** 109 synthetic-local only: the exact known provider output, not a regenerable digest. */
      output?: unknown;
    },
  ) {
    ensure(result.receipt !== undefined && result.usage !== undefined, 'WEB_DISPATCH_RECEIPT_REQUIRED');
    return this.store.transaction(() => {
      this.schema();
      const now = this.now();
      const row = this.attempt(key);
      ensure(row && row.dispatch_state !== 'not_sent', 'WEB_DISPATCH_NOT_SENT');
      const schema = this.store.get<{ user_version: number }>('PRAGMA user_version')!.user_version;
      const lifecycle =
        schema === 110 ||
        schema === 112 ||
        (schema >= 113 && (!!this.store.providerAudio || webOperationDeleted(this.store, key.operationId)));
      const synthetic = [109, 110, 112].includes(schema);
      // Part 17i: a REGISTERED player (webRegisteredSql: signup bonus, or an email login) is a kept account; its expired trial
      // window is not a purge. The rule is the one requireWebContent and the stage queue use.
      const registered = webRegisteredSql(schema, this.store.publicFreeTier === true, now);
      const purging =
        webOperationDeleted(this.store, key.operationId) ||
        (lifecycle &&
          !!this.store.get(
            `SELECT 1 FROM web_external_attempts a
        JOIN web_guest_retention r ON r.principal_id=a.principal_id AND r.world_id=a.world_id
        JOIN web_principals p ON p.id=a.principal_id
        WHERE a.operation_id=? AND a.stage=? AND a.phase=? AND a.ordinal=?
          AND (r.state IN ('purging','purged') OR r.state='active' AND r.expires_at<=? AND NOT ${registered.sql})`,
            key.operationId,
            key.stage,
            key.phase,
            key.ordinal,
            now,
            ...registered.args,
          ));
      const receiptJson = JSON.stringify(result.receipt),
        usageJson = JSON.stringify(result.usage);
      if (row.dispatch_state === 'known') {
        ensure(
          row.outcome === result.outcome &&
            (row.receipt_json === receiptJson ||
              (lifecycle && row.receipt_digest === webReceiptDigest(this.store, 'receipt', receiptJson))) &&
            (row.usage_json === usageJson ||
              (lifecycle && row.usage_digest === webReceiptDigest(this.store, 'usage', usageJson))),
          'WEB_DISPATCH_RECEIPT_CONFLICT',
        );
        if (key.stage === 'text' && result.output !== undefined && synthetic && !purging) {
          const known = this.store.get<{ output_json: string }>(
            `SELECT output_json FROM web_local_text_outputs
            WHERE operation_id=? AND phase=?`,
            key.operationId,
            key.phase,
          );
          ensure(!known || known.output_json === JSON.stringify(result.output), 'WEB_TEXT_OUTPUT_CONFLICT');
        }
        if (key.stage === 'audio' && result.output !== undefined && synthetic && !purging) {
          const known = this.store.get<{ bytes: Uint8Array }>(
            `SELECT bytes FROM web_local_audio_outputs
            WHERE operation_id=? AND ordinal=?`,
            key.operationId,
            key.ordinal,
          );
          ensure(
            !known ||
              (result.output instanceof Uint8Array && Buffer.from(known.bytes).equals(Buffer.from(result.output))),
            'WEB_AUDIO_OUTPUT_CONFLICT',
          );
        }
        return { duplicate: true as const };
      }
      const localText = key.stage === 'text' && result.outcome === 'succeeded' && synthetic && !purging;
      const liveText =
        localText &&
        row.dispatch_state === 'sent' &&
        !!this.store.get(
          `SELECT 1 FROM web_operations o JOIN web_external_attempts a
          ON a.operation_id=o.id WHERE o.id=? AND a.stage='text' AND a.phase=? AND a.ordinal=-1
          AND o.status='text_running' AND o.quota_state='reserved' AND o.stage_version=a.stage_version
          AND o.lease_epoch=a.lease_epoch AND o.lease_token=a.lease_token
          AND o.lease_expires_at>? AND o.deadline_at>?
          AND EXISTS (SELECT 1 FROM web_scheduler_state s WHERE s.singleton=1
            AND s.epoch=a.lease_epoch AND s.coordinator_token IS NOT NULL
            AND s.coordinator_expires_at>?)`,
          key.operationId,
          key.phase,
          now,
          now,
          now,
        );
      if (liveText) {
        const outputJson = JSON.stringify(result.output);
        ensure(outputJson !== undefined && key.ordinal === -1, 'WEB_TEXT_OUTPUT_REQUIRED');
        const receipt = result.receipt as { origin?: unknown; outputDigest?: unknown };
        const outputDigest = createHash('sha256').update(outputJson).digest('hex');
        ensure(
          receipt && receipt.origin === 'synthetic_test' && receipt.outputDigest === outputDigest,
          'WEB_TEXT_RECEIPT_OUTPUT_MISMATCH',
        );
        const request = this.store.get<{ request_digest: string }>(
          'SELECT request_digest FROM web_v7_requests WHERE operation_id=?',
          key.operationId,
        );
        ensure(request, 'WEB_V7_REQUEST_MISSING');
        this.store.run(
          `INSERT INTO web_local_text_outputs(operation_id,phase,request_digest,output_json,
          output_digest,created_at) VALUES (?,?,?,?,?,?)`,
          key.operationId,
          key.phase,
          request.request_digest,
          outputJson,
          outputDigest,
          now,
        );
      }
      const localAudio = key.stage === 'audio' && result.outcome === 'succeeded' && synthetic && !purging;
      const liveAudio =
        localAudio &&
        row.dispatch_state === 'sent' &&
        !!this.store.get(
          `SELECT 1 FROM web_operations o JOIN web_external_attempts a
          ON a.operation_id=o.id WHERE o.id=? AND a.stage='audio' AND a.phase='speech' AND a.ordinal=?
          AND o.status='audio_running' AND o.quota_state='reserved' AND o.stage_version=a.stage_version
          AND o.lease_epoch=a.lease_epoch AND o.lease_token=a.lease_token
          AND o.lease_expires_at>? AND o.deadline_at>?
          AND EXISTS (SELECT 1 FROM web_scheduler_state s WHERE s.singleton=1
            AND s.epoch=a.lease_epoch AND s.coordinator_token IS NOT NULL
            AND s.coordinator_expires_at>?)`,
          key.operationId,
          key.ordinal,
          now,
          now,
          now,
        );
      if (liveAudio) {
        ensure(
          result.output instanceof Uint8Array && result.output.byteLength > 0 && result.output.byteLength <= 6_000_000,
          'WEB_AUDIO_OUTPUT_REQUIRED',
        );
        const bytes = Buffer.from(result.output);
        const outputDigest = createHash('sha256').update(bytes).digest('hex');
        const receipt = result.receipt as { origin?: unknown; outputDigest?: unknown };
        ensure(
          receipt && receipt.origin === 'synthetic_test' && receipt.outputDigest === outputDigest,
          'WEB_AUDIO_RECEIPT_OUTPUT_MISMATCH',
        );
        this.store.run(
          `INSERT INTO web_local_audio_outputs(operation_id,ordinal,byte_length,sha256,bytes)
          VALUES (?,?,?,?,?)`,
          key.operationId,
          key.ordinal,
          bytes.length,
          outputDigest,
          bytes,
        );
      }
      const onTimeFailure =
        (this.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? -1) >= 106 &&
        row.dispatch_state === 'sent' &&
        result.outcome === 'failed';
      ensure(
        this.store.run(
          `UPDATE web_external_attempts SET dispatch_state='known',outcome=?,receipt_json=?,usage_json=?,
        ${lifecycle ? 'receipt_digest=?,usage_digest=?,' : ''}settled_at=?
        WHERE operation_id=? AND stage=? AND phase=? AND ordinal=? AND dispatch_state IN ('sent','unknown')`,
          result.outcome,
          purging ? null : receiptJson,
          purging ? null : usageJson,
          ...(lifecycle
            ? [
                purging ? webReceiptDigest(this.store, 'receipt', receiptJson) : null,
                purging ? webReceiptDigest(this.store, 'usage', usageJson) : null,
              ]
            : []),
          now,
          key.operationId,
          key.stage,
          key.phase,
          key.ordinal,
        ).changes === 1,
        'WEB_DISPATCH_STALE',
      );
      this.releaseBudget(row);
      if (onTimeFailure) this.failCurrentAttempt(key, now);
      if (
        key.stage === 'audio' &&
        result.outcome === 'succeeded' &&
        (this.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? -1) >= 105 &&
        (this.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? -1) < 113
      )
        this.completeSyntheticAudio(key, now);
      return { duplicate: false as const };
    });
  }

  /** A current, explicitly failed provider attempt ends only its own reserved operation. */
  private failCurrentAttempt(key: AttemptKey, now: number) {
    const attempt = this.store.get<{
      stage_version: number;
      lease_epoch: number;
      lease_token: string;
      principal_id: string;
      world_id: string;
      conversation_id: string;
      input_message_id: string;
    }>(
      `SELECT stage_version,lease_epoch,lease_token,principal_id,world_id,conversation_id,input_message_id
       FROM web_external_attempts WHERE operation_id=? AND stage=? AND phase=? AND ordinal=?
         AND dispatch_state='known' AND outcome='failed' AND sent_at IS NOT NULL`,
      key.operationId,
      key.stage,
      key.phase,
      key.ordinal,
    );
    if (!attempt) return;
    this.failRunningOperation(key.operationId, key.stage, attempt, now);
  }

  /**
   * Part 21d: every model of a text stage's chain failed definitely-not-billed and the next one could not even be started
   * (no key, request too large), so nothing is in flight and nothing can succeed later. Fails the operation at once instead
   * of at its deadline; reconcile then refunds the points. Only for the CURRENT, live text claim and only when no attempt is
   * open (an UNKNOWN attempt keeps its reservation and the operation waits). A stale claim does nothing.
   */
  failChainExhausted(claim: WebStageClaim) {
    return this.store.transaction(() => {
      this.schema();
      if (claim.stage !== 'text') return;
      this.failRunningOperation(
        claim.operationId,
        'text',
        { stage_version: claim.stageVersion, lease_epoch: claim.epoch, lease_token: claim.token },
        this.now(),
      );
    });
  }

  private failRunningOperation(
    operationId: string,
    stage: 'text' | 'audio',
    attempt: {
      stage_version: number;
      lease_epoch: number;
      lease_token: string;
      /** Present when the attempt row names the scope, which must then match the operation's. */
      principal_id?: string;
      world_id?: string;
      conversation_id?: string;
      input_message_id?: string;
    },
    now: number,
  ) {
    const operation = this.store.get<{
      principal_id: string;
      world_id: string;
      conversation_id: string;
      character_id: string;
      input_message_id: string;
      ip_window_id: string | null;
      metering_type?: 'trial' | 'entitled';
      status: string;
      stage_version: number;
      lease_epoch: number | null;
      lease_token: string | null;
      lease_owner: string | null;
      lease_expires_at: number | null;
      deadline_at: number;
      quota_state: string;
    }>('SELECT * FROM web_operations WHERE id=?', operationId);
    const coordinator = this.store.get<{
      epoch: number;
      coordinator_token: string | null;
      coordinator_expires_at: number;
    }>('SELECT epoch,coordinator_token,coordinator_expires_at FROM web_scheduler_state WHERE singleton=1');
    if (
      !operation ||
      operation.status !== (stage === 'text' ? 'text_running' : 'audio_running') ||
      operation.quota_state !== 'reserved' ||
      operation.stage_version !== attempt.stage_version ||
      operation.lease_epoch !== attempt.lease_epoch ||
      operation.lease_token !== attempt.lease_token ||
      operation.lease_owner === null ||
      operation.lease_expires_at === null ||
      operation.lease_expires_at <= now ||
      operation.deadline_at <= now ||
      coordinator?.epoch !== attempt.lease_epoch ||
      coordinator.coordinator_token === null ||
      coordinator.coordinator_expires_at <= now ||
      (attempt.principal_id !== undefined && operation.principal_id !== attempt.principal_id) ||
      (attempt.world_id !== undefined && operation.world_id !== attempt.world_id) ||
      (attempt.conversation_id !== undefined && operation.conversation_id !== attempt.conversation_id) ||
      (attempt.input_message_id !== undefined && operation.input_message_id !== attempt.input_message_id) ||
      this.store.get(
        `SELECT 1 FROM web_external_attempts WHERE operation_id=? AND dispatch_state!='known' LIMIT 1`,
        operationId,
      )
    )
      return;
    // Read the committed scope, not current template/body: failure must remain settleable after material changes.
    let snapshot;
    try {
      snapshot = readInputSnapshot(this.store, {
        operation_id: operationId,
        principal_id: operation.principal_id,
        world_id: operation.world_id,
        conversation_id: operation.conversation_id,
        character_id: operation.character_id,
        input_message_id: operation.input_message_id,
      });
    } catch (error) {
      if (error instanceof DomainError && error.code === 'WEB_INPUT_SNAPSHOT_NOT_FOUND') return;
      throw error;
    }
    if (
      snapshot.player_id !==
      this.store.get<{ player_id: string }>(
        'SELECT player_id FROM web_principals WHERE id=? AND world_id=?',
        operation.principal_id,
        operation.world_id,
      )?.player_id
    )
      return;
    ensure(
      this.store.run(
        `UPDATE web_operations SET status='failed',quota_state='released',
      stage_version=stage_version+1,lease_epoch=NULL,lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL
      WHERE id=? AND principal_id=? AND world_id=? AND conversation_id=? AND character_id=?
        AND input_message_id=? AND ip_window_id IS ? AND status=? AND stage_version=?
        AND lease_epoch=? AND lease_token=? AND lease_owner IS NOT NULL
        AND lease_expires_at>? AND deadline_at>? AND quota_state='reserved'`,
        operationId,
        operation.principal_id,
        operation.world_id,
        operation.conversation_id,
        operation.character_id,
        operation.input_message_id,
        operation.ip_window_id,
        operation.status,
        operation.stage_version,
        attempt.lease_epoch,
        attempt.lease_token,
        now,
        now,
      ).changes === 1,
      'WEB_OPERATION_STALE',
    );
    if ((operation.metering_type ?? 'trial') === 'trial') {
      ensure(
        operation.ip_window_id &&
          this.store.run(
            'UPDATE web_ip_windows SET reserved=reserved-1 WHERE id=? AND reserved>0',
            operation.ip_window_id,
          ).changes === 1,
        'WEB_QUOTA_STATE_INVALID',
      );
      settleWebLifetimeReservation(this.store, operation.ip_window_id!, 'released');
      ensure(
        this.store.run(
          `UPDATE web_principals SET trial_reserved=trial_reserved-1,revision=revision+1
        WHERE id=? AND world_id=? AND player_id=? AND trial_reserved>0`,
          operation.principal_id,
          operation.world_id,
          snapshot.player_id,
        ).changes === 1,
        'WEB_QUOTA_STATE_INVALID',
      );
    }
  }

  /** Same fake receipt transaction: a private digest is not a playable asset or publication. */
  private completeSyntheticAudio(key: AttemptKey, now: number) {
    const attempt = this.store.get<{
      stage_version: number;
      lease_epoch: number;
      lease_token: string;
      principal_id: string;
      world_id: string;
      conversation_id: string;
      input_message_id: string;
    }>(
      `SELECT stage_version,lease_epoch,lease_token,principal_id,world_id,conversation_id,input_message_id
        FROM web_external_attempts WHERE operation_id=? AND stage='audio' AND phase='speech' AND ordinal=?
          AND dispatch_state='known' AND outcome='succeeded' AND sent_at IS NOT NULL`,
      key.operationId,
      key.ordinal,
    );
    if (!attempt) return;
    const operation = this.store.get<{
      stage_version: number;
      lease_epoch: number | null;
      lease_token: string | null;
      principal_id: string;
      world_id: string;
      conversation_id: string;
      input_message_id: string;
      lease_expires_at: number | null;
      deadline_at: number;
      status: string;
      quota_state: string;
      audio_wait_used_ms: number | null;
      audio_wait_started_at: number | null;
    }>('SELECT * FROM web_operations WHERE id=?', key.operationId);
    const scheduler = this.store.get<{ epoch: number; coordinator_expires_at: number }>(
      'SELECT epoch,coordinator_expires_at FROM web_scheduler_state WHERE singleton=1',
    );
    if (
      !operation ||
      operation.status !== 'audio_running' ||
      operation.quota_state !== 'reserved' ||
      operation.stage_version !== attempt.stage_version ||
      operation.lease_epoch !== attempt.lease_epoch ||
      operation.lease_token !== attempt.lease_token ||
      operation.lease_expires_at === null ||
      operation.lease_expires_at <= now ||
      operation.deadline_at <= now ||
      operation.audio_wait_used_ms === null ||
      operation.audio_wait_started_at !== null ||
      scheduler?.epoch !== attempt.lease_epoch ||
      scheduler.coordinator_expires_at <= now ||
      operation.principal_id !== attempt.principal_id ||
      operation.world_id !== attempt.world_id ||
      operation.conversation_id !== attempt.conversation_id ||
      operation.input_message_id !== attempt.input_message_id
    )
      return;
    const segment = this.store.get<{
      state: string;
      text_digest: string;
      voice_version: string;
      claim_stage_version: number | null;
      claim_epoch: number | null;
      claim_token: string | null;
    }>('SELECT * FROM web_synthetic_voice_segments WHERE operation_id=? AND ordinal=?', key.operationId, key.ordinal);
    const candidate = this.store.get<{ input_message_id: string; narrative_json: string; voice_version: string }>(
      'SELECT input_message_id,narrative_json,voice_version FROM web_reviewed_candidates WHERE operation_id=?',
      key.operationId,
    );
    if (
      !segment ||
      segment.state !== 'running' ||
      segment.claim_stage_version !== attempt.stage_version ||
      segment.claim_epoch !== attempt.lease_epoch ||
      segment.claim_token !== attempt.lease_token ||
      !candidate ||
      candidate.input_message_id !== operation.input_message_id ||
      candidate.voice_version !== segment.voice_version
    )
      return;
    let narrative: unknown;
    try {
      narrative = JSON.parse(candidate.narrative_json);
    } catch {
      return;
    }
    if (
      !Array.isArray(narrative) ||
      typeof narrative[key.ordinal] !== 'string' ||
      createHash('sha256').update(narrative[key.ordinal]).digest('hex') !== segment.text_digest
    )
      return;
    ensure(
      this.store.run(
        `UPDATE web_synthetic_voice_segments SET state='synthetic_complete',completed_at=?
      WHERE operation_id=? AND ordinal=? AND state='running' AND claim_stage_version=?
        AND claim_epoch=? AND claim_token=? AND text_digest=? AND voice_version=?`,
        now,
        key.operationId,
        key.ordinal,
        attempt.stage_version,
        attempt.lease_epoch,
        attempt.lease_token,
        segment.text_digest,
        segment.voice_version,
      ).changes === 1,
      'WEB_VOICE_SEGMENT_STALE',
    );
    const pending = !!this.store.get(
      `SELECT 1 FROM web_synthetic_voice_segments
      WHERE operation_id=? AND state='pending' LIMIT 1`,
      key.operationId,
    );
    ensure(
      this.store.run(
        `UPDATE web_operations SET status='audio_pending',stage_version=stage_version+1,
      audio_wait_started_at=?,lease_epoch=NULL,lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL
      WHERE id=? AND status='audio_running' AND stage_version=? AND lease_epoch=? AND lease_token=?
        AND lease_expires_at>? AND deadline_at>? AND quota_state='reserved'`,
        pending ? now : null,
        key.operationId,
        attempt.stage_version,
        attempt.lease_epoch,
        attempt.lease_token,
        now,
        now,
      ).changes === 1,
      'WEB_STAGE_STALE',
    );
  }

  /** Metadata-only conclusion. No bytes, media URL, or publication guarantee exists. */
  syntheticComplete(operationId: string): boolean {
    this.schema();
    ensure(
      (this.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? -1) >= 105,
      'WEB_SYNTHETIC_VOICE_MIGRATION_REQUIRED',
    );
    const row = this.store.get<{ total: number; complete: number }>(
      `SELECT count(*) total,
      coalesce(sum(CASE WHEN state='synthetic_complete' THEN 1 ELSE 0 END),0) complete
      FROM web_synthetic_voice_segments WHERE operation_id=?`,
      operationId,
    )!;
    return row.total > 0 && row.total === row.complete;
  }

  /** Captures the exact version/scope for a later coordinator-fenced terminal transition. */
  fence(operationId: string): WebOperationFence {
    this.schema();
    const row = this.store.get<{
      id: string;
      principal_id: string;
      world_id: string;
      conversation_id: string;
      character_id: string;
      input_message_id: string;
      ip_window_id: string | null;
      metering_type?: 'trial' | 'entitled';
      status: string;
      stage_version: number;
      deadline_at: number;
      text_queued_at: number;
      audio_queued_at: number | null;
      lease_epoch: number | null;
      lease_token: string | null;
      audio_wait_used_ms?: number | null;
      audio_wait_started_at?: number | null;
    }>('SELECT * FROM web_operations WHERE id=?', operationId);
    ensure(row, 'WEB_OPERATION_NOT_FOUND');
    return {
      operationId: row.id,
      principalId: row.principal_id,
      worldId: row.world_id,
      conversationId: row.conversation_id,
      characterId: row.character_id,
      inputMessageId: row.input_message_id,
      ipWindowId: row.ip_window_id,
      meteringType: row.metering_type ?? 'trial',
      status: row.status,
      stageVersion: row.stage_version,
      deadlineAt: row.deadline_at,
      textQueuedAt: row.text_queued_at,
      audioQueuedAt: row.audio_queued_at,
      audioWaitUsedMs: row.audio_wait_used_ms ?? null,
      audioWaitStartedAt: row.audio_wait_started_at ?? null,
      leaseEpoch: row.lease_epoch,
      leaseToken: row.lease_token,
    };
  }

  terminate(
    coordinator: WebCoordinatorLease,
    fence: WebOperationFence,
    principalId: string,
    terminal: 'cancelled' | 'failed',
    reason: 'cancel' | 'expired' | 'system_invalid',
    errorCode?: 'SCENE_INVALIDATED' | 'INPUT_INVALIDATED' | 'AUTH_REVOKED' | 'INTERNAL_FAILURE',
  ) {
    return this.terminateInternal(coordinator, fence, principalId, terminal, reason, errorCode);
  }

  private terminateInternal(
    coordinator: WebCoordinatorLease,
    fence: WebOperationFence,
    principalId: string,
    terminal: 'cancelled' | 'failed',
    reason: 'cancel' | 'expired' | 'recovered_unsent' | 'system_invalid',
    errorCode?: 'SCENE_INVALIDATED' | 'INPUT_INVALIDATED' | 'AUTH_REVOKED' | 'INTERNAL_FAILURE',
  ) {
    return this.store.transaction(() => {
      this.schema();
      const now = this.now();
      this.coordinator(coordinator, now);
      ensure(principalId === fence.principalId, 'WEB_SCOPE_MISMATCH');
      const current = this.fence(fence.operationId);
      ensure(
        current.principalId === fence.principalId &&
          current.worldId === fence.worldId &&
          current.conversationId === fence.conversationId &&
          current.characterId === fence.characterId &&
          current.inputMessageId === fence.inputMessageId &&
          current.ipWindowId === fence.ipWindowId &&
          current.meteringType === fence.meteringType,
        'WEB_SCOPE_MISMATCH',
      );
      if (
        current.status === terminal &&
        this.store.get<{ quota_state: string }>('SELECT quota_state FROM web_operations WHERE id=?', fence.operationId)
          ?.quota_state === 'released'
      ) {
        return { status: terminal, duplicate: true as const };
      }
      ensure(
        current.status === fence.status &&
          current.stageVersion === fence.stageVersion &&
          current.principalId === fence.principalId &&
          current.worldId === fence.worldId &&
          current.conversationId === fence.conversationId &&
          current.characterId === fence.characterId &&
          current.inputMessageId === fence.inputMessageId &&
          current.ipWindowId === fence.ipWindowId &&
          current.meteringType === fence.meteringType &&
          current.leaseEpoch === fence.leaseEpoch &&
          current.leaseToken === fence.leaseToken &&
          current.deadlineAt === fence.deadlineAt,
        'WEB_OPERATION_STALE',
      );
      ensure(reason === 'cancel' ? terminal === 'cancelled' : terminal === 'failed', 'WEB_TERMINAL_INVALID');
      if (reason === 'system_invalid')
        ensure(
          [109, 110, 112].includes(
            this.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? -1,
          ) && errorCode !== undefined,
          'WEB_TERMINAL_INVALID',
        );
      if (reason === 'expired') {
        const queueExpired =
          (current.status === 'queued' && now >= current.textQueuedAt + WEB_LIMITS.queueWaitMs) ||
          (['text_ready', 'audio_pending'].includes(current.status) &&
            ((this.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? -1) >= 105
              ? current.audioWaitUsedMs !== null &&
                current.audioWaitStartedAt !== null &&
                now >= current.audioWaitStartedAt &&
                current.audioWaitUsedMs + now - current.audioWaitStartedAt >= WEB_LIMITS.queueWaitMs &&
                // An operation that already started audio is paid for: only its deadline may end it.
                !this.store.get(
                  `SELECT 1 FROM web_operations o WHERE o.id=? AND ${audioStartedExpr(this.store, 'o')}`,
                  current.operationId,
                )
              : current.audioQueuedAt !== null && now >= current.audioQueuedAt + WEB_LIMITS.queueWaitMs));
        ensure(now >= current.deadlineAt || queueExpired, 'WEB_OPERATION_NOT_EXPIRED');
      }
      ensure(!['published', 'cancelled', 'failed'].includes(current.status), 'WEB_OPERATION_TERMINAL_CONFLICT');
      const local = [109, 110, 112].includes(
        this.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? -1,
      );
      const failureCode =
        reason === 'expired'
          ? 'OPERATION_EXPIRED'
          : reason === 'recovered_unsent'
            ? 'RECOVERED_NOT_SENT'
            : reason === 'system_invalid'
              ? errorCode!
              : null;
      ensure(
        this.store.run(
          `UPDATE web_operations SET status=?,quota_state='released',stage_version=stage_version+1,
        ${local ? 'failure_code=?,' : ''}
        lease_epoch=NULL,lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL
        WHERE id=? AND principal_id=? AND world_id=? AND conversation_id=? AND character_id=? AND input_message_id=?
        AND ip_window_id IS ? AND status=? AND stage_version=? AND quota_state='reserved'`,
          terminal,
          ...(local ? [failureCode] : []),
          current.operationId,
          current.principalId,
          current.worldId,
          current.conversationId,
          current.characterId,
          current.inputMessageId,
          current.ipWindowId,
          current.status,
          current.stageVersion,
        ).changes === 1,
        'WEB_OPERATION_STALE',
      );
      this.closeOpenAttempts(current.operationId, now);
      if (current.meteringType === 'trial') {
        ensure(
          current.ipWindowId &&
            this.store.run(
              'UPDATE web_ip_windows SET reserved=reserved-1 WHERE id=? AND reserved>0',
              current.ipWindowId,
            ).changes === 1,
          'WEB_QUOTA_STATE_INVALID',
        );
        settleWebLifetimeReservation(this.store, current.ipWindowId!, 'released');
        ensure(
          this.store.run(
            `UPDATE web_principals SET trial_reserved=trial_reserved-1,revision=revision+1
          WHERE id=? AND world_id=? AND trial_reserved>0`,
            current.principalId,
            current.worldId,
          ).changes === 1,
          'WEB_QUOTA_STATE_INVALID',
        );
      }
      return { status: terminal, duplicate: false as const };
    });
  }

  /** A new coordinator classifies expired old claims without redrawing or resending. */
  recover(coordinator: WebCoordinatorLease, fence: WebOperationFence) {
    return this.store.transaction(() => {
      this.schema();
      const now = this.now();
      this.coordinator(coordinator, now);
      const row = this.store.get<{
        lease_expires_at: number | null;
        status: string;
        stage_version: number;
        lease_epoch: number | null;
      }>('SELECT lease_expires_at,status,stage_version,lease_epoch FROM web_operations WHERE id=?', fence.operationId);
      ensure(
        row &&
          row.status === fence.status &&
          row.stage_version === fence.stageVersion &&
          (row.status === 'text_running' || row.status === 'audio_running') &&
          (row.lease_expires_at === null || row.lease_expires_at <= now || row.lease_epoch !== coordinator.epoch),
        'WEB_OPERATION_STALE',
      );
      const open = this.store.all<{ dispatch_state: string }>(
        "SELECT dispatch_state FROM web_external_attempts WHERE operation_id=? AND dispatch_state!='known'",
        fence.operationId,
      );
      if (
        (this.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? -1) >= 113 &&
        row.status === 'audio_running' &&
        open.length === 0
      ) {
        const segment = this.store.get<{ ordinal: number }>(
          `SELECT ordinal FROM web_provider_voice_segments
          WHERE operation_id=? AND state='running' AND claim_stage_version=? AND claim_epoch IS ?
            AND claim_token IS ?`,
          fence.operationId,
          fence.stageVersion,
          fence.leaseEpoch,
          fence.leaseToken,
        );
        if (
          segment &&
          this.store.get(
            `SELECT 1 FROM web_provider_attempts a
          JOIN web_provider_outputs x ON x.operation_id=a.operation_id AND x.phase=a.phase
            AND x.ordinal=a.ordinal WHERE a.operation_id=? AND a.phase='speech'
            AND a.ordinal=? AND a.state='known' AND a.outcome='succeeded'`,
            fence.operationId,
            segment.ordinal,
          )
        ) {
          ensure(
            this.store.run(
              `UPDATE web_provider_voice_segments SET state='pending',
            claim_stage_version=NULL,claim_epoch=NULL,claim_token=NULL
            WHERE operation_id=? AND ordinal=? AND state='running' AND claim_stage_version=?`,
              fence.operationId,
              segment.ordinal,
              fence.stageVersion,
            ).changes === 1,
            'WEB_VOICE_SEGMENT_STALE',
          );
          ensure(
            this.store.run(
              `UPDATE web_operations SET status='audio_pending',
            stage_version=stage_version+1,audio_wait_started_at=?,lease_epoch=NULL,
            lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL WHERE id=? AND status='audio_running'
            AND stage_version=? AND lease_epoch IS ? AND lease_token IS ?`,
              now,
              fence.operationId,
              fence.stageVersion,
              fence.leaseEpoch,
              fence.leaseToken,
            ).changes === 1,
            'WEB_OPERATION_STALE',
          );
          return { status: 'audio_pending' as const };
        }
      }
      if (open.some((attempt) => attempt.dispatch_state !== 'not_sent')) {
        ensure(
          this.store.run(
            `UPDATE web_operations SET status='unknown',stage_version=stage_version+1,
          lease_epoch=NULL,lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL
          WHERE id=? AND status=? AND stage_version=? AND principal_id=? AND world_id=? AND conversation_id=?
          AND character_id=? AND input_message_id=? AND ip_window_id IS ? AND lease_epoch IS ? AND lease_token IS ?`,
            fence.operationId,
            fence.status,
            fence.stageVersion,
            fence.principalId,
            fence.worldId,
            fence.conversationId,
            fence.characterId,
            fence.inputMessageId,
            fence.ipWindowId,
            fence.leaseEpoch,
            fence.leaseToken,
          ).changes === 1,
          'WEB_OPERATION_STALE',
        );
        this.store.run(
          "UPDATE web_external_attempts SET dispatch_state='unknown' WHERE operation_id=? AND dispatch_state='sent'",
          fence.operationId,
        );
        return { status: 'unknown' as const };
      }
      // No sent attempt exists. Part 43: a stage that provably never crossed the send gate goes back to the queue (bounded,
      // within the operation's deadline) instead of failing the player's reply; anything else terminates as before.
      const requeued = this.requeueUnsent(fence, now);
      if (requeued) return requeued;
      return this.terminateInternal(coordinator, fence, fence.principalId, 'failed', 'recovered_unsent');
    });
  }

  /**
   * Part 43. PROVABLY UNSENT means: the running stage owns no attempt that is sent/unknown or known-failed, and every attempt
   * it does own is still `not_sent` (the call only starts after the `sent` mark commits, and that mark is fenced by the stage
   * lease, so a stale owner can never cross the gate afterwards) or a known success whose output is kept as is. Such a stage
   * releases its never-used local ticket and hold (once: the rows are deleted in the same transaction) and returns to the
   * queue; the next claim reserves again exactly like a first attempt. Returns null when the stage must fail as before
   * (deadline passed, bound used up, a rewound/failed attempt, no running segment).
   */
  private requeueUnsent(fence: WebOperationFence, now: number) {
    const schema = this.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? -1;
    const stage: Stage = fence.status === 'text_running' ? 'text' : 'audio';
    const op = this.store.get<{ deadline_at: number }>(
      `SELECT deadline_at FROM web_operations WHERE id=? AND quota_state='reserved' AND deadline_at>?
      AND principal_id=? AND world_id=? AND conversation_id=? AND character_id=? AND input_message_id=?`,
      fence.operationId,
      now,
      fence.principalId,
      fence.worldId,
      fence.conversationId,
      fence.characterId,
      fence.inputMessageId,
    );
    if (!op) return null;
    const used =
      this.store.get<{ n: number }>(
        'SELECT count(*) n FROM web_stage_attempts WHERE operation_id=? AND stage=?',
        fence.operationId,
        stage,
      )?.n ?? 0;
    if (used >= WEB_REQUEUE_LIMIT) return null;
    const attempts = this.store.all<{
      phase: Phase;
      ordinal: number;
      provider: string;
      dispatch_state: string;
      outcome: string | null;
    }>(
      'SELECT phase,ordinal,provider,dispatch_state,outcome FROM web_external_attempts WHERE operation_id=? AND stage=?',
      fence.operationId,
      stage,
    );
    if (
      !attempts.every(
        (a) =>
          a.dispatch_state === 'not_sent' ||
          (a.dispatch_state === 'known' && (a.outcome === 'succeeded' || a.outcome === 'not_dispatched')),
      )
    )
      return null;
    const unsent = attempts.filter((a) => a.dispatch_state === 'not_sent');
    const hasProviderTables = schema >= 113;
    if (hasProviderTables) {
      const provider = this.store.all<{ phase: Phase; ordinal: number; state: string; outcome: string | null }>(
        `SELECT phase,ordinal,state,outcome FROM web_provider_attempts WHERE operation_id=?
        AND phase IN (${stage === 'text' ? "'draft','review'" : "'speech'"})`,
        fence.operationId,
      );
      if (!provider.every((a) => a.state === 'not_sent' || (a.state === 'known' && a.outcome === 'succeeded')))
        return null;
      // A 429-rewound attempt keeps its reservation by design (rejectForRetry); it is not this path's to release.
      if (
        this.store.get(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_attempt_rejections'`) &&
        this.store.get('SELECT 1 FROM web_attempt_rejections WHERE operation_id=?', fence.operationId)
      )
        return null;
      for (const p of provider.filter((a) => a.state === 'not_sent'))
        if (!unsent.some((a) => a.phase === p.phase && a.ordinal === p.ordinal)) return null;
    }
    let segmentTable: string | null = null;
    if (stage === 'audio') {
      segmentTable =
        schema >= 113 ? 'web_provider_voice_segments' : schema >= 105 ? 'web_synthetic_voice_segments' : null;
      if (
        !segmentTable ||
        !this.store.get(
          `SELECT 1 FROM ${segmentTable} WHERE operation_id=? AND state='running' AND claim_stage_version=?
          AND claim_epoch IS ? AND claim_token IS ?`,
          fence.operationId,
          fence.stageVersion,
          fence.leaseEpoch,
          fence.leaseToken,
        )
      )
        return null;
    }
    // A known success only counts as "already done" while its output is kept; a late receipt that settled cost without
    // keeping bytes (stale owner) means the call WAS made, so such a stage is never re-sent.
    for (const a of attempts.filter((x) => x.dispatch_state === 'known' && x.outcome === 'succeeded')) {
      const kept =
        stage === 'text'
          ? this.store.get(
              `SELECT 1 FROM ${schema >= 113 ? 'web_provider_outputs' : 'web_local_text_outputs'} WHERE operation_id=? AND phase=?`,
              fence.operationId,
              a.phase,
            )
          : this.store.get(
              `SELECT 1 FROM ${schema >= 113 ? 'web_provider_outputs' : 'web_local_audio_outputs'} WHERE operation_id=? AND ordinal=?`,
              fence.operationId,
              a.ordinal,
            );
      if (!kept) return null;
    }
    if (stage === 'audio') {
      const running = this.store.get<{ ordinal: number }>(
        `SELECT ordinal FROM ${segmentTable} WHERE operation_id=? AND state='running' AND claim_stage_version=?`,
        fence.operationId,
        fence.stageVersion,
      );
      // The running clip itself must own no settled attempt: a known one means it was sent.
      if (!running || attempts.some((x) => x.ordinal === running.ordinal && x.dispatch_state !== 'not_sent'))
        return null;
    }
    for (const a of unsent) {
      if (hasProviderTables) {
        const held = this.store.get<{ provider: string; held_micros: number }>(
          `SELECT provider,held_micros FROM web_provider_attempts
          WHERE operation_id=? AND phase=? AND ordinal=? AND state='not_sent'`,
          fence.operationId,
          a.phase,
          a.ordinal,
        );
        ensure(held, 'WEB_PROVIDER_ATTEMPT_STALE');
        ensure(
          this.store.run(
            'UPDATE web_provider_spending SET held_micros=held_micros-? WHERE provider=? AND held_micros>=?',
            held.held_micros,
            held.provider,
            held.held_micros,
          ).changes === 1 &&
            this.store.run(
              `DELETE FROM web_provider_attempts WHERE operation_id=? AND phase=? AND ordinal=? AND state='not_sent'`,
              fence.operationId,
              a.phase,
              a.ordinal,
            ).changes === 1,
          'WEB_PROVIDER_BUDGET_CONFLICT',
        );
      }
      // The ticket row stays as an audit record (known, not dispatched); reserve() resets it for the next claim.
      ensure(
        this.store.run(
          `UPDATE web_external_attempts SET dispatch_state='known',outcome='not_dispatched',settled_at=?
          WHERE operation_id=? AND stage=? AND phase=? AND ordinal=? AND dispatch_state='not_sent'`,
          now,
          fence.operationId,
          stage,
          a.phase,
          a.ordinal,
        ).changes === 1,
        'WEB_DISPATCH_STALE',
      );
      this.releaseBudget({
        operationId: fence.operationId,
        stage,
        phase: a.phase,
        ordinal: a.ordinal,
        provider: a.provider,
        dispatch_state: 'not_sent',
        outcome: null,
        receipt_json: null,
        usage_json: null,
      });
    }
    this.store.run(
      `INSERT INTO web_stage_attempts(operation_id,stage,attempt,dispatch_state,provider_request_id,created_at)
      VALUES (?,?,?,'not_sent',?,?)`,
      fence.operationId,
      stage,
      used + 1,
      unsent[0] ? `requeue:${unsent[0].phase}:${unsent[0].ordinal}` : `requeue:${stage}`,
      now,
    );
    if (stage === 'text') {
      ensure(
        this.store.run(
          `UPDATE web_operations SET status='queued',stage_version=stage_version+1,text_queued_at=?,
          lease_epoch=NULL,lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL
          WHERE id=? AND status='text_running' AND stage_version=? AND lease_epoch IS ? AND lease_token IS ?`,
          now,
          fence.operationId,
          fence.stageVersion,
          fence.leaseEpoch,
          fence.leaseToken,
        ).changes === 1,
        'WEB_OPERATION_STALE',
      );
      return { status: 'queued' as const, requeued: true as const };
    }
    ensure(
      this.store.run(
        `UPDATE ${segmentTable} SET state='pending',claim_stage_version=NULL,claim_epoch=NULL,claim_token=NULL
        WHERE operation_id=? AND state='running' AND claim_stage_version=?`,
        fence.operationId,
        fence.stageVersion,
      ).changes === 1,
      'WEB_VOICE_SEGMENT_STALE',
    );
    ensure(
      this.store.run(
        `UPDATE web_operations SET status='audio_pending',stage_version=stage_version+1,audio_wait_started_at=?,
        lease_epoch=NULL,lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL
        WHERE id=? AND status='audio_running' AND stage_version=? AND lease_epoch IS ? AND lease_token IS ?`,
        now,
        fence.operationId,
        fence.stageVersion,
        fence.leaseEpoch,
        fence.leaseToken,
      ).changes === 1,
      'WEB_OPERATION_STALE',
    );
    return { status: 'audio_pending' as const, requeued: true as const };
  }

  private liveClaim(claim: WebStageClaim, now: number) {
    const coordinator = this.store.get<{ epoch: number; coordinator_expires_at: number }>(
      'SELECT epoch,coordinator_expires_at FROM web_scheduler_state WHERE singleton=1',
    );
    ensure(coordinator?.epoch === claim.epoch && coordinator.coordinator_expires_at > now, 'WEB_COORDINATOR_STALE');
    const row = this.store.get<{ id: string }>(
      `SELECT id FROM web_operations WHERE id=? AND status=?
      AND stage_version=? AND lease_epoch=? AND lease_token=? AND lease_owner=? AND lease_expires_at>?
      AND deadline_at>? AND principal_id=? AND world_id=? AND conversation_id=? AND character_id=?
      AND input_message_id=? AND quota_state='reserved'`,
      claim.operationId,
      claim.stage === 'text' ? 'text_running' : 'audio_running',
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
    );
    ensure(row, 'WEB_STAGE_STALE');
  }

  private currentInput(claim: WebStageClaim) {
    requireCurrentInputSnapshot(this.store, {
      operation_id: claim.operationId,
      principal_id: claim.principalId,
      world_id: claim.worldId,
      conversation_id: claim.conversationId,
      character_id: claim.characterId,
      input_message_id: claim.inputMessageId,
    });
  }

  private attempt(key: AttemptKey): AttemptRow | undefined {
    const row = this.store.get<{
      operation_id: string;
      stage: Stage;
      phase: Phase;
      ordinal: number;
      provider: string;
      dispatch_state: AttemptRow['dispatch_state'];
      outcome: string | null;
      receipt_json: string | null;
      usage_json: string | null;
      receipt_digest?: string | null;
      usage_digest?: string | null;
    }>(
      'SELECT * FROM web_external_attempts WHERE operation_id=? AND stage=? AND phase=? AND ordinal=?',
      key.operationId,
      key.stage,
      key.phase,
      key.ordinal,
    );
    return (
      row && {
        operationId: row.operation_id,
        stage: row.stage,
        phase: row.phase,
        ordinal: row.ordinal,
        provider: row.provider,
        dispatch_state: row.dispatch_state,
        outcome: row.outcome,
        receipt_json: row.receipt_json,
        usage_json: row.usage_json,
        receipt_digest: row.receipt_digest,
        usage_digest: row.usage_digest,
      }
    );
  }

  private releaseBudget(row: AttemptRow) {
    ensure(
      this.store.run(
        `UPDATE web_external_budgets SET reserved=reserved-1
      WHERE provider=? AND stage=? AND phase=? AND reserved>0`,
        row.provider,
        row.stage,
        row.phase,
      ).changes === 1,
      'WEB_EXTERNAL_BUDGET_INVALID',
    );
  }

  private closeOpenAttempts(operationId: string, now: number) {
    const rows = this.store.all<{
      operation_id: string;
      stage: Stage;
      phase: Phase;
      ordinal: number;
      provider: string;
      dispatch_state: AttemptRow['dispatch_state'];
    }>(
      "SELECT * FROM web_external_attempts WHERE operation_id=? AND dispatch_state IN ('not_sent','sent')",
      operationId,
    );
    for (const row of rows) {
      if (row.dispatch_state === 'sent') {
        this.store.run(
          "UPDATE web_external_attempts SET dispatch_state='unknown' WHERE operation_id=? AND stage=? AND phase=? AND ordinal=?",
          operationId,
          row.stage,
          row.phase,
          row.ordinal,
        );
      } else {
        this.store.run(
          `UPDATE web_external_attempts SET dispatch_state='known',outcome='not_dispatched',settled_at=?
          WHERE operation_id=? AND stage=? AND phase=? AND ordinal=?`,
          now,
          operationId,
          row.stage,
          row.phase,
          row.ordinal,
        );
        this.releaseBudget({
          operationId,
          stage: row.stage,
          phase: row.phase,
          ordinal: row.ordinal,
          provider: row.provider,
          dispatch_state: row.dispatch_state,
          outcome: null,
          receipt_json: null,
          usage_json: null,
        });
      }
    }
  }
}

function validPhase(stage: Stage, phase: Phase, ordinal: number) {
  return stage === 'text'
    ? (phase === 'draft' || phase === 'review') && ordinal === -1
    : phase === 'speech' && Number.isSafeInteger(ordinal) && ordinal >= 0;
}

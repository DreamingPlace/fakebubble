import { randomUUID } from 'node:crypto';
import type { Clock } from '../../../packages/contracts/index.ts';
import { WEB_LIMITS } from '../../../config/web-v1.ts';
import { webConcurrency } from '../../../config/web-concurrency.ts';
import { DomainError, ensure } from '../../../packages/domain/errors.ts';
import type { BusinessStore as Store } from '../platform/store-contract.ts';
import { requireWebRuntime, type WebRuntimeStore as WebStore } from '../platform/web-store-contract.ts';
import { WebStageQueue, type WebCoordinatorLease, type WebStageClaim } from '../admission/web-stage-queue.ts';
import { WebDispatchLedger } from '../budget/web-dispatch-ledger.ts';
import { WebVerticalPublisher } from '../conversation/web-vertical-publisher.ts';
import { WebProviderRunner } from './web-provider-runner.ts';
import { fallbackRequested, metricsEnabled } from '../admission/web-stage-metrics.ts';
import { WebProviderOffline } from './web-provider-offline.ts';

/** Separate schema113 scheduler. No synthetic output, default budget or footer is installed. */
export class WebProviderExecutor {
  private readonly store: Store;
  private readonly clock: Clock;
  private readonly runner: WebProviderRunner;
  private readonly queue: WebStageQueue;
  private readonly ledger: WebDispatchLedger;
  private readonly publisher: WebVerticalPublisher;
  private coordinator: WebCoordinatorLease | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly controllers = new Set<AbortController>();
  private readonly tasks = new Set<Promise<void>>();
  private readonly publishing = new Set<string>();
  private readonly falling = new Set<string>();
  private managed = false;
  private readonly activity: { hold(task: Promise<void>): void; settled(): Promise<void> } | undefined;
  lastError: string | null = null;

  constructor(
    store: Store,
    clock: Clock,
    runner: WebProviderRunner,
    activity?: { hold(task: Promise<void>): void; settled(): Promise<void> },
  ) {
    requireWebRuntime(store, 'provider');
    ensure(
      (store.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? -1) >= 113,
      'WEB_PROVIDER_RUNTIME_NOT_AUTHORIZED',
    );
    this.store = store;
    this.clock = clock;
    this.runner = runner;
    this.activity = activity;
    this.queue = new WebStageQueue(store as WebStore, clock, randomUUID);
    this.ledger = new WebDispatchLedger(store as WebStore, clock);
    this.publisher = new WebVerticalPublisher(store as WebStore, clock);
  }

  private acquire(owner: string, configured = true) {
    ensure(!this.coordinator, 'WEB_COORDINATOR_BUSY');
    // A missing or expired bound is a closed gate, never an implicit free provider.
    if (configured)
      for (const [provider, stage, phase] of [
        ['deepseek', 'text', 'draft'],
        ['deepseek', 'text', 'review'],
        ['fish', 'audio', 'speech'],
      ] as const) {
        ensure(
          this.store.get(
            `SELECT 1 FROM web_external_budgets WHERE provider=? AND stage=?
        AND phase=? AND capacity>0`,
            provider,
            stage,
            phase,
          ) &&
            this.store.get(`SELECT 1 FROM web_provider_spending WHERE provider=? AND limit_micros>0`, provider) &&
            this.store.get(
              `SELECT 1 FROM web_provider_prices WHERE provider=? AND phase=?
          AND valid_from<=? AND valid_until>?`,
              provider,
              phase,
              this.clock.now(),
              this.clock.now(),
            ),
          'WEB_PROVIDER_NOT_CONFIGURED',
        );
      }
    if (configured) {
      const limits = webConcurrency(this.store);
      for (const [provider, stage, phase, capacity] of [
        ['deepseek', 'text', 'draft', limits.maxTextRunning],
        ['deepseek', 'text', 'review', limits.maxTextRunning],
        ['fish', 'audio', 'speech', limits.maxAudioRunning],
      ] as const)
        this.ledger.alignBudget({ provider, stage, phase, capacity });
    }
    this.coordinator = this.queue.acquireCoordinator(owner);
  }

  start() {
    ensure(!this.managed, 'WEB_COORDINATOR_BUSY');
    this.acquire(`provider-${process.pid}`);
    try {
      this.pump();
    } catch (error) {
      this.stop();
      throw error;
    }
    this.timer = setInterval(() => {
      try {
        this.pump();
      } catch (error) {
        this.error(error);
      }
    }, 25);
    this.timer.unref();
  }

  /** Bounded scheduling only. The DO holds task promises; persistent alarms renew the coordinator. */
  managedPass(owner: string) {
    ensure(!this.timer && this.activity, 'WEB_MANAGED_EXECUTOR_REQUIRED');
    this.managed = true;
    if (!this.coordinator) {
      ensure(this.tasks.size === 0, 'WEB_COORDINATOR_BUSY');
      // Recovery/expiry still run without available prices. Paid stages enforce their own gates.
      this.acquire(owner, false);
    }
    try {
      this.lastError = null;
      const limits = webConcurrency(this.store);
      for (let i = 0; i < Math.max(limits.maxTextRunning, limits.maxAudioRunning); i++) this.pump();
    } catch (error) {
      this.error(error);
      if (error instanceof DomainError && error.code === 'WEB_COORDINATOR_STALE') this.stop();
    } finally {
      if (this.tasks.size === 0) this.stop();
    }
  }
  get managedHeartbeat() {
    return this.coordinator ? this.coordinator.expiresAt - WEB_LIMITS.coordinatorLeaseMs / 3 : null;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const controller of this.controllers) controller.abort();
    if (this.coordinator) {
      try {
        this.queue.releaseCoordinator(this.coordinator);
      } catch {
        /* A newer coordinator owns the lease. */
      }
    }
    this.coordinator = null;
  }

  async close() {
    this.stop();
    // Aborted transports may still persist a receipt/UNKNOWN in their finally path.
    // The owning service must not close either ledger until these writers have drained.
    await Promise.allSettled([...this.tasks]);
  }

  cancel(operationId: string, principalId: string) {
    ensure(this.coordinator, 'WEB_COORDINATOR_STALE');
    const fence = this.ledger.fence(operationId);
    ensure(fence.principalId === principalId, 'WEB_OPERATION_NOT_FOUND');
    return this.ledger.terminate(this.coordinator, fence, principalId, 'cancelled', 'cancel');
  }

  cancelManaged(operationId: string, principalId: string) {
    ensure(this.activity && !this.timer, 'WEB_MANAGED_EXECUTOR_REQUIRED');
    const idle = !this.coordinator;
    if (idle) this.acquire('web-cloud-cancel', false);
    try {
      return this.cancel(operationId, principalId);
    } finally {
      if (idle) this.stop();
    }
  }

  private error(error: unknown) {
    this.lastError = error instanceof DomainError ? error.code : 'INTERNAL_ERROR';
  }

  private schedule(claim: WebStageClaim) {
    const controller = new AbortController();
    this.controllers.add(controller);
    const task = (
      claim.stage === 'text'
        ? this.runner.runText(claim, controller.signal)
        : this.runner.runSpeech(claim, controller.signal)
    ).then(() => {});
    const timeout = this.managed
      ? setTimeout(() => controller.abort(), Math.max(1, claim.leaseExpiresAt - this.clock.now()))
      : undefined;
    this.track(task, () => {
      if (timeout) clearTimeout(timeout);
      this.controllers.delete(controller);
    });
  }

  private track(task: Promise<void>, cleanup: () => void) {
    const tracked = task
      .catch((error) => this.error(error))
      .finally(async () => {
        this.tasks.delete(tracked);
        cleanup();
        if (this.managed && this.tasks.size === 0) this.stop();
        try {
          await this.activity?.settled();
        } catch (error) {
          this.error(error);
        } // The pre-persisted alarm remains the crash watchdog.
      });
    this.tasks.add(tracked);
    this.activity?.hold(tracked);
  }

  private renew() {
    ensure(this.coordinator, 'WEB_COORDINATOR_STALE');
    if (this.coordinator.expiresAt - this.clock.now() < WEB_LIMITS.coordinatorLeaseMs / 2)
      this.coordinator = this.queue.renewCoordinator(this.coordinator);
  }

  private publish(lease: WebCoordinatorLease, operationId: string) {
    if (this.publishing.has(operationId)) return;
    this.publishing.add(operationId);
    const task = this.runner.publishAsync(lease, operationId).then(() => {});
    this.track(task, () => this.publishing.delete(operationId));
  }

  private offlineLedger: WebProviderOffline | undefined;
  private offline() {
    return (this.offlineLedger ??= new WebProviderOffline(this.store, this.clock));
  }

  /** Voice gave up (no audio slot in time, or HTTP 429 retries used up): publish the reviewed text as text. */
  private fallback(lease: WebCoordinatorLease, operationId: string, decide: boolean) {
    if (this.falling.has(operationId)) return;
    this.falling.add(operationId);
    const task = (async () => {
      if (decide) await this.runner.beginTextFallback(operationId);
      await this.runner.publishTextFallback(lease, operationId);
    })();
    this.track(
      task.then(() => {}),
      () => this.falling.delete(operationId),
    );
  }

  /** Bounded pass; all provider calls are scheduled outside SQLite transactions. */
  pump() {
    ensure(this.coordinator, 'WEB_COORDINATOR_STALE');
    this.renew();
    const lease = this.coordinator;
    for (const row of this.store.all<{ id: string; status: string }>(
      `SELECT id,status FROM web_operations
      WHERE status IN ('text_running','audio_running','ready_to_publish')
        AND (lease_epoch<>? OR lease_expires_at<=?) LIMIT 16`,
      lease.epoch,
      this.clock.now(),
    )) {
      try {
        if (row.status === 'ready_to_publish') this.publisher.recover(lease, row.id);
        else if (row.status === 'text_running') {
          try {
            this.schedule(this.queue.resumeKnownText(lease, row.id, 'provider-text-resume'));
          } catch {
            this.ledger.recover(lease, this.ledger.fence(row.id));
          }
        } else this.ledger.recover(lease, this.ledger.fence(row.id));
      } catch (error) {
        this.error(error);
      }
    }
    if (metricsEnabled(this.store)) {
      // Decided earlier (audio_wait or rate_limited) and not yet published; survives a restart because it is durable.
      for (const row of this.store.all<{ id: string }>(
        `SELECT o.id FROM web_operations o JOIN web_operation_metrics m ON m.operation_id=o.id
        WHERE m.fallback_reason IS NOT NULL AND m.fallback_used=0 AND o.status IN ('text_ready','audio_pending')
          AND o.quota_state='reserved' AND o.audio_wait_started_at IS NULL AND o.deadline_at>? LIMIT 16`,
        this.clock.now(),
      )) {
        try {
          this.fallback(lease, row.id, false);
        } catch (error) {
          this.error(error);
        }
      }
      for (const id of this.offline().fallbackDue(this.clock.now())) {
        try {
          this.fallback(lease, id, true);
        } catch (error) {
          this.error(error);
        }
      }
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
      try {
        const fence = this.ledger.fence(row.id);
        this.ledger.terminate(lease, fence, fence.principalId, 'failed', 'expired');
      } catch (error) {
        this.error(error);
      }
    }
    const text = this.queue.claimText(lease, 'provider-text');
    if (text) this.schedule(text);
    const audio = this.queue.claimAudio(lease, 'provider-audio');
    if (audio) this.schedule(audio);
    for (const row of this.store.all<{ id: string }>(
      `SELECT id FROM web_operations WHERE
      status='audio_pending' AND audio_wait_started_at IS NULL AND quota_state='reserved'
      ${metricsEnabled(this.store) ? 'AND NOT EXISTS (SELECT 1 FROM web_operation_metrics m WHERE m.operation_id=id AND m.fallback_reason IS NOT NULL)' : ''}
      AND deadline_at>? LIMIT 16`,
      this.clock.now(),
    )) {
      try {
        this.publish(lease, row.id);
      } catch (error) {
        this.error(error);
      }
    }
  }
}

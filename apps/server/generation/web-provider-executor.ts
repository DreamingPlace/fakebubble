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
import { audioStartedExpr, fallbackRequested, metricsEnabled } from '../admission/web-stage-metrics.ts';
import { WebProviderOffline } from './web-provider-offline.ts';
import { INDEX_IDLE_MS, type IndexBatch, type QueryClaim } from './web-embed-ledger.ts';
import type { QueryVector } from './web-embed-runner.ts';
import { logWebReply } from './web-reply-telemetry.ts';
import { healLegacyUnknownTickets } from '../budget/web-external-tickets.ts';

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
  /**
   * Telemetry only. Operations in flight that have not yet been reported as finished, and the ones already reported (so an
   * UNKNOWN reply that later expires is not reported a second time). A restart forgets both, and starts again from what is
   * in flight when the new executor first looks (see `reportFinished`).
   */
  private readonly unreported = new Set<string>();
  private readonly reported = new Set<string>();
  private managed = false;
  /** Indexing scans every scope, so an idle pass is not repeated for INDEX_IDLE_MS unless a publication committed. */
  private indexDirty = true;
  private indexScanAt = 0;
  private indexPausedUntil = 0;
  /** Query embeddings waiting for their operation's claim; in memory only (see WebStageQueue). */
  private readonly queryVectors = new Map<string, QueryVector>();
  private readonly activity: { hold(task: Promise<void>): void; settled(): Promise<void> } | undefined;
  /**
   * Part 54: where each running stage gets its OWN request context. Cloudflare limits one invocation to 6 simultaneous outbound
   * connections, and the alarm used to start up to 20 text + 4 voice stages inside ONE invocation. With a dispatcher, the alarm only
   * ANSWERS "start this stage" with a short call that returns at once, and the stage runs in the invocation that call opened
   * (see startLaunched). Without one (local transport, tests) a stage runs where it was scheduled, as before.
   */
  private readonly dispatch: ((launchId: string) => Promise<unknown>) | undefined;
  private readonly launches = new Map<string, () => Promise<void>>();
  lastError: string | null = null;

  constructor(
    store: Store,
    clock: Clock,
    runner: WebProviderRunner,
    activity?: { hold(task: Promise<void>): void; settled(): Promise<void> },
    dispatch?: (launchId: string) => Promise<unknown>,
  ) {
    this.dispatch = dispatch;
    requireWebRuntime(store, 'provider');
    ensure(
      (store.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? -1) >= 113,
      'WEB_PROVIDER_RUNTIME_NOT_AUTHORIZED',
    );
    this.store = store;
    this.clock = clock;
    this.runner = runner;
    this.activity = activity;
    this.queue = new WebStageQueue(store as WebStore, clock, randomUUID, this.queryVectors);
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
        ['xai', 'text', 'draft', limits.maxTextRunning],
        ['gemini', 'text', 'draft', limits.maxTextRunning],
        ['gemini', 'text', 'review', limits.maxTextRunning],
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
      this.reportFinished();
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

  /**
   * One telemetry line per reply that reaches published / failed / unknown, WHICHEVER path got it there: a scheduled stage, a
   * publication, the voice-to-text fallback, a backup model, a recovery pass after the object restarted, an expiry, a
   * cancellation. It does not depend on which task finished: every operation still in flight is tracked on each look, and
   * logged exactly once when it is found in a final state (a replay of the same state logs nothing). Cancelled is not a reply.
   */
  private reportFinished() {
    try {
      for (const row of this.store.all<{ id: string }>(
        "SELECT id FROM web_operations WHERE status NOT IN ('published','cancelled','failed','unknown') LIMIT 500",
      ))
        if (!this.reported.has(row.id)) this.unreported.add(row.id);
    } catch {
      /* telemetry never affects a reply */
    }
    for (const id of [...this.unreported]) {
      let status: string | undefined;
      try {
        status = this.store.get<{ status: string }>('SELECT status FROM web_operations WHERE id=?', id)?.status;
      } catch {
        continue;
      }
      if (status === undefined)
        this.unreported.delete(id); // purged before it finished
      else if (!['published', 'cancelled', 'failed', 'unknown'].includes(status)) continue;
      else {
        this.unreported.delete(id);
        if (status !== 'cancelled' && !this.reported.has(id)) {
          logWebReply(this.store, id, this.clock.now());
          if (this.reported.size >= 5000) this.reported.clear();
          this.reported.add(id);
        }
      }
    }
  }

  private schedule(claim: WebStageClaim) {
    this.unreported.add(claim.operationId);
    const controller = new AbortController();
    this.controllers.add(controller);
    const body = () =>
      (claim.stage === 'text'
        ? this.runner.runText(claim, controller.signal)
        : this.runner.runSpeech(claim, controller.signal)
      ).then(() => {});
    const task = this.dispatch ? this.launch(`${claim.operationId}:${claim.stageVersion}`, body) : body();
    const timeout = this.managed
      ? setTimeout(() => controller.abort(), Math.max(1, claim.leaseExpiresAt - this.clock.now()))
      : undefined;
    this.track(task, () => {
      if (timeout) clearTimeout(timeout);
      this.controllers.delete(controller);
    });
  }

  /**
   * Hand a stage to its own request context. The stage's work is parked under `launchId`; the dispatcher's short call lands in
   * startLaunched, which starts it there. If the call cannot be made the stage starts here instead (it is never lost).
   */
  private launch(launchId: string, body: () => Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.launches.set(launchId, () => body().then(resolve, reject));
      // A stage is never lost: if the dispatch fails, answers "not started", or has not started it within 5 s, it runs here.
      const here = () => {
        const run = this.launches.get(launchId);
        this.launches.delete(launchId);
        run?.();
      };
      const timer = setTimeout(here, 5_000);
      this.dispatch!(launchId).then(
        (started) => {
          if (started === false) {
            clearTimeout(timer);
            here();
          } else if (started === true) clearTimeout(timer);
        },
        () => {
          clearTimeout(timer);
          here();
        },
      );
    });
  }

  /** Called by the dispatched invocation: starts the parked stage and returns the promise that holds that invocation open. */
  startLaunched(launchId: string): Promise<void> | null {
    const run = this.launches.get(launchId);
    if (!run) return null;
    this.launches.delete(launchId);
    return run();
  }

  private track(task: Promise<void>, cleanup: () => void) {
    const tracked = task
      .catch((error) => this.error(error))
      .finally(async () => {
        this.tasks.delete(tracked);
        cleanup();
        this.reportFinished();
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
    this.unreported.add(operationId);
    // The publication committed: its memory topics may now need an embedding (never done inside that transaction).
    const task = this.runner.publishAsync(lease, operationId).then(() => {
      this.indexDirty = true;
    });
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
      this.indexDirty = true;
    })();
    this.track(
      task.then(() => {}),
      () => this.falling.delete(operationId),
    );
  }

  /**
   * Embedding work of one scheduler pass. First the reply-time query embeddings: an operation that is still queued and
   * whose scope has vectors gets ONE embedding call, and its claim waits for it (see the claim's gate) so the request is
   * frozen with the final recall result; a failed, timed-out or UNKNOWN call frees the operation to continue with lexical
   * recall, and nothing is retried. Then memory indexing, claimed after publications have committed. Claims (money
   * held, call recorded) are short transactions; the provider calls run outside them as tracked tasks under the stage
   * coordinator like text and audio. No failure here can fail or hold back a reply beyond the query timeout.
   */
  private embedPass() {
    const embed = this.runner.embedding;
    if (!embed) return;
    try {
      embed.ledger.recover();
      if (!embed.ready()) return;
      const now = this.clock.now();
      for (const [id, vector] of this.queryVectors) if (now - vector.at > 60_000) this.queryVectors.delete(id);
      for (const id of embed.ledger.queryCandidates(embed.config.maxEmbedRunning)) {
        const claim = embed.ledger.claimQuery(id, embed.config.maxEmbedRunning, embed.config.queryTimeoutMs);
        if (claim) this.embedQuery(claim);
      }
    } catch (error) {
      this.error(error);
    }
    try {
      const now = this.clock.now();
      if (now < this.indexPausedUntil || (!this.indexDirty && now < this.indexScanAt)) return;
      for (let i = 0; i < embed.config.maxEmbedRunning; i++) {
        const batch = embed.ledger.claimIndexBatch(embed.config.maxEmbedRunning);
        if (batch === 'busy') return;
        if (batch === null) {
          this.indexDirty = false;
          this.indexScanAt = now + INDEX_IDLE_MS;
          return;
        }
        this.index(batch);
      }
    } catch (error) {
      // An exhausted allowance or any claim failure pauses indexing; replies and everything else are unaffected.
      this.indexPausedUntil = this.clock.now() + 60_000;
      this.error(error);
    }
  }

  private embedQuery(claim: QueryClaim) {
    const embed = this.runner.embedding!;
    const controller = new AbortController();
    this.controllers.add(controller);
    const task = embed.query(claim, controller.signal).then((vector) => {
      if (vector) this.queryVectors.set(claim.operationId, vector);
    });
    this.track(task, () => this.controllers.delete(controller));
  }

  private index(batch: IndexBatch) {
    const embed = this.runner.embedding!;
    const controller = new AbortController();
    this.controllers.add(controller);
    const task = embed.index(batch, controller.signal).then(() => {
      this.indexDirty = true;
    });
    this.track(task, () => this.controllers.delete(controller));
  }

  /** Bounded pass; all provider calls are scheduled outside SQLite transactions. */
  pump() {
    ensure(this.coordinator, 'WEB_COORDINATOR_STALE');
    this.renew();
    const lease = this.coordinator;
    // Everything in flight is known before this pass recovers, resumes or expires anything, so whatever it finishes is reported.
    this.reportFinished();
    // Part 54: self-healing. A legacy UNKNOWN call still holds a running-slot ticket (its money stays held), and a legacy
    // 'unknown' reply still holds its player's slot until its deadline: free the first and end the second now.
    try {
      healLegacyUnknownTickets(this.store);
      for (const row of this.store.all<{ id: string }>("SELECT id FROM web_operations WHERE status='unknown' LIMIT 16")) {
        const fence = this.ledger.fence(row.id);
        this.ledger.terminate(lease, fence, fence.principalId, 'failed', 'unconfirmed');
      }
    } catch (error) {
      this.error(error);
    }
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
    for (const row of this.store.all<{ id: string; status: string }>(
      `SELECT id,status FROM web_operations WHERE
      status NOT IN ('published','cancelled','failed') AND
      (deadline_at<=? OR status='queued' AND text_queued_at+?<=? OR
        status IN ('text_ready','audio_pending') AND audio_wait_started_at IS NOT NULL AND
        audio_wait_used_ms+?-audio_wait_started_at>=? AND NOT (${audioStartedExpr(this.store, 'web_operations')})) LIMIT 16`,
      this.clock.now(),
      WEB_LIMITS.queueWaitMs,
      this.clock.now(),
      this.clock.now(),
      WEB_LIMITS.queueWaitMs,
    )) {
      try {
        const fence = this.ledger.fence(row.id);
        this.ledger.terminate(lease, fence, fence.principalId, 'failed', 'expired');
        // An UNKNOWN reply was reported when it became unknown; its expiry is the same reply, not a second one.
        if (row.status !== 'unknown') this.unreported.add(row.id);
      } catch (error) {
        this.error(error);
      }
    }
    this.embedPass();
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
    this.reportFinished();
  }
}

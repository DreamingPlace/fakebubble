import { WebCharacterDeletion } from '../characters/web-character-deletion.ts';
import { WebCharacterPreviewExecutor } from '../characters/web-character-preview-executor.ts';
import type { WebCharacterPreviewRunner } from '../characters/web-character-preview-runner.ts';
import type { Clock } from '../../../packages/contracts/index.ts';
import type { WebRuntimeStore } from '../platform/web-store-contract.ts';
import type { WebProviderRunner } from '../generation/web-provider-runner.ts';
import { WebProviderExecutor } from '../generation/web-provider-executor.ts';
import { WEB_LIMITS } from '../../../config/web-v1.ts';
import { webConcurrency } from '../../../config/web-concurrency.ts';
import { audioStartedSql, metricsEnabled } from '../admission/web-stage-metrics.ts';
import { DomainError } from '../../../packages/domain/errors.ts';
import { CloudQueueAlarm, type AlarmStorage } from './queue-alarm.ts';

/** A deadline for uncertain work is a classification wake, never a permission to resend it. */
export function webProviderNextDue(store: WebRuntimeStore, now: number, ownsCoordinator = false): number | null {
  const operations = store.all<{
    id: string;
    status: string;
    deadline_at: number;
    text_queued_at: number;
    audio_wait_started_at: number | null;
    audio_wait_used_ms: number | null;
  }>("SELECT * FROM web_operations WHERE status NOT IN ('published','cancelled','failed')");
  if (!operations.length) return null;
  const fallbackWaitMs = metricsEnabled(store) ? webConcurrency(store).audioFallbackWaitMs : null;
  // Operations that already started audio are exempt from the wait fallback, so it never schedules a wake for them.
  const audioStarted = new Set(
    fallbackWaitMs === null
      ? []
      : store
          .all<{ id: string }>(
            `SELECT o.id FROM web_operations o WHERE o.status IN ('text_ready','audio_pending') AND ${audioStartedSql('o')}`,
          )
          .map((row) => row.id),
  );
  const coordinatorUntil = store.get<{ coordinator_expires_at: number }>(
    'SELECT coordinator_expires_at FROM web_scheduler_state WHERE singleton=1',
  )!.coordinator_expires_at;
  return Math.max(
    now,
    Math.min(
      ...operations.map((row) => {
        const queueDeadline =
          row.status === 'queued'
            ? row.text_queued_at + WEB_LIMITS.queueWaitMs
            : ['text_ready', 'audio_pending'].includes(row.status) && row.audio_wait_started_at !== null
              ? row.audio_wait_started_at + WEB_LIMITS.queueWaitMs - (row.audio_wait_used_ms ?? 0)
              : Infinity;
        const work = [
          'queued',
          'text_running',
          'text_ready',
          'audio_pending',
          'audio_running',
          'ready_to_publish',
        ].includes(row.status);
        const ready = ['queued', 'text_ready', 'audio_pending'].includes(row.status);
        // A stage returned after an HTTP 429 becomes claimable only at its backoff end (text_queued_at or
        // audio_wait_started_at in the future); waiting for an audio slot ends in a text fallback after the wait.
        const readyAt =
          row.status === 'queued'
            ? row.text_queued_at
            : ['text_ready', 'audio_pending'].includes(row.status)
              ? (row.audio_wait_started_at ?? 0)
              : 0;
        const fallbackDue =
          fallbackWaitMs !== null &&
          !audioStarted.has(row.id) &&
          ['text_ready', 'audio_pending'].includes(row.status) &&
          row.audio_wait_started_at !== null
            ? Math.max(
                row.audio_wait_started_at,
                row.audio_wait_started_at + fallbackWaitMs - (row.audio_wait_used_ms ?? 0),
              )
            : Infinity;
        return Math.min(
          row.deadline_at,
          queueDeadline,
          fallbackDue,
          work ? (ownsCoordinator && ready ? Math.max(now, readyAt) : Math.max(now, coordinatorUntil)) : Infinity,
        );
      }),
    ),
  );
}

/** Shared business scheduler with persistent at-least-once wakes; no timer is started at construction. */
export class WebCloudExecutor {
  readonly executor: WebProviderExecutor;
  private readonly previews: WebCharacterPreviewExecutor | undefined;
  private readonly alarmQueue: CloudQueueAlarm;
  constructor(
    ctx: { storage: AlarmStorage; waitUntil(task: Promise<void>): void },
    store: WebRuntimeStore,
    clock: Clock,
    runner: WebProviderRunner,
    maintenanceDue?: () => number | null,
    previews?: WebCharacterPreviewRunner,
  ) {
    this.executor = new WebProviderExecutor(store, clock, runner, {
      hold: (task) => ctx.waitUntil(task),
      settled: () => this.alarmQueue.wake(),
    });
    if (previews)
      this.previews = new WebCharacterPreviewExecutor(previews, {
        hold: (task) => ctx.waitUntil(task),
        settled: () => this.alarmQueue.wake(),
      });
    const deletion = store.get("SELECT 1 FROM sqlite_master WHERE name='web_character_deletion_schema'")
      ? new WebCharacterDeletion(store, clock)
      : null;
    this.alarmQueue = new CloudQueueAlarm(
      ctx.storage,
      clock,
      async () => {
        await deletion?.sweep();
        this.previews?.kick();
        try {
          this.executor.managedPass(`web-cloud-${store.instanceId}`);
        } catch (error) {
          // A restarted object waits for the original coordinator, never steals its lease.
          if (!(error instanceof DomainError) || error.code !== 'WEB_COORDINATOR_BUSY') throw error;
        }
      },
      () => {
        const heartbeat = this.executor.managedHeartbeat;
        const due = webProviderNextDue(store, clock.now(), heartbeat !== null);
        const next = Math.min(
          due ?? Infinity,
          heartbeat ?? Infinity,
          maintenanceDue?.() ?? Infinity,
          this.previews?.nextDue() ?? Infinity,
          deletion?.nextDue() ?? Infinity,
        );
        return Number.isFinite(next) ? next : null;
      },
    );
  }
  wake() {
    return this.alarmQueue.wake();
  }
  alarm() {
    return this.alarmQueue.alarm();
  }
  async stop() {
    await this.alarmQueue.stop();
    await this.executor.close();
    await this.previews?.close();
  }
}

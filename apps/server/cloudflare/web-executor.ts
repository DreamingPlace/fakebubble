import { WebCharacterDeletion } from '../characters/web-character-deletion.ts';
import { WebCharacterPreviewExecutor } from '../characters/web-character-preview-executor.ts';
import type { WebCharacterPreviewRunner } from '../characters/web-character-preview-runner.ts';
import type { Clock } from '../../../packages/contracts/index.ts';
import type { WebRuntimeStore } from '../platform/web-store-contract.ts';
import type { WebProviderRunner } from '../generation/web-provider-runner.ts';
import { WebProviderExecutor } from '../generation/web-provider-executor.ts';
import { WEB_LIMITS } from '../../../config/web-v1.ts';
import { DomainError } from '../../../packages/domain/errors.ts';
import { CloudQueueAlarm, type AlarmStorage } from './queue-alarm.ts';

/** A deadline for uncertain work is a classification wake, never a permission to resend it. */
export function webProviderNextDue(store: WebRuntimeStore, now: number, ownsCoordinator = false): number | null {
  const operations = store.all<{
    status: string;
    deadline_at: number;
    text_queued_at: number;
    audio_wait_started_at: number | null;
    audio_wait_used_ms: number | null;
  }>("SELECT * FROM web_operations WHERE status NOT IN ('published','cancelled','failed')");
  if (!operations.length) return null;
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
        return Math.min(
          row.deadline_at,
          queueDeadline,
          work ? (ownsCoordinator && ready ? now : Math.max(now, coordinatorUntil)) : Infinity,
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

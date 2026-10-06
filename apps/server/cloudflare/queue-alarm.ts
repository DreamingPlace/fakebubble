import type { Clock } from '../../../packages/contracts/index.ts';
import type { BusinessStore } from '../platform/store-contract.ts';
import { ensure } from '../../../packages/domain/errors.ts';

export interface AlarmStorage {
  getAlarm(): Promise<number | null>;
  setAlarm(at: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}
/** One persistent DO alarm. Replay invokes existing durable queues, never replays a provider request directly. */
export class CloudQueueAlarm {
  #serial: Promise<void> = Promise.resolve();
  #revision = 0;
  #running = false;
  #stopped = false;
  readonly storage: AlarmStorage;
  readonly clock: Clock;
  readonly pump: () => Promise<void>;
  readonly nextDue: () => number | null;
  constructor(storage: AlarmStorage, clock: Clock, pump: () => Promise<void>, nextDue: () => number | null) {
    this.storage = storage;
    this.clock = clock;
    this.pump = pump;
    this.nextDue = nextDue;
  }
  private schedule(work: () => Promise<void>) {
    const pending = this.#serial.then(work);
    this.#serial = pending.catch(() => {});
    return pending;
  }
  wake() {
    if (this.#stopped) return Promise.resolve();
    this.#revision++;
    return this.schedule(async () => {
      if (this.#stopped) return;
      const at = this.clock.now() + 1000,
        prior = await this.storage.getAlarm();
      if (prior === null || prior > at) await this.storage.setAlarm(at);
    });
  }
  async stop() {
    this.#stopped = true;
    this.#revision++;
    await this.schedule(() => this.storage.deleteAlarm());
  }
  async alarm() {
    if (this.#stopped || this.#running) return;
    this.#running = true;
    const revision = this.#revision;
    try {
      // Persist a watchdog BEFORE processing; a crash cannot depend on a successful finally block.
      await this.schedule(async () => {
        if (!this.#stopped) await this.storage.setAlarm(this.clock.now() + 30_000);
      });
      if (this.#stopped) return;
      await this.pump();
      await this.schedule(async () => {
        if (this.#stopped) return;
        const due = this.nextDue(),
          current = await this.storage.getAlarm();
        if (due !== null) {
          ensure(Number.isSafeInteger(due) && due >= 0, 'INVALID_ALARM_TIME');
          const at = Math.max(this.clock.now() + 1000, due);
          // A concurrent HTTP wake must not be postponed by the tail of an older pump.
          await this.storage.setAlarm(revision !== this.#revision && current !== null ? Math.min(current, at) : at);
        } else if (revision === this.#revision) await this.storage.deleteAlarm();
      });
    } finally {
      this.#running = false;
    }
  }
}

/** Chat/voice deadlines only; optional autonomous posting needs its separately enabled scheduler wake. */
export function cloudQueueNextDue(store: BusinessStore, now: number): number | null {
  const queries = [
    `SELECT min(b.guaranteed_at) due FROM batches b JOIN worlds w ON w.id=b.world_id JOIN beta_accounts a ON a.player_id=w.owner_id
      WHERE b.status='waiting' AND a.status='active'`,
    `SELECT min(max(b.response_ready_at,i.not_before,coalesce(r.retry_at,0))) due FROM batches b
      JOIN reply_items i ON i.batch_id=b.id JOIN worlds w ON w.id=b.world_id JOIN beta_accounts a ON a.player_id=w.owner_id
      LEFT JOIN text_retry_state r ON r.world_id=b.world_id AND r.conversation_id=b.conversation_id AND r.character_id=b.character_id
      WHERE b.status='eligible' AND i.covered_by IS NULL AND i.job_id IS NULL AND i.awaiting_player=0 AND a.status='active'
        AND (r.world_id IS NULL OR r.retry_at IS NOT NULL)`,
    "SELECT min(next_due_at) due FROM dialogue_deliveries WHERE state='queued'",
    "SELECT min(lease_until) due FROM jobs WHERE status='leased'",
    "SELECT min(lease_until) due FROM speech_tasks WHERE state='generating'",
    "SELECT 0 due FROM speech_tasks WHERE state='queued' AND retry=1 LIMIT 1",
    'SELECT min(coalesce(preparation_until,0)) due FROM beta_reviewed_replies',
  ];
  const times = queries
    .map((sql) => store.get<{ due: number | null }>(sql)?.due)
    .filter((value): value is number => value != null);
  return times.length ? Math.max(now, Math.min(...times)) : null;
}

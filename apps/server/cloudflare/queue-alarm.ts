import type { Clock } from '../../../packages/contracts/index.ts';
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

import { ensure } from '../../../packages/domain/errors.ts';

/**
 * Bounds password-hash work from the business object: at most `running` at once, at most `waiting` queued, then RATE_LIMITED.
 * Part 32: the hash itself runs in the KDF entrypoint (its isolate refuses beyond WEB_KDF_LIMITS.isolateConcurrent, and this
 * gate plus the admin's single slot never send more than that); the gate still exists so a flood queues here, not there.
 * A queued job starts on a later turn of the event loop, so a request that arrived meanwhile (a chat poll) is served between
 * two hashes instead of after all of them.
 */
export class KdfGate {
  private active = 0;
  private waiting: (() => void)[] = [];
  private readonly running: number;
  private readonly queued: number;
  constructor(running: number, queued: number) {
    this.running = running;
    this.queued = queued;
  }
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.running) {
      ensure(this.waiting.length < this.queued, 'RATE_LIMITED');
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else this.active++;
    try {
      return await work();
    } finally {
      const next = this.waiting.shift();
      if (next) setTimeout(next, 0);
      else this.active--;
    }
  }
}

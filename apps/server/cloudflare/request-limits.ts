import { ensure } from '../../../packages/domain/errors.ts';
import type { BusinessStore } from '../platform/store-contract.ts';
import type { Clock } from '../../../packages/contracts/index.ts';

/** Authoritative per-instance limits survive object eviction/restart. Keys never come directly from the JSON body. */
export class CloudRequestLimits {
  readonly #store: BusinessStore;
  readonly #clock: Clock;
  readonly #uploads = new Set<string>();
  constructor(store: BusinessStore, clock: Clock) {
    this.#store = store;
    this.#clock = clock;
  }
  rate(key: string, maximum: number) {
    const accepted = this.#store.transaction(() => {
      const now = this.#clock.now();
      this.#store.run('DELETE FROM cf_http_rates WHERE until_ms<=?', now);
      const row = this.#store.get<{ count: number }>('SELECT count FROM cf_http_rates WHERE key=?', key);
      if (!row) {
        ensure(this.#store.get<{ n: number }>('SELECT count(*) n FROM cf_http_rates')!.n < 512, 'RATE_LIMITED');
        this.#store.run('INSERT INTO cf_http_rates VALUES (?,?,1)', key, now + 60_000);
        return true;
      }
      if (row.count >= maximum) return false;
      this.#store.run('UPDATE cf_http_rates SET count=count+1 WHERE key=?', key);
      return true;
    });
    ensure(accepted, 'RATE_LIMITED');
  }
  async feedbackUpload(playerId: string, work: () => Promise<void>) {
    ensure(this.#uploads.size < 2 && !this.#uploads.has(playerId), 'FEEDBACK_UPLOAD_BUSY');
    this.#uploads.add(playerId);
    try {
      await work();
    } finally {
      this.#uploads.delete(playerId);
    }
  }
}

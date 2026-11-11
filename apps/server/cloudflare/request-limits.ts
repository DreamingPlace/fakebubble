import { WEB_HTTP_LIMITS } from '../../../config/web-v1.ts';
import { ensure } from '../../../packages/domain/errors.ts';
import type { BusinessStore } from '../platform/store-contract.ts';
import type { Clock } from '../../../packages/contracts/index.ts';

/** Authoritative per-instance limits survive object eviction/restart. Keys never come directly from the JSON body. */
/**
 * Rows the per-IP counters may hold at once. A request makes up to three per-IP keys (all requests, welcome plays, writes), and
 * the global limit lets in `requestsGlobalPerMinute` requests a minute, so this many rows can never be reached by traffic the
 * global limit lets through. Derived, not a magic number (Part 29 F).
 */
export const RATE_KEY_CAP = WEB_HTTP_LIMITS.requestsGlobalPerMinute * 3;
/** A key that counts everybody together: it is never one of the capped per-IP rows and is never shed. */
const isGlobalKey = (key: string) => key === 'web:global' || key === 'web:welcome:global';

/** Authoritative per-instance limits survive object eviction/restart. Keys never come directly from the JSON body. */
export class CloudRequestLimits {
  readonly #store: BusinessStore;
  readonly #clock: Clock;
  readonly #uploads = new Set<string>();
  readonly #overflow: () => void;
  constructor(store: BusinessStore, clock: Clock, overflow: () => void = () => {}) {
    this.#store = store;
    this.#clock = clock;
    this.#overflow = overflow;
  }
  rate(key: string, maximum: number) {
    let shed = false;
    const accepted = this.#store.transaction(() => {
      const now = this.#clock.now();
      this.#store.run('DELETE FROM cf_http_rates WHERE until_ms<=?', now);
      const row = this.#store.get<{ count: number }>('SELECT count FROM cf_http_rates WHERE key=?', key);
      if (!row) {
        // A full table sheds the per-IP check (the visitor is let through, counted); the global keys are always kept.
        if (
          !isGlobalKey(key) &&
          this.#store.get<{ n: number }>(
            "SELECT count(*) n FROM cf_http_rates WHERE key NOT IN ('web:global','web:welcome:global')",
          )!.n >= RATE_KEY_CAP
        ) {
          shed = true;
          return true;
        }
        this.#store.run('INSERT INTO cf_http_rates VALUES (?,?,1)', key, now + 60_000);
        return true;
      }
      if (row.count >= maximum) return false;
      this.#store.run('UPDATE cf_http_rates SET count=count+1 WHERE key=?', key);
      return true;
    });
    if (shed) this.#overflow();
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

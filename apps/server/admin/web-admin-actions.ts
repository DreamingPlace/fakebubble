import { createHash } from 'node:crypto';
import { DomainError, ensure } from '../../../packages/domain/errors.ts';
import { REQUEST_ID_PATTERN } from '../../../packages/contracts/web-system.ts';
import type { BusinessStore } from '../platform/store-contract.ts';

/**
 * Part 22b: the console's owner actions (续期价格, 预算充值, 积分发放, 重置全部额度) are idempotent per request id. One row per
 * request: the action, a hash of the request (the same id with different content is a conflict, never a second run), the
 * administrator, the RESULT as the page showed it (counts and prices only) and an optional note the administrator typed. No
 * player id, no email, no content: the points events themselves are the per-player record and leave with the player.
 *
 * Installed at construction like the admin and character tables (additive `CREATE TABLE IF NOT EXISTS`, no ledger step), and it
 * holds no `world_id` or `operation_id`, so the retention audits never see it as player data.
 */
const statements = [
  `CREATE TABLE IF NOT EXISTS web_admin_actions(request_id TEXT PRIMARY KEY,action TEXT NOT NULL,request_hash TEXT NOT NULL,
    admin_id TEXT NOT NULL,result_json TEXT NOT NULL CHECK(json_valid(result_json)),note TEXT,created_at INTEGER NOT NULL) STRICT`,
  // Turnstile failures per UTC day (counts only): the business object is the only writer.
  `CREATE TABLE IF NOT EXISTS web_turnstile_counts(day TEXT NOT NULL CHECK(day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    outcome TEXT NOT NULL CHECK(outcome IN ('failed','unavailable')),n INTEGER NOT NULL CHECK(n>0),PRIMARY KEY(day,outcome)) STRICT`,
] as const;
export function installWebAdminActions(store: BusinessStore) {
  store.transaction(() => {
    for (const sql of statements) store.all(sql);
  });
}

export const requestHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const validRequestId = (value: unknown): value is string =>
  typeof value === 'string' && REQUEST_ID_PATTERN.test(value);

/**
 * Run `work` once per request id. A repeat with the same hash answers the stored result (`duplicate: true`) and runs nothing; a
 * repeat with another action or content is IDEMPOTENCY_CONFLICT. `work` runs inside the caller's transaction together with the
 * recording, so an action and its record commit or vanish together.
 */
export function once<T extends object>(
  store: BusinessStore,
  now: number,
  input: { requestId: unknown; action: string; hash: string; adminId: string; note?: string | null },
  work: () => T,
): T & { duplicate: boolean } {
  ensure(validRequestId(input.requestId), 'INVALID_REQUEST');
  return store.transaction(() => {
    const prior = store.get<{ action: string; request_hash: string; result_json: string }>(
      'SELECT action,request_hash,result_json FROM web_admin_actions WHERE request_id=?',
      input.requestId as string,
    );
    if (prior) {
      if (prior.action !== input.action || prior.request_hash !== input.hash)
        throw new DomainError('IDEMPOTENCY_CONFLICT');
      return { ...(JSON.parse(prior.result_json) as T), duplicate: true };
    }
    const result = work();
    store.run(
      'INSERT INTO web_admin_actions(request_id,action,request_hash,admin_id,result_json,note,created_at) VALUES (?,?,?,?,?,?,?)',
      input.requestId as string,
      input.action,
      input.hash,
      input.adminId,
      JSON.stringify(result),
      input.note ?? null,
      now,
    );
    return { ...result, duplicate: false };
  });
}

const day = (now: number) => new Date(now).toISOString().slice(0, 10);
const KEEP_DAYS = 8;
/** Turnstile failures (counts only), written by the HTTP layer when a check refuses a request. */
export class WebSecurityCounters {
  private readonly store: BusinessStore;
  private readonly clock: { now(): number };
  constructor(store: BusinessStore, clock: { now(): number }) {
    this.store = store;
    this.clock = clock;
  }
  record(outcome: 'failed' | 'unavailable') {
    const now = this.clock.now();
    this.store.transaction(() => {
      this.store.run(
        'INSERT INTO web_turnstile_counts(day,outcome,n) VALUES (?,?,1) ON CONFLICT(day,outcome) DO UPDATE SET n=n+1',
        day(now),
        outcome,
      );
      this.store.run('DELETE FROM web_turnstile_counts WHERE day<?', day(now - KEEP_DAYS * 86_400_000));
    });
  }
  /** Today (UTC) and the last 7 UTC days including today. */
  read(now: number) {
    const rows = this.store.all<{ day: string; outcome: string; n: number }>(
      'SELECT day,outcome,n FROM web_turnstile_counts WHERE day>=?',
      day(now - 6 * 86_400_000),
    );
    const sum = (outcome: string, today: boolean) =>
      rows.filter((r) => r.outcome === outcome && (!today || r.day === day(now))).reduce((n, r) => n + r.n, 0);
    return {
      failuresToday: sum('failed', true),
      failuresLast7Days: sum('failed', false),
      unavailableToday: sum('unavailable', true),
      unavailableLast7Days: sum('unavailable', false),
    };
  }
}

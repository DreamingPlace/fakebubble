import { createHmac, hkdfSync } from 'node:crypto';
import { ACTIVE_MARKER_DAYS } from '../../../config/web-stats.ts';
import type { BusinessStore } from '../platform/store-contract.ts';

/**
 * Part 22c, the write side of the statistics. The counters live in web_stats_daily (migration 128) and are written when the event
 * happens, in the same transaction - most by the triggers of that migration, the rest by the calls below. Counts only: nothing
 * written here names a principal, an operation or any content. Every function is a no-op on a database older than 128.
 */
type Store = Pick<BusinessStore, 'get' | 'all' | 'run'>;
const DAY_MS = 86_400_000;
const STATS_ACTIVE_LABEL = 'stats-active-v1';

export const statsUtcDay = (at: number) => new Date(at).toISOString().slice(0, 10);
const addDays = (day: string, days: number) => statsUtcDay(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS);

const tableExists = (store: Pick<BusinessStore, 'get'>, name: string) =>
  !!store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name);
/** Migration 128's tables exist: an older database counts nothing, whatever the code says. */
export const statsTablesExist = (store: Pick<BusinessStore, 'get'>) =>
  tableExists(store, 'web_stats_daily') && tableExists(store, 'web_daily_active');

/** One more event of a metric on the UTC day of `at` (the metrics with no character or model). */
export function recordStat(store: Store, metric: string, at: number, count = 1) {
  if (!statsTablesExist(store)) return;
  store.run(
    `INSERT INTO web_stats_daily(day,metric,character_id,model,value) VALUES (?,?,'','',?)
    ON CONFLICT(day,metric,character_id,model) DO UPDATE SET value=value+excluded.value`,
    statsUtcDay(at),
    metric,
    count,
  );
}

/**
 * The marker key: HKDF-SHA256 over the business worker's SEAL_KEY, label 'stats-active-v1'. A marker is HMAC-SHA256 under it over
 * the day and the principal id, so it can be recomputed for a principal the business object already knows and never read back.
 */
export class WebStats {
  private readonly store: BusinessStore;
  private readonly key: Buffer;
  private maintainedDay = '';
  constructor(store: BusinessStore, sealKey: Buffer) {
    this.store = store;
    this.key = Buffer.from(hkdfSync('sha256', sealKey, Buffer.alloc(0), STATS_ACTIVE_LABEL, 32));
  }
  private marker(day: string, principalId: string) {
    return createHmac('sha256', this.key).update(day).update('\0').update(principalId).digest('hex');
  }
  /** The first UTC day the counters ran, written once (the Node migration writes it with its own clock; the Worker on first start). */
  start(now: number) {
    if (!statsTablesExist(this.store)) return;
    this.store.run(
      `INSERT INTO web_stats_daily(day,metric,character_id,model,value)
      SELECT ?,'stats_started','','',1 WHERE NOT EXISTS (SELECT 1 FROM web_stats_daily WHERE metric='stats_started')`,
      statsUtcDay(now),
    );
  }
  /**
   * The principal was active on the UTC day of `now`: 'visit' = opened the site, 'chat' = sent a message. Once per (day, scope);
   * a principal that signs up the same day is counted as registered from then on, never twice.
   */
  markActive(principalId: string, scope: 'visit' | 'chat', now: number) {
    if (!statsTablesExist(this.store)) return;
    const registered =
      tableExists(this.store, 'web_player_logins') &&
      !!this.store.get('SELECT 1 FROM web_player_logins WHERE principal_id=?', principalId);
    this.store.run(
      `INSERT INTO web_daily_active(day,marker,kind,scope) VALUES (?,?,?,?)
      ON CONFLICT(day,marker,scope) DO UPDATE SET kind='registered' WHERE excluded.kind='registered'`,
      statsUtcDay(now),
      this.marker(statsUtcDay(now), principalId),
      registered ? 'registered' : 'guest',
      scope,
    );
  }
  /**
   * What the retention alarm does for the statistics, at most once per UTC day: close the D1 cohort of the day before yesterday and
   * the D7 cohort of eight days ago (each exactly once, frozen once written), then drop the markers older than 35 days.
   * Cohort = the registered signups of one UTC day: its size is the 'signups' counter (so a member deleted before the close is
   * still counted), and a member is retained when the business object finds a 'visit' marker of day D+1 (D+7) for a login that was
   * created that day and still exists. Guests are never in a cohort.
   */
  maintain(now: number) {
    const today = statsUtcDay(now);
    if (!statsTablesExist(this.store) || this.maintainedDay === today) return;
    this.store.transaction(() => this.close(today));
    this.maintainedDay = today;
  }
  private close(today: string) {
    for (const [name, lag] of [
      ['d1', 1],
      ['d7', 7],
    ] as const)
      for (const row of this.store.all<{ day: string; value: number }>(
        `SELECT s.day,s.value FROM web_stats_daily s WHERE s.metric='signups' AND s.day<=? AND s.day>=?
        AND NOT EXISTS (SELECT 1 FROM web_stats_daily c WHERE c.metric=? AND c.day=s.day) ORDER BY s.day`,
        addDays(today, -(lag + 1)),
        addDays(today, -ACTIVE_MARKER_DAYS - lag),
        `${name}_cohort`,
      )) {
        const start = Date.parse(`${row.day}T00:00:00Z`),
          later = addDays(row.day, lag);
        let retained = 0;
        for (const login of this.store.all<{ principal_id: string }>(
          'SELECT principal_id FROM web_player_logins WHERE created_at>=? AND created_at<?',
          start,
          start + DAY_MS,
        ))
          if (
            this.store.get(
              "SELECT 1 FROM web_daily_active WHERE day=? AND marker=? AND scope='visit'",
              later,
              this.marker(later, login.principal_id),
            )
          )
            retained++;
        for (const [metric, value] of [
          [`${name}_cohort`, row.value],
          [`${name}_retained`, retained],
        ] as const)
          this.store.run(
            `INSERT INTO web_stats_daily(day,metric,character_id,model,value) VALUES (?,?,'','',?)
            ON CONFLICT(day,metric,character_id,model) DO NOTHING`,
            row.day,
            metric,
            value,
          );
      }
    // The markers live 35 days but the page shows 90: a finished day's counts are written down (frozen) before its markers go.
    this.store.run(
      `INSERT INTO web_stats_daily(day,metric,character_id,model,value)
      SELECT day,(CASE scope WHEN 'visit' THEN 'active_' ELSE 'chat_' END)||kind,'','',count(*)
      FROM web_daily_active WHERE day<? GROUP BY day,scope,kind
      ON CONFLICT(day,metric,character_id,model) DO NOTHING`,
      today,
    );
    this.store.run('DELETE FROM web_daily_active WHERE day<?', addDays(today, -ACTIVE_MARKER_DAYS));
  }
  /**
   * When the alarm must wake for the statistics without traffic: the next UTC midnight while a signup day of the last 8 days has a
   * cohort that is not closed yet. Nothing else wakes it - the markers are pruned by the next sweep, whatever woke the alarm.
   */
  nextDue(now: number): number | null {
    if (!statsTablesExist(this.store)) return null;
    const pending = this.store.get(
      `SELECT 1 FROM web_stats_daily s WHERE s.metric='signups' AND s.day>=?
      AND (NOT EXISTS (SELECT 1 FROM web_stats_daily c WHERE c.metric='d1_cohort' AND c.day=s.day)
        OR NOT EXISTS (SELECT 1 FROM web_stats_daily c WHERE c.metric='d7_cohort' AND c.day=s.day)) LIMIT 1`,
      addDays(statsUtcDay(now), -8),
    );
    return pending ? (Math.floor(now / DAY_MS) + 1) * DAY_MS + 1000 : null;
  }
}

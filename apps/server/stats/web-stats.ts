import { createHmac, hkdfSync } from 'node:crypto';
import { ACTIVE_MARKER_DAYS } from '../../../config/web-stats.ts';
import type { BusinessStore } from '../platform/store-contract.ts';
import type { ModelFlags } from '../admission/web-model-settings.ts';
import { userTypeOf } from './web-user-type.ts';

/**
 * Part 22c, the write side of the statistics. The counters live in web_stats_daily (migration 128) and are written when the event
 * happens, in the same transaction - most by the triggers of that migration, the rest by the calls below. Counts only: nothing
 * written here names a principal, an operation or any content. Every function is a no-op on a database older than 128.
 */
type Store = Pick<BusinessStore, 'get' | 'all' | 'run'>;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const STATS_ACTIVE_LABEL = 'stats-active-v1';

export const statsUtcDay = (at: number) => new Date(at).toISOString().slice(0, 10);
const addDays = (day: string, days: number) => statsUtcDay(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS);
/** Part 22d: the UTC hour of `at`, 'YYYY-MM-DDTHH' (sorts like time). */
export const statsUtcHour = (at: number) => new Date(at).toISOString().slice(0, 13);

const tableExists = (store: Pick<BusinessStore, 'get'>, name: string) =>
  !!store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name);
/** Migration 128's tables exist: an older database counts nothing, whatever the code says. */
export const statsTablesExist = (store: Pick<BusinessStore, 'get'>) =>
  tableExists(store, 'web_stats_daily') && tableExists(store, 'web_daily_active');

/** Migration 130's tables exist (chat users per character, hourly counts, user types, spend by user type). */
export const statsExtrasExist = (store: Pick<BusinessStore, 'get'>) =>
  statsTablesExist(store) && tableExists(store, 'web_stats_hourly') && tableExists(store, 'web_stats_spend');

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
    // Part 22d: the first day the per-type spend counters ran (the spend table shows — before it).
    if (statsExtrasExist(this.store))
      this.store.run(
        `INSERT INTO web_stats_daily(day,metric,character_id,model,value)
        SELECT ?,'extras_started','','',1 WHERE NOT EXISTS (SELECT 1 FROM web_stats_daily WHERE metric='extras_started')`,
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
   * Part 22d: the principal sent a message to this character. A marker per (day, character) and per (hour, character) and one per
   * (hour) in total, each written once: the first marker of an hour also counts the hour's chat_users row. Counts only.
   */
  markChat(principalId: string, characterId: string, now: number) {
    if (!statsExtrasExist(this.store) || !tableExists(this.store, 'web_chat_active')) return;
    const day = statsUtcDay(now),
      hour = statsUtcHour(now);
    this.store.run(
      'INSERT INTO web_chat_active(day,character_id,marker) VALUES (?,?,?) ON CONFLICT DO NOTHING',
      day,
      characterId,
      this.chatMarker(day, characterId, principalId),
    );
    for (const key of [characterId, ''])
      if (
        this.store.run(
          'INSERT INTO web_chat_active_hourly(hour,character_id,marker) VALUES (?,?,?) ON CONFLICT DO NOTHING',
          hour,
          key,
          this.chatMarker(hour, key, principalId),
        ).changes === 1
      )
        this.store.run(
          `INSERT INTO web_stats_hourly(hour,metric,character_id,value) VALUES (?,'chat_users',?,1)
          ON CONFLICT(hour,metric,character_id) DO UPDATE SET value=value+1`,
          hour,
          key,
        );
  }
  private chatMarker(period: string, characterId: string, principalId: string) {
    return createHmac('sha256', this.key)
      .update('chat\0')
      .update(period)
      .update('\0')
      .update(characterId)
      .update('\0')
      .update(principalId)
      .digest('hex');
  }
  /**
   * Part 22d: the user type of an operation, frozen at admission with the operation row (the spend split reads it later, when the
   * provider call is charged). `flags` is the store that answers the tier question (model-choice flags live on it).
   */
  freezeUserType(
    flags: Pick<BusinessStore, 'get' | 'all'> & ModelFlags,
    operationId: string,
    principalId: string,
    now: number,
  ) {
    if (!statsExtrasExist(this.store)) return;
    this.store.run(
      'INSERT INTO web_operation_user_types(operation_id,user_type,created_at) VALUES (?,?,?) ON CONFLICT DO NOTHING',
      operationId,
      userTypeOf(flags, principalId, now),
      now,
    );
  }
  /** Part 22d: hourly rows and their markers older than 48 hours go, on every sweep (they never wake the alarm). */
  private pruneHourly(now: number) {
    if (!statsExtrasExist(this.store)) return;
    const keep = statsUtcHour(now - 48 * HOUR_MS);
    this.store.run('DELETE FROM web_stats_hourly WHERE hour<?', keep);
    this.store.run('DELETE FROM web_chat_active_hourly WHERE hour<?', keep);
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
    if (!statsTablesExist(this.store)) return;
    this.store.transaction(() => this.pruneHourly(now));
    if (this.maintainedDay === today) return;
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
    // Part 22d: the same for the chat users of each character.
    if (statsExtrasExist(this.store)) {
      this.store.run(
        `INSERT INTO web_stats_daily(day,metric,character_id,model,value)
        SELECT day,'chat_users',character_id,'',count(*) FROM web_chat_active WHERE day<? GROUP BY day,character_id
        ON CONFLICT(day,metric,character_id,model) DO NOTHING`,
        today,
      );
      this.store.run('DELETE FROM web_chat_active WHERE day<?', addDays(today, -ACTIVE_MARKER_DAYS));
    }
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

import { ensure } from '../../../packages/domain/errors.ts';
import { USD_CNY } from '../../../config/web-stats.ts';
import {
  CHART_METRICS,
  CHART_RANGES,
  STATS_RANGES,
  STATS_USER_TYPES,
  type ChartMetric,
  type ChartRange,
  type ChartSeries,
  type ChartView,
  type CohortRetention,
  type CostDay,
  type CostRow,
  type CostsView,
  type OverviewStats,
  type PlayerStatsDay,
  type PlayerStatsTotals,
  type PlayerStatsView,
  type ReplyBreakdown,
  type SpendByType,
  type SpendDay,
  type SpendView,
  type StatsCounts,
  type StatsRange,
} from '../../../packages/contracts/web-stats.ts';
import { DRAMA3_DISCOUNT_LAST_DAY } from '../generation/model-list-prices.ts';
import type { BusinessStore } from '../platform/store-contract.ts';
import { csvDocument } from '../invites/web-invite-export.ts';
import { statsExtrasExist, statsTablesExist, statsUtcDay, statsUtcHour } from '../stats/web-stats.ts';

/**
 * 玩家统计 and 消耗表 (Part 22c): reads of the counters the triggers and the write sites keep (web_stats_daily, web_daily_active
 * counted never listed) and of web_provider_usage. Nothing here reads web_operations, web_points_events or any other table the
 * purge deletes from, so a past day never changes when a player is purged. Counts only.
 */
type Store = Pick<BusinessStore, 'get' | 'all'>;
const DAY_MS = 86_400_000;
const addDays = (day: string, days: number) => statsUtcDay(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS);
const has = (store: Store, name: string) =>
  !!store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name);

export function parseRange(value: unknown): StatsRange {
  ensure(STATS_RANGES.includes(value as StatsRange), 'INVALID_REQUEST');
  return value as StatsRange;
}
export function parseChart(input: Record<string, unknown>): { metric: ChartMetric; range: ChartRange } {
  ensure(
    CHART_METRICS.includes(input.metric as ChartMetric) && CHART_RANGES.includes(input.range as ChartRange),
    'INVALID_REQUEST',
  );
  return { metric: input.metric as ChartMetric, range: input.range as ChartRange };
}
/** STATS_UNAVAILABLE on a database that has not been migrated to 128. */
const requireStats = (store: Store) => ensure(statsTablesExist(store), 'STATS_UNAVAILABLE');

/** The first UTC day the counters ran. */
const statsSince = (store: Store) =>
  store.get<{ day: string | null }>("SELECT min(day) day FROM web_stats_daily WHERE metric='stats_started'")?.day ??
  null;

const zero = (): StatsCounts => ({
  signups: 0,
  newGuests: 0,
  activeRegistered: 0,
  activeGuests: 0,
  chatRegistered: 0,
  chatGuests: 0,
  repliesPublished: 0,
  repliesFailed: 0,
  repliesUnknown: 0,
  voiceReplies: 0,
  deletedAccounts: 0,
  inactivePurged: 0,
  expiredPurged: 0,
});
/** Metric name → the counter it feeds. */
const COUNTERS: Record<string, keyof StatsCounts> = {
  signups: 'signups',
  new_guests: 'newGuests',
  active_registered: 'activeRegistered',
  active_guest: 'activeGuests',
  chat_registered: 'chatRegistered',
  chat_guest: 'chatGuests',
  reply_published: 'repliesPublished',
  reply_failed: 'repliesFailed',
  reply_unknown: 'repliesUnknown',
  reply_voice: 'voiceReplies',
  purge_deleted: 'deletedAccounts',
  purge_inactive: 'inactivePurged',
  purge_expired: 'expiredPurged',
};
const sumInto = (total: StatsCounts, row: StatsCounts) => {
  for (const key of Object.keys(zero()) as (keyof StatsCounts)[]) total[key] += row[key];
};

function cohortOf(rows: Map<string, number>, prefix: 'd1' | 'd7'): CohortRetention | null {
  const cohort = rows.get(`${prefix}_cohort`);
  return cohort === undefined ? null : { cohort, retained: rows.get(`${prefix}_retained`) ?? 0 };
}

const characterNames = (store: Store, ids: string[]) => {
  const names = new Map<string, string>();
  for (const id of ids) {
    const row = has(store, 'web_character_versions')
      ? store.get<{ name: string | null }>(
          `SELECT json_extract(profile_json,'$.presentation.displayName') name FROM web_character_versions
          WHERE character_id=? ORDER BY version DESC LIMIT 1`,
          id,
        )
      : undefined;
    names.set(id, row?.name || '已删除的角色');
  }
  return names;
};

/** The daily table (newest first, days from `since` on), its totals row, 按角色 and 按模型. */
export function readPlayerStats(store: Store, now: number, range: StatsRange): PlayerStatsView {
  requireStats(store);
  const today = statsUtcDay(now),
    since = statsSince(store),
    first = addDays(today, -(range - 1)),
    from = since !== null && since > first ? since : first;
  const days: PlayerStatsDay[] = [];
  const perDay = new Map<string, Map<string, number>>();
  const put = (day: string, metric: string, value: number) => {
    const row = perDay.get(day) ?? new Map<string, number>();
    perDay.set(day, row);
    row.set(metric, (row.get(metric) ?? 0) + value);
  };
  if (since !== null && from <= today) {
    for (const row of store.all<{ day: string; metric: string; value: number }>(
      'SELECT day,metric,sum(value) value FROM web_stats_daily WHERE day>=? AND day<=? GROUP BY day,metric',
      from,
      today,
    ))
      put(row.day, row.metric, row.value);
    // A day that has not been written down yet (today, or yesterday before the alarm ran) is read from the markers: counted, never listed.
    for (const row of store.all<{ day: string; scope: string; kind: string; n: number }>(
      'SELECT day,scope,kind,count(*) n FROM web_daily_active WHERE day>=? AND day<=? GROUP BY day,scope,kind',
      from,
      today,
    )) {
      const metric = `${row.scope === 'visit' ? 'active' : 'chat'}_${row.kind}`;
      if (!perDay.get(row.day)?.has(metric)) put(row.day, metric, row.n);
    }
    for (let day = today; day >= from; day = addDays(day, -1)) {
      const metrics = perDay.get(day) ?? new Map<string, number>();
      const counts = zero();
      for (const [metric, value] of metrics) if (COUNTERS[metric]) counts[COUNTERS[metric]!] = value;
      days.push({ day, ...counts, d1: cohortOf(metrics, 'd1'), d7: cohortOf(metrics, 'd7') });
    }
  }
  const totals: PlayerStatsTotals = { ...zero(), d1: null, d7: null };
  for (const row of days) {
    sumInto(totals, row);
    for (const key of ['d1', 'd7'] as const)
      if (row[key])
        totals[key] = {
          cohort: (totals[key]?.cohort ?? 0) + row[key]!.cohort,
          retained: (totals[key]?.retained ?? 0) + row[key]!.retained,
        };
  }
  const breakdown = (column: 'character_id' | 'model') => {
    const map = new Map<string, ReplyBreakdown>();
    for (const row of store.all<{ key: string; metric: string; value: number }>(
      `SELECT ${column} key,metric,sum(value) value FROM web_stats_daily
      WHERE metric IN ('reply_published','reply_failed','reply_unknown','reply_voice') AND day>=? AND day<=?
      GROUP BY ${column},metric`,
      from,
      today,
    )) {
      const entry = map.get(row.key) ?? { published: 0, failed: 0, unknown: 0, voice: 0 };
      map.set(row.key, entry);
      if (row.metric === 'reply_published') entry.published = row.value;
      else if (row.metric === 'reply_failed') entry.failed = row.value;
      else if (row.metric === 'reply_unknown') entry.unknown = row.value;
      else entry.voice = row.value;
    }
    return map;
  };
  const characters = breakdown('character_id'),
    names = characterNames(store, [...characters.keys()]);
  return {
    since,
    range,
    days,
    totals,
    byCharacter: [...characters]
      .map(([id, entry]) => ({ name: names.get(id)!, ...entry }))
      .sort((a, b) => b.published - a.published || a.name.localeCompare(b.name, 'zh-CN')),
    byModel: [...breakdown('model')]
      .map(([model, entry]) => ({ model, ...entry }))
      .sort((a, b) => b.published - a.published || a.model.localeCompare(b.model)),
  };
}

/** Per day and provider / model / phase from web_provider_usage, the daily derived rows and this UTC month. */
export function readCosts(store: Store, now: number, range: StatsRange): CostsView {
  requireStats(store);
  const today = statsUtcDay(now),
    since = statsSince(store),
    from = addDays(today, -(range - 1)),
    month = today.slice(0, 7),
    monthStart = `${month}-01`;
  const usage = (low: string) =>
    has(store, 'web_provider_usage')
      ? store.all<{
          day: string;
          provider: string;
          model: string;
          phase: CostRow['phase'];
          calls: number;
          input_tokens: number;
          cached_input_tokens: number;
          output_tokens: number;
          bytes: number;
          cost_micros: number;
          ledger_charged_micros: number;
          replies: number;
        }>(
          'SELECT * FROM web_provider_usage WHERE day>=? AND day<=? ORDER BY day DESC,provider,model,phase',
          low,
          today,
        )
      : [];
  // A row before the day the counters started has no ledger amount (the column did not exist): shown as 未知, not 0.
  const known = (day: string) => since !== null && day >= since;
  const rows: CostRow[] = usage(from).map((row) => ({
    day: row.day,
    provider: row.provider,
    model: row.model,
    phase: row.phase,
    calls: row.calls,
    inputTokens: row.input_tokens,
    cachedInputTokens: row.cached_input_tokens,
    outputTokens: row.output_tokens,
    bytes: row.bytes,
    listCostMicros: row.cost_micros,
    ledgerChargedMicros: known(row.day) ? row.ledger_charged_micros : null,
    replies: row.replies,
  }));
  const metricPerDay = (metric: string, low: string) =>
    new Map(
      store
        .all<{ day: string; value: number }>(
          'SELECT day,sum(value) value FROM web_stats_daily WHERE metric=? AND day>=? AND day<=? GROUP BY day',
          metric,
          low,
          today,
        )
        .map((row) => [row.day, row.value]),
    );
  const published = metricPerDay('reply_published', from),
    spent = metricPerDay('points_spent', from);
  const costPerDay = new Map<string, number>();
  for (const row of rows) costPerDay.set(row.day, (costPerDay.get(row.day) ?? 0) + row.listCostMicros);
  const dayKeys = new Set([...costPerDay.keys(), ...published.keys(), ...spent.keys()]);
  const daily: CostDay[] = [...dayKeys]
    .sort()
    .reverse()
    .map((day) => {
      const replies = published.get(day) ?? 0,
        cost = costPerDay.get(day) ?? 0;
      return {
        day,
        publishedReplies: replies,
        listCostMicros: cost,
        costPerReplyMicros: replies > 0 ? Math.round(cost / replies) : null,
        pointsSpent: spent.get(day) ?? 0,
      };
    });
  const monthRows = usage(monthStart);
  const monthList = monthRows.reduce((sum, row) => sum + row.cost_micros, 0);
  const monthLedgerRows = monthRows.filter((row) => known(row.day));
  const monthReplies = [...metricPerDay('reply_published', monthStart).values()].reduce((a, b) => a + b, 0);
  return {
    since,
    range,
    usdCny: USD_CNY,
    rows,
    daily,
    month: {
      month,
      listCostMicros: monthList,
      ledgerChargedMicros: monthLedgerRows.length
        ? monthLedgerRows.reduce((sum, row) => sum + row.ledger_charged_micros, 0)
        : null,
      listCostRmbFen: Math.round((monthList * USD_CNY) / 10_000),
      publishedReplies: monthReplies,
      costPerReplyMicros: monthReplies > 0 ? Math.round(monthList / monthReplies) : null,
      pointsSpent: [...metricPerDay('points_spent', monthStart).values()].reduce((a, b) => a + b, 0),
      spansDramaPriceChange: DRAMA3_DISCOUNT_LAST_DAY.startsWith(month),
    },
  };
}

/** The first UTC day the Part 22d counters (per-character chat users, hourly rows, spend by user type) ran. */
const extrasSince = (store: Store) =>
  store.get<{ day: string | null }>("SELECT min(day) day FROM web_stats_daily WHERE metric='extras_started'")?.day ??
  null;
const requireExtras = (store: Store) => ensure(statsTablesExist(store) && statsExtrasExist(store), 'STATS_UNAVAILABLE');

/**
 * 总览 chart data (Part 22d): replies or chat users, per character and in total. 24h = the last 24 UTC hours (hourly rows, kept 48
 * hours); 7d / 14d = the last days (the daily counters, today read live). Nothing here reads a table the purge deletes from, and no
 * id, marker or content leaves: the characters are named by their display name.
 */
export function readChart(store: Store, now: number, metric: ChartMetric, range: ChartRange): ChartView {
  requireExtras(store);
  const hourly = range === '24h',
    today = statsUtcDay(now),
    since = extrasSince(store);
  const buckets: string[] = [];
  if (hourly) for (let i = 23; i >= 0; i--) buckets.push(statsUtcHour(now - i * 3_600_000));
  else for (let i = (range === '7d' ? 7 : 14) - 1; i >= 0; i--) buckets.push(addDays(today, -i));
  const first = buckets[0]!,
    last = buckets[buckets.length - 1]!;
  const perCharacter = new Map<string, Map<string, number>>(),
    totals = new Map<string, number>();
  const put = (map: Map<string, Map<string, number>>, id: string, bucket: string, value: number) => {
    const row = map.get(id) ?? new Map<string, number>();
    map.set(id, row);
    row.set(bucket, value);
  };
  if (hourly) {
    for (const row of store.all<{ hour: string; character_id: string; value: number }>(
      'SELECT hour,character_id,value FROM web_stats_hourly WHERE metric=? AND hour>=? AND hour<=?',
      metric === 'replies' ? 'reply_published' : 'chat_users',
      first,
      last,
    ))
      if (row.character_id === '') totals.set(row.hour, row.value);
      else {
        put(perCharacter, row.character_id, row.hour, row.value);
        if (metric === 'replies') totals.set(row.hour, (totals.get(row.hour) ?? 0) + row.value);
      }
  } else if (metric === 'replies') {
    for (const row of store.all<{ day: string; character_id: string; value: number }>(
      "SELECT day,character_id,sum(value) value FROM web_stats_daily WHERE metric='reply_published' AND day>=? AND day<=? GROUP BY day,character_id",
      first,
      last,
    )) {
      put(perCharacter, row.character_id, row.day, row.value);
      totals.set(row.day, (totals.get(row.day) ?? 0) + row.value);
    }
  } else {
    const written = new Set<string>();
    for (const row of store.all<{ day: string; character_id: string; value: number }>(
      "SELECT day,character_id,value FROM web_stats_daily WHERE metric='chat_users' AND day>=? AND day<=?",
      first,
      last,
    )) {
      put(perCharacter, row.character_id, row.day, row.value);
      written.add(`${row.day}\0${row.character_id}`);
    }
    // A day the alarm has not written down yet (today, or yesterday before its first sweep) is counted from the markers.
    for (const row of store.all<{ day: string; character_id: string; n: number }>(
      'SELECT day,character_id,count(*) n FROM web_chat_active WHERE day>=? AND day<=? GROUP BY day,character_id',
      first,
      last,
    ))
      if (!written.has(`${row.day}\0${row.character_id}`)) put(perCharacter, row.character_id, row.day, row.n);
    const snapshot = new Map<string, number>();
    for (const row of store.all<{ day: string; value: number }>(
      "SELECT day,sum(value) value FROM web_stats_daily WHERE metric IN ('chat_registered','chat_guest') AND day>=? AND day<=? GROUP BY day",
      first,
      last,
    ))
      snapshot.set(row.day, row.value);
    for (const row of store.all<{ day: string; n: number }>(
      "SELECT day,count(*) n FROM web_daily_active WHERE scope='chat' AND day>=? AND day<=? GROUP BY day",
      first,
      last,
    ))
      if (!snapshot.has(row.day)) snapshot.set(row.day, row.n);
    for (const [day, value] of snapshot) totals.set(day, value);
  }
  const known = (bucket: string) => since !== null && bucket.slice(0, 10) >= since;
  const column = (values: Map<string, number>) =>
    buckets.map((bucket) => (known(bucket) ? (values.get(bucket) ?? 0) : null));
  const names = characterNames(store, [...perCharacter.keys()]);
  const characters: (ChartSeries & { sum: number })[] = [...perCharacter].map(([id, values]) => {
    const series = column(values);
    return { name: names.get(id)!, values: series, sum: series.reduce<number>((a, b) => a + (b ?? 0), 0) };
  });
  characters.sort((a, b) => b.sum - a.sum || a.name.localeCompare(b.name, 'zh-CN'));
  return {
    metric,
    range,
    bucket: hourly ? 'hour' : 'day',
    since,
    buckets,
    total: column(totals),
    characters: characters.map(({ name, values }) => ({ name, values })),
  };
}

/**
 * 消耗表 by user type (Part 22d): per UTC day, what the budget ledger charged for the provider calls of replies, split by the user
 * type frozen at admission and by text (draft, review) or voice (speech), in USD micros. A day before the per-type counters ran has
 * `types: null` (shown —). The sum of a day equals that day's ledger amount in web_provider_usage.
 */
export function readSpend(store: Store, now: number, range: StatsRange): SpendView {
  requireExtras(store);
  const today = statsUtcDay(now),
    since = extrasSince(store),
    from = addDays(today, -(range - 1));
  const cell = new Map<string, number>();
  for (const row of store.all<{ day: string; user_type: string; kind: string; charged_micros: number }>(
    'SELECT day,user_type,kind,charged_micros FROM web_stats_spend WHERE day>=? AND day<=?',
    from,
    today,
  ))
    cell.set(`${row.day}\0${row.user_type}\0${row.kind}`, row.charged_micros);
  const of = (day: string, userType: string, kind: 'text' | 'voice') => cell.get(`${day}\0${userType}\0${kind}`) ?? 0;
  const days: SpendDay[] = [];
  const totals: SpendByType[] = STATS_USER_TYPES.map((userType) => ({ userType, textMicros: 0, voiceMicros: 0 }));
  let anyKnown = false;
  for (let day = today; day >= from; day = addDays(day, -1)) {
    if (since === null || day < since) {
      days.push({ day, types: null, unclassifiedMicros: null, totalMicros: null });
      continue;
    }
    anyKnown = true;
    const types = STATS_USER_TYPES.map((userType) => ({
      userType,
      textMicros: of(day, userType, 'text'),
      voiceMicros: of(day, userType, 'voice'),
    }));
    types.forEach((entry, i) => {
      totals[i]!.textMicros += entry.textMicros;
      totals[i]!.voiceMicros += entry.voiceMicros;
    });
    const unclassified = of(day, 'unknown', 'text') + of(day, 'unknown', 'voice');
    days.push({
      day,
      types,
      unclassifiedMicros: unclassified,
      totalMicros: types.reduce((sum, t) => sum + t.textMicros + t.voiceMicros, unclassified),
    });
  }
  return { since, range, usdCny: USD_CNY, days, totals: anyKnown ? totals : null };
}

/** 概览's extra numbers (administrators with stats.read): yesterday (UTC) and this month's list-price spend in RMB. */
export function readOverviewStats(store: Store, now: number): OverviewStats | null {
  if (!statsTablesExist(store)) return null;
  const today = statsUtcDay(now),
    yesterday = addDays(today, -1);
  const metric = (name: string, day: string) =>
    store.get<{ n: number }>(
      'SELECT coalesce(sum(value),0) n FROM web_stats_daily WHERE metric=? AND day=?',
      name,
      day,
    )!.n;
  const live = (scope: 'visit' | 'chat') =>
    store.get<{ n: number }>('SELECT count(*) n FROM web_daily_active WHERE day=? AND scope=?', yesterday, scope)!.n;
  // The snapshot of yesterday exists once the alarm has run on its first tick of today; until then the markers answer.
  const snapshot = metric('active_registered', yesterday) + metric('active_guest', yesterday);
  const month = has(store, 'web_provider_usage')
    ? store.get<{ n: number }>(
        'SELECT coalesce(sum(cost_micros),0) n FROM web_provider_usage WHERE day>=? AND day<=?',
        `${today.slice(0, 7)}-01`,
        today,
      )!.n
    : 0;
  return {
    yesterday: {
      day: yesterday,
      signups: metric('signups', yesterday),
      active: snapshot > 0 ? snapshot : live('visit'),
      replies: metric('reply_published', yesterday),
    },
    monthListCostRmbFen: Math.round((month * USD_CNY) / 10_000),
  };
}

const usd = (micros: number) => (micros / 1_000_000).toFixed(6);
const ratio = (c: CohortRetention | null) => (c ? `${c.retained} / ${c.cohort}` : '—');
const percent = (c: CohortRetention | null) =>
  c && c.cohort > 0 ? `${Math.round((c.retained / c.cohort) * 100)}%` : '—';

/** The 玩家统计 CSV: the daily columns, newest first, then the totals row. UTF-8 BOM and the invite export's formula guard. */
export function playerStatsCsv(view: PlayerStatsView) {
  const line = (label: string, r: StatsCounts & { d1: CohortRetention | null; d7: CohortRetention | null }) => [
    label,
    String(r.signups),
    String(r.newGuests),
    String(r.activeRegistered),
    String(r.activeGuests),
    String(r.chatRegistered),
    String(r.chatGuests),
    String(r.repliesPublished),
    String(r.repliesFailed),
    String(r.repliesUnknown),
    String(r.voiceReplies),
    String(r.deletedAccounts),
    String(r.inactivePurged),
    String(r.expiredPurged),
    ratio(r.d1),
    percent(r.d1),
    ratio(r.d7),
    percent(r.d7),
  ];
  return csvDocument([
    [
      '日期 (UTC)',
      '新注册',
      '新访客',
      '活跃（注册）',
      '活跃（访客）',
      '聊天人数（注册）',
      '聊天人数（访客）',
      '回复（成功）',
      '回复（失败）',
      '回复（未知）',
      '语音回复',
      '删除账号',
      '不活跃清理',
      '试用到期清理',
      '次日留存',
      '次日留存率',
      '7 日留存',
      '7 日留存率',
    ],
    ...view.days.map((row) => line(row.day, row)),
    line('合计', view.totals),
  ]);
}

/** The 消耗表 CSV: one line per day, provider, model and phase, then the totals. */
export function costsCsv(view: CostsView) {
  const total = view.rows.reduce(
    (t, r) => ({
      calls: t.calls + r.calls,
      input: t.input + r.inputTokens,
      cached: t.cached + r.cachedInputTokens,
      output: t.output + r.outputTokens,
      bytes: t.bytes + r.bytes,
      list: t.list + r.listCostMicros,
      ledger: r.ledgerChargedMicros === null ? t.ledger : (t.ledger ?? 0) + r.ledgerChargedMicros,
      replies: t.replies + r.replies,
    }),
    { calls: 0, input: 0, cached: 0, output: 0, bytes: 0, list: 0, ledger: null as number | null, replies: 0 },
  );
  return csvDocument([
    [
      '日期 (UTC)',
      '供应商',
      '模型',
      '阶段',
      '调用次数',
      '输入令牌',
      '缓存命中令牌',
      '输出令牌',
      '字节（语音）',
      '列表价（美元）',
      '账本扣款（美元）',
      '回复',
    ],
    ...view.rows.map((r) => [
      r.day,
      r.provider,
      r.model,
      r.phase,
      String(r.calls),
      String(r.inputTokens),
      String(r.cachedInputTokens),
      String(r.outputTokens),
      String(r.bytes),
      usd(r.listCostMicros),
      r.ledgerChargedMicros === null ? '—' : usd(r.ledgerChargedMicros),
      String(r.replies),
    ]),
    [
      '合计',
      '',
      '',
      '',
      String(total.calls),
      String(total.input),
      String(total.cached),
      String(total.output),
      String(total.bytes),
      usd(total.list),
      total.ledger === null ? '—' : usd(total.ledger),
      String(total.replies),
    ],
  ]);
}

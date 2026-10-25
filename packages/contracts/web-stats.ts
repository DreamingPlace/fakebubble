/**
 * The administrator console's 玩家统计 and 消耗表 (Part 22c). Counts, days, models, characters' display names and money only: no
 * principal id, marker, email, nickname, IP hash or message content appears in any of these shapes.
 */
export const STATS_RANGES = [7, 30, 90] as const;
export type StatsRange = (typeof STATS_RANGES)[number];

/** A D1 / D7 cohort once it is closed: `cohort` registered signups of the day, `retained` of them seen again on day +1 / +7. */
export type CohortRetention = { cohort: number; retained: number };
export type StatsCounts = {
  signups: number;
  newGuests: number;
  activeRegistered: number;
  activeGuests: number;
  chatRegistered: number;
  chatGuests: number;
  repliesPublished: number;
  repliesFailed: number;
  repliesUnknown: number;
  voiceReplies: number;
  deletedAccounts: number;
  inactivePurged: number;
  expiredPurged: number;
};
/** One UTC day. `d1` / `d7` are null while the cohort is not closed yet (and for a day nobody signed up on). */
export type PlayerStatsDay = StatsCounts & { day: string; d1: CohortRetention | null; d7: CohortRetention | null };
export type PlayerStatsTotals = StatsCounts & { d1: CohortRetention | null; d7: CohortRetention | null };
export type ReplyBreakdown = { published: number; failed: number; unknown: number; voice: number };
/** 按角色: the character's display NAME (never an id); a character that no longer exists reads 已删除的角色. */
export type PlayerStatsCharacter = ReplyBreakdown & { name: string };
/** 按模型: '' = a reply admitted while model choice was off (shown as 未选择模型). */
export type PlayerStatsModel = ReplyBreakdown & { model: string };
export type PlayerStatsView = {
  /** The first UTC day the counters ran (the day migration 128 ran); null before any is known. */
  since: string | null;
  range: StatsRange;
  /** Newest first; only days from `since` on. */
  days: PlayerStatsDay[];
  totals: PlayerStatsTotals;
  byCharacter: PlayerStatsCharacter[];
  byModel: PlayerStatsModel[];
};

/** One day, provider, model and phase of web_provider_usage. `ledgerChargedMicros` is null for a day before 22c. */
export type CostRow = {
  day: string;
  provider: string;
  model: string;
  phase: 'draft' | 'review' | 'speech';
  calls: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  bytes: number;
  listCostMicros: number;
  ledgerChargedMicros: number | null;
  replies: number;
};
export type CostDay = {
  day: string;
  publishedReplies: number;
  listCostMicros: number;
  /** list cost / published replies; null when no reply was counted that day. */
  costPerReplyMicros: number | null;
  pointsSpent: number;
};
export type CostMonth = {
  /** 'YYYY-MM' (UTC). */
  month: string;
  listCostMicros: number;
  ledgerChargedMicros: number | null;
  /** The list cost at USD_CNY, in fen. */
  listCostRmbFen: number;
  publishedReplies: number;
  costPerReplyMicros: number | null;
  pointsSpent: number;
  /** The month contains the day Fish Drama 3's list price changes (the 备注 row). */
  spansDramaPriceChange: boolean;
};
export type CostsView = {
  since: string | null;
  range: StatsRange;
  usdCny: number;
  /** Newest first. */
  rows: CostRow[];
  daily: CostDay[];
  month: CostMonth;
};

/** 概览's extra line (needs stats.read): yesterday (UTC) and this month's spend. */
export type OverviewStats = {
  yesterday: { day: string; signups: number; active: number; replies: number };
  monthListCostRmbFen: number;
};

/**
 * Part 22d. Who a reply was for, in priority order (first match wins at admission, then frozen): 测试组 test · 不限量 unlimited ·
 * 每天补充 daily_refill · 注册 registered · 访客 guest. There is no 管理员: nothing links an administrator to a player.
 */
export const STATS_USER_TYPES = ['test', 'unlimited', 'daily_refill', 'registered', 'guest'] as const;
export type StatsUserType = (typeof STATS_USER_TYPES)[number];

/** 总览 chart: what is counted and over what window. 24h is hourly (the last 24 UTC hours); 7d and 14d are daily. */
export const CHART_METRICS = ['replies', 'chat_users'] as const;
export type ChartMetric = (typeof CHART_METRICS)[number];
export const CHART_RANGES = ['24h', '7d', '14d'] as const;
export type ChartRange = (typeof CHART_RANGES)[number];
/**
 * 总览 chart data, oldest first. `buckets` are UTC hours ('YYYY-MM-DDTHH') for 24h and UTC days ('YYYY-MM-DD') for 7d / 14d; every
 * series has one value per bucket, null where the counters were not running yet (shown —). `total` for replies is the sum of the
 * characters; for chat_users it is the number of DISTINCT players (a player who chatted with two characters is in both of their
 * series and once in the total). `replies` counts published replies, by the bucket of their admission. Character NAMES, never ids.
 */
export type ChartSeries = { name: string; values: (number | null)[] };
export type ChartView = {
  metric: ChartMetric;
  range: ChartRange;
  bucket: 'hour' | 'day';
  /** The first UTC day the per-character counters ran; null while unknown. */
  since: string | null;
  buckets: string[];
  total: (number | null)[];
  characters: ChartSeries[];
};

/** Provider spend of one user type on one day, in USD micros: what the budget ledger charged, text (draft, review) and voice. */
export type SpendByType = { userType: StatsUserType; textMicros: number; voiceMicros: number };
/**
 * 消耗表 by user type, newest day first. `types` is null for a day before the per-type counters ran (shown —). `unclassifiedMicros`
 * = calls of replies admitted before the counters (no frozen type). The rate is the same estimate the 消耗表 page uses.
 */
export type SpendDay = {
  day: string;
  types: SpendByType[] | null;
  unclassifiedMicros: number | null;
  totalMicros: number | null;
};
/**
 * A real price change (Part 24b-1): a new version of a provider / model / phase price row whose number differs from the version
 * before it, on the UTC day it takes effect. A renewal at the same number is not a change. Names only, never an id.
 */
export type SpendPriceChange = { day: string; provider: string; model: string; phase: 'draft' | 'review' | 'speech' };
export type SpendView = {
  since: string | null;
  range: StatsRange;
  usdCny: number;
  days: SpendDay[];
  /** The range's sum over the days that are known, by type; null when no day is. */
  totals: SpendByType[] | null;
  /** Part 24b-1: ALERT_DAILY_SPEND_MICROS while the owner alerts are on (the line 消耗表 draws); null = no alert is configured. */
  alertMicros: number | null;
  /** Part 24b-1: the real price changes inside the range, oldest first; empty = nothing to mark. */
  priceChanges: SpendPriceChange[];
};

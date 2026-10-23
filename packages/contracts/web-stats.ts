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

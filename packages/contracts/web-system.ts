/**
 * The administrator console's system pages (Part 22b): 概览, 系统状态, 积分发放. Counts, times and prices only: no player id,
 * email, nickname, IP hash or message content appears in any of these shapes.
 */
export const POINTS_GRANT_LIMITS = { min: 1, max: 10_000, noteMax: 100 } as const;
export const BUDGET_TOPUP_LIMITS = { minDollars: 1, maxDollars: 50 } as const;
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export type PointsTarget =
  | { kind: 'all' }
  | { kind: 'tier'; tier: 'registered' | 'daily_refill' }
  | { kind: 'player'; playerNumber: string }
  | { kind: 'email'; email: string };

export interface PointsSkipped {
  /** Guests (trial players without a points account). */
  guests: number;
  /** Unlimited holders and accounts: never charged, so there is nothing to give. */
  unlimited: number;
  /** daily_refill players already at their cap (nothing added; points held are never taken). */
  atCap: number;
}
/** What a grant did, or (preview) would do. Counts only. */
export interface PointsGrantResult {
  amount: number;
  /** Players the target selected that hold points. */
  players: number;
  /** Of those, how many actually received points. */
  granted: number;
  totalPoints: number;
  skipped: PointsSkipped;
  duplicate: boolean;
}
/** The only thing a lookup says about a player. Never the email, a review code or any chat. */
export interface PointsLookup {
  playerNumber: string;
  tier: 'guest' | 'registered' | 'daily_refill' | 'unlimited' | 'account';
  balance: number | null;
}
export interface PointsPreview extends PointsGrantResult {
  /** Present for a player-number or email target. */
  player?: PointsLookup;
}
export interface PointsResetResult {
  /** Accounts that were below their level and received points. */
  affected: number;
  totalPoints: number;
  skipped: PointsSkipped & { alreadyFull: number };
  /** Total points × the highest 30-day average micro-USD per point across enabled models; null = no data yet (暂无数据). */
  worstCaseMicros: number | null;
  duplicate: boolean;
}

export type SystemPriceRow = {
  provider: string;
  model: string;
  phase: string;
  unit: string;
  upperMicrosPerUnit: number;
  version: number;
  validUntil: number;
  state: 'in_force' | 'expired';
  /** Whole days from now until validUntil (negative once expired). */
  daysLeft: number;
  /** Within 60 days of expiry (or expired): the row the 续期价格 button would renew. */
  expiring: boolean;
};
export type SystemBudgetRow = {
  provider: 'deepseek' | 'fish';
  policy: 'capped' | 'unlimited';
  spentMicros: number;
  heldMicros: number;
  allowanceMicros: number | null;
  remainingMicros: number | null;
};
export type SystemUnknownKind = {
  kind: 'webProvider' | 'external' | 'embed';
  count: number;
  oldestAgeMs: number | null;
};
export type SystemRetention = {
  failing: number;
  oldestAgeBucket: '<1d' | '1-7d' | '7-30d' | '>30d' | null;
  lastSuccessAt: number | null;
  purging: number;
  oldestPurgingMinutes: number | null;
} | null;
export type SystemWarnings = { priceExpiring: number; retentionFailing: number; unknownNew: number };
export type SystemFlags = {
  signupBonus: boolean;
  playerModelChoice: boolean;
  playerTextModels: string[] | null;
  fishVoiceModel: string;
  chatReview: boolean;
  turnstile: boolean;
  alerts: boolean;
  /** The ADMIN_EMAIL send binding alerts use exists (the address is never shown). */
  alertMailBindingPresent: boolean;
  alertRecipientSet: boolean;
};
export type SystemSecurity = {
  turnstile: boolean;
  /** UTC today / the last 7 UTC days including today. `unavailable` = siteverify could not be reached. */
  failuresToday: number;
  failuresLast7Days: number;
  unavailableToday: number;
  unavailableLast7Days: number;
};
export type BudgetTopUpResult = {
  provider: 'deepseek' | 'fish';
  addedMicros: number;
  allowanceMicros: number;
  remainingMicros: number;
  duplicate: boolean;
};
export type PriceRenewalRow = {
  provider: string;
  model: string;
  phase: string;
  result: 'renewed' | 'not-due' | 'duplicate';
  validUntil: number;
  upperMicrosPerUnit: number;
  version: number;
};
export type RenewPricesResult = { rows: PriceRenewalRow[]; duplicate: boolean };

/** 概览: today (UTC), the status warnings in one line, nothing else. */
export type OverviewView = {
  day: string;
  today: { replies: number; voiceReplies: number; failedReplies: number; spendMicros: number | null };
  warnings: SystemWarnings;
};

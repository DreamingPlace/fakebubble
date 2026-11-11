/**
 * The administrator console's system pages (Part 22b): 概览, 系统状态, 积分发放. Counts, times and prices only: no player id,
 * email, nickname, IP hash or message content appears in any of these shapes.
 */
export const POINTS_GRANT_LIMITS = { min: 1, max: 10_000, noteMax: 100 };
export const BUDGET_TOPUP_LIMITS = { minDollars: 1, maxDollars: 50 };
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

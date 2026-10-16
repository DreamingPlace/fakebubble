import { WEB_LIMITS } from '../../../config/web-v1.ts';
import type { BusinessStore } from '../platform/store-contract.ts';

/**
 * The free tier of a guest (Part 17b, flag SIGNUP_BONUS_ENABLED, default off).
 *
 * OFF (every existing deployment and test): 3 trial replies per guest, 3 per IP lifetime, no signup bonus, no signup limit
 * per IP. Nothing in this file is consulted.
 *
 * ON: the guest trial is publicTrialReplies (5) per guest and per IP, lifetime, and a guest that signed up with a verified
 * email also holds a lifetime allowance of signupBonusReplies (10): no time window, any character, spent AFTER the trial
 * replies, never touching the per-IP quota; at most signupsPerIpPerDay signups complete per IP per UTC day.
 *
 * Why two kinds of trial reply. web_principals.trial_used/trial_reserved and the IP window tables are CHECK-limited to 3 by
 * migration 100 and cannot be rebuilt (twelve tables reference web_principals and a deployed Durable Object cannot switch
 * foreign keys off). So replies 1-3 keep the existing counters, windows and per-IP lifetime quota unchanged, and the extra
 * trial replies (publicTrialReplies - trialReplies = 2) and the bonus are "just more entitlements" checked before any
 * reservation: an operation admitted on one has metering_type 'entitled' (no IP window) plus a web_free_operations row, so
 * budget reservation, idempotency, settlement and release are the ones every entitled operation already has, and what is
 * left is DERIVED from those rows - never from a counter that could drift.
 */
export interface FreeTier {
  on: boolean;
  /** Replies the existing counters can hold (WEB_LIMITS.trialReplies, 3). */
  counterReplies: number;
  /** Extra trial replies per guest and per IP (derived accounting). */
  extraTrialReplies: number;
  /** What the guest is told it has: counter + extra. */
  trialReplies: number;
  bonusReplies: number;
  signupsPerIpPerDay: number;
  /** How long a guest's trial lasts from its first reply: publicTrialWindowMs (7 d) when on, 2 h when off. */
  trialWindowMs: number;
}
const TRIAL_WINDOW_OFF_MS = 2 * 60 * 60_000;
export function freeTier(store: { publicFreeTier?: boolean }): FreeTier {
  const counter = WEB_LIMITS.trialReplies;
  return store.publicFreeTier === true
    ? {
        on: true,
        counterReplies: counter,
        extraTrialReplies: WEB_LIMITS.publicTrialReplies - counter,
        trialReplies: WEB_LIMITS.publicTrialReplies,
        bonusReplies: WEB_LIMITS.signupBonusReplies,
        signupsPerIpPerDay: WEB_LIMITS.signupsPerIpPerDay,
        trialWindowMs: WEB_LIMITS.publicTrialWindowMs,
      }
    : {
        on: false,
        counterReplies: counter,
        extraTrialReplies: 0,
        trialReplies: counter,
        bonusReplies: 0,
        signupsPerIpPerDay: Number.POSITIVE_INFINITY,
        trialWindowMs: TRIAL_WINDOW_OFF_MS,
      };
}

type Reader = Pick<BusinessStore, 'get'>;
type Flagged = Reader & { publicFreeTier?: boolean };
const tableExists = (store: Reader, name: string) =>
  !!store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name);
/** Tables of 121_signup_bonus.sql: an older database has no free tier beyond the counters. */
export const signupBonusTablesExist = (store: Reader) => tableExists(store, 'web_signup_bonus');

/** True when the flag is on and this principal was granted the signup bonus (a guest with a verified-email signup). */
export function hasSignupBonus(store: Flagged, principalId: string) {
  return (
    store.publicFreeTier === true &&
    signupBonusTablesExist(store) &&
    !!store.get('SELECT 1 FROM web_signup_bonus WHERE principal_id=?', principalId)
  );
}
/**
 * Long-term memory (recall, and the embeddings that serve it) is for account and invite principals and for guests who hold
 * the signup bonus. A plain trial guest keeps short-term context only. Writing is unconditional; only reading is gated.
 */
export const recallsMemory = (store: Flagged, kind: string, principalId: string) =>
  kind !== 'guest' || hasSignupBonus(store, principalId);
const live = "o.quota_state IN ('reserved','used')";
/** Bonus replies reserved or used (an operation that failed or was cancelled is 'released' and not counted). */
export function bonusSpent(store: Reader, principalId: string) {
  return (
    store.get<{ n: number }>(
      `SELECT count(*) n FROM web_free_operations f JOIN web_operations o ON o.id=f.operation_id
      WHERE f.tier='bonus' AND f.principal_id=? AND ${live}`,
      principalId,
    )?.n ?? 0
  );
}
export function bonusRemaining(store: Flagged, principalId: string) {
  return hasSignupBonus(store, principalId)
    ? Math.max(0, freeTier(store).bonusReplies - bonusSpent(store, principalId))
    : 0;
}
/** Extra trial replies reserved or used by this guest, and by every guest behind this IP (lifetime). */
export function extraTrialSpent(store: Reader, scope: { principalId: string } | { ipHash: string }) {
  const [column, value] = 'principalId' in scope ? ['f.principal_id', scope.principalId] : ['f.ip_hash', scope.ipHash];
  return (
    store.get<{ n: number }>(
      `SELECT count(*) n FROM web_free_operations f JOIN web_operations o ON o.id=f.operation_id
      WHERE f.tier='trial_extra' AND ${column}=? AND ${live}`,
      value,
    )?.n ?? 0
  );
}
/** How many extra trial replies this guest may still send from this IP (0 when the flag is off or the tables are absent). */
export function extraTrialRemaining(store: Flagged, principalId: string, ipHash: string) {
  const tier = freeTier(store);
  if (!tier.on || !signupBonusTablesExist(store)) return 0;
  return Math.max(
    0,
    Math.min(
      tier.extraTrialReplies - extraTrialSpent(store, { principalId }),
      tier.extraTrialReplies - extraTrialSpent(store, { ipHash }),
    ),
  );
}

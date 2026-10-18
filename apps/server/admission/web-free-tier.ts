import { WEB_LIMITS } from '../../../config/web-v1.ts';
import type { BusinessStore } from '../platform/store-contract.ts';
import { effectiveTier } from './web-model-settings.ts';

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
/** An email login (web_player_logins, schema 118) is bound to this principal. */
const hasLoginRow = (store: Reader, principalId: string) =>
  tableExists(store, 'web_player_logins') &&
  !!store.get('SELECT 1 FROM web_player_logins WHERE principal_id=?', principalId);
/** The invite grant of an invited principal is active (not revoked, not expired). `now` unknown: only a revocation counts. */
export function inviteGrantActive(store: Reader, principalId: string, now?: number) {
  return (
    tableExists(store, 'web_invite_grants') &&
    !!store.get(
      `SELECT 1 FROM web_invite_grants g JOIN web_principals p ON p.id=g.principal_id
      WHERE g.principal_id=? AND g.player_id=p.player_id AND g.world_id=p.world_id AND p.kind='invite'
        AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>?)`,
      principalId,
      now ?? 0,
    )
  );
}
/**
 * Part 17h. A REGISTERED player: the free tier is on and the principal either holds the signup bonus (a row, as before) or
 * has an email login and is a guest (signed up before 17b or while SIGNUP_BONUS_ENABLED was off) or an invited player whose
 * grant has lapsed (revoked or expired). A registered player is never answered TRIAL_EXPIRED / WEB_INVITE_ACCESS_REQUIRED;
 * it is metered in points (or by the old bonus replies) and its content does not expire with the trial window. An invited
 * player whose grant is still active is NOT registered by a login alone: it stays unmetered, as before.
 */
export function isRegistered(store: Flagged, principalId: string, now?: number) {
  if (store.publicFreeTier !== true || !signupBonusTablesExist(store)) return false;
  if (store.get('SELECT 1 FROM web_signup_bonus WHERE principal_id=?', principalId)) return true;
  if (!hasLoginRow(store, principalId)) return false;
  const kind = store.get<{ kind: string }>('SELECT kind FROM web_principals WHERE id=?', principalId)?.kind;
  return kind === 'guest' || (kind === 'invite' && !inviteGrantActive(store, principalId, now));
}
/** The principal HAS an invite grant and none of its grants is active any more (revoked or expired). */
export function inviteGrantLapsed(store: Reader, principalId: string, now?: number) {
  return (
    tableExists(store, 'web_invite_grants') &&
    !!store.get('SELECT 1 FROM web_invite_grants WHERE principal_id=?', principalId) &&
    !inviteGrantActive(store, principalId, now)
  );
}
/** The guest's trial window is over (or its content is being removed): it can no longer chat as a trial guest. */
export function guestTrialOver(store: Reader, principalId: string, now: number) {
  const row = store.get<{ state: string; expires_at: number | null }>(
    'SELECT state,expires_at FROM web_guest_retention WHERE principal_id=?',
    principalId,
  );
  return (
    !!row &&
    (row.state === 'purging' ||
      row.state === 'purged' ||
      (row.state === 'active' && row.expires_at !== null && row.expires_at <= now))
  );
}
/** An invited principal whose grant is no longer active and who is registered: it chats as a registered player. */
export function isLapsedRegisteredInvite(store: Flagged, principalId: string, now?: number) {
  return (
    store.get<{ kind: string }>('SELECT kind FROM web_principals WHERE id=?', principalId)?.kind === 'invite' &&
    !inviteGrantActive(store, principalId, now) &&
    isRegistered(store, principalId, now)
  );
}
/**
 * Long-term memory (recall, and the embeddings that serve it) is for every tier but a plain trial guest (Part 22a: read from
 * effectiveTier, the one place that says which tier a principal is). A plain trial guest keeps short-term context only. Writing is unconditional; only reading is gated.
 */
export const recallsMemory = (store: Flagged, kind: string, principalId: string) =>
  kind !== 'guest' || (effectiveTier(store as Parameters<typeof effectiveTier>[0], principalId)?.tier ?? 'guest') !== 'guest';
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

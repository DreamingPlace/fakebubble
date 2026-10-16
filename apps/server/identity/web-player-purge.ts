import type { BusinessStore } from '../platform/store-contract.ts';
import { purgeReviewRows, reviewRowsRemain } from '../review/web-chat-review.ts';

export { GUEST_GRACE_MS } from '../../../config/web-public.ts';

const tableExists = (store: Pick<BusinessStore, 'get'>, name: string) =>
  !!store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name);
/** Tables created by 118_player_logins.sql: an older database has nothing to purge there. */
export const playerLoginsExist = (store: Pick<BusinessStore, 'get'>) => tableExists(store, 'web_player_logins');

/** A login whose player was not seen for this long (and who has no active invite grant) is purged with its data. */
export const PLAYER_INACTIVE_MS = 180 * 24 * 60 * 60_000;

/**
 * RETENTION-STATE DESIGN. A guest principal that has an email login is kept when its trial ends:
 *   - web_guest_retention is NOT changed at trial end: it stays 'active' with expires_at in the past. Nothing new is
 *     written and no new state is added (the table's state CHECK is part of an older, deployed migration).
 *   - "retained" is derived: guest + state 'active' + a web_player_logins row. The cleaners' due-selection skips such
 *     guests at expires_at, requireWebContent(..., 'read') lets them read, and every other requireWebContent caller
 *     ('live') still answers TRIAL_EXPIRED, which is what admission, queues and publishers use. So chatting stops with the
 *     normal trial-ended message while history, login, nickname and invite redemption keep working.
 *   - A retained guest leaves the 'active' state in exactly two ways: it redeems an invite (state 'protected', kind
 *     'invite': the normal invited rules apply from then on), or it is inactive for PLAYER_INACTIVE_MS (below).
 *   - Inactivity: a guest with a login whose last_seen_at is older than PLAYER_INACTIVE_MS goes through the SAME audited,
 *     fail-closed T1/T2/F path as an expired trial. A guest never has an invite grant (redeeming turns it into an
 *     'invite' principal, which is protected and outside the guest cleaners), so "no active grant" holds by kind.
 *   - A guest WITHOUT a login has no web_player_logins row, so every predicate below is false and it purges at
 *     expires_at exactly as before.
 */
export function playerLoginRetainsGuest(store: Pick<BusinessStore, 'get'>, principalId: string) {
  return playerLoginsExist(store) && !!store.get('SELECT 1 FROM web_player_logins WHERE principal_id=?', principalId);
}
/** last_seen_at of the principal's login, or null when it has none (or the schema predates 118). */
export function playerLastSeenAt(store: Pick<BusinessStore, 'get'>, principalId: string) {
  if (!playerLoginsExist(store)) return null;
  return (
    store.get<{ last_seen_at: number }>('SELECT last_seen_at FROM web_player_logins WHERE principal_id=?', principalId)
      ?.last_seen_at ?? null
  );
}
/**
 * The cleaners' "who is due" predicate over web_guest_retention `r` (state 'purging' always continues). Without the
 * 118 tables it is the old predicate unchanged.
 */
export function guestPurgeDue(store: Pick<BusinessStore, 'get'>, now: number, graceMs = 0) {
  if (!playerLoginsExist(store))
    return { sql: "(r.state='purging' OR r.state='active' AND r.expires_at<=?)", args: [now - graceMs] };
  return {
    sql: `(r.state='purging'
      OR r.state='active' AND r.expires_at<=?
        AND NOT EXISTS (SELECT 1 FROM web_player_logins l WHERE l.principal_id=r.principal_id)
      OR r.state IN ('unstarted','active')
        AND EXISTS (SELECT 1 FROM web_player_logins l WHERE l.principal_id=r.principal_id AND l.last_seen_at<=?))`,
    args: [now - graceMs, now - PLAYER_INACTIVE_MS],
  };
}

/**
 * A player's email login, their email challenges and their 名片 revisions are the player's own data: they go with the
 * player. Challenges are matched by principal and by the address of the login being removed (a reset challenge has
 * no principal). Throttle rows hold only HMAC keys and carry no principal, so they age out on their own.
 */
export function purgePlayerLogins(
  store: Pick<BusinessStore, 'get' | 'run' | 'all'>,
  scope: { principalId: string; worldId: string },
  /** Part 17g: told the fixed name of each statement group just before it runs (retention diagnostics). */
  mark: (group: string) => void = () => {},
) {
  mark('player_profiles');
  if (tableExists(store, 'player_profile_versions')) {
    if (tableExists(store, 'player_profile_requests'))
      store.run('DELETE FROM player_profile_requests WHERE world_id=?', scope.worldId);
    store.run('DELETE FROM player_profile_versions WHERE world_id=?', scope.worldId);
  }
  // Part 17b: the signup bonus entitlement and its operation markers go with the player. The email HMAC in
  // web_bonus_emails is NOT removed: it is the only thing kept, so a deleted address cannot collect the bonus twice.
  mark('free_ops');
  if (tableExists(store, 'web_signup_bonus')) {
    // (the 'trial_extra' rows stay: they hold only the keyed IP hash, like web_ip_lifetime_quota, so a purge never resets an IP)
    store.run("DELETE FROM web_free_operations WHERE tier='bonus' AND principal_id=?", scope.principalId);
    store.run('DELETE FROM web_signup_bonus WHERE principal_id=?', scope.principalId);
  }
  // Part 21b: the player's model choice, points balance and points events go with the player. The per-operation
  // rows (web_operation_models, web_provider_backups) and the usage aggregates hold ids/enums/counts only, no principal.
  mark('points');
  if (tableExists(store, 'web_points_balance')) {
    store.run('DELETE FROM web_points_events WHERE principal_id=?', scope.principalId);
    store.run('DELETE FROM web_points_balance WHERE principal_id=?', scope.principalId);
    store.run('DELETE FROM web_points_policy WHERE principal_id=?', scope.principalId);
    store.run('DELETE FROM web_player_model WHERE principal_id=?', scope.principalId);
  }
  // Part 19: the player's live review code and banner mark go with the player (the archive copy carries no identity).
  mark('review_codes');
  purgeReviewRows(store, scope.principalId);
  mark('player_logins');
  if (!playerLoginsExist(store)) return;
  const login = store.get<{ email_norm: string }>(
    'SELECT email_norm FROM web_player_logins WHERE principal_id=?',
    scope.principalId,
  );
  store.run('DELETE FROM web_email_challenges WHERE principal_id=?', scope.principalId);
  if (login) store.run('DELETE FROM web_email_challenges WHERE email_norm=?', login.email_norm);
  store.run('DELETE FROM web_player_logins WHERE principal_id=?', scope.principalId);
}

/**
 * Part 17f. The moment a purge starts (T1: the player's own deletion, or an expired/inactive guest) the address stops
 * being registered: the login and every email challenge of the principal and of that address go in the SAME transaction
 * as the fence. Registration must never depend on the later, heavier database clear (T2), which can fail closed on its
 * own audits and is retried by the alarm. The rest of the player's data (名片, bonus entitlement, review rows) still goes
 * with T2 through purgePlayerLogins; the bonus address digest is untouched, so a deleted address cannot collect it twice.
 */
export function releasePlayerLogin(store: Pick<BusinessStore, 'get' | 'run'>, principalId: string) {
  if (!playerLoginsExist(store)) return;
  const login = store.get<{ email_norm: string }>(
    'SELECT email_norm FROM web_player_logins WHERE principal_id=?',
    principalId,
  );
  store.run('DELETE FROM web_email_challenges WHERE principal_id=?', principalId);
  if (login) {
    store.run('DELETE FROM web_email_challenges WHERE email_norm=?', login.email_norm);
    store.run('DELETE FROM web_player_logins WHERE principal_id=?', principalId);
  }
}

/**
 * Read-only numbers for the operator (inspect) and the daily digest; never an id or an address.
 * oldestPurgingMinutes is the age of the oldest unfinished purge: the time its sessions were revoked (account deletion),
 * else the end of its trial window. There is no purge-start column (and no migration), so this is that approximation.
 */
export function purgeDiagnostics(store: { all<T>(sql: string, ...params: (string | number)[]): T[] }, now: number) {
  const has = (name: string) => store.all("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name).length > 0;
  if (!has('web_guest_retention')) return { purging: 0, oldestPurgingMinutes: null, loginsOfPurgedPrincipals: 0 };
  const row = store.all<{ n: number; since: number | null }>(
    `SELECT count(*) n, min(coalesce((SELECT max(s.revoked_at) FROM web_sessions s WHERE s.principal_id=r.principal_id),r.expires_at)) since
    FROM web_guest_retention r WHERE r.state='purging'`,
  )[0]!;
  const logins = has('web_player_logins')
    ? store.all<{ n: number }>(
        `SELECT count(*) n FROM web_player_logins l
        JOIN web_guest_retention r ON r.principal_id=l.principal_id WHERE r.state IN ('purging','purged')`,
      )[0]!.n
    : 0;
  return {
    purging: row.n,
    oldestPurgingMinutes:
      row.n === 0 || row.since === null ? null : Math.max(0, Math.floor((now - row.since) / 60_000)),
    loginsOfPurgedPrincipals: logins,
  };
}

/** True while a login or challenge of any of these principals remains: the audits fail closed on it. */
export function playerLoginsRemain(store: Pick<BusinessStore, 'get'>, principalIds: string[]) {
  if (principalIds.length === 0) return false;
  const marks = principalIds.map(() => '?').join(',');
  if (reviewRowsRemain(store, principalIds)) return true;
  if (
    tableExists(store, 'web_points_balance') &&
    ['web_points_events', 'web_points_balance', 'web_points_policy', 'web_player_model'].some((table) =>
      store.get(`SELECT 1 FROM ${table} WHERE principal_id IN (${marks}) LIMIT 1`, ...principalIds),
    )
  )
    return true;
  if (
    tableExists(store, 'web_signup_bonus') &&
    (store.get(`SELECT 1 FROM web_signup_bonus WHERE principal_id IN (${marks}) LIMIT 1`, ...principalIds) ||
      store.get(
        `SELECT 1 FROM web_free_operations WHERE tier='bonus' AND principal_id IN (${marks}) LIMIT 1`,
        ...principalIds,
      ))
  )
    return true;
  if (!playerLoginsExist(store)) return false;
  return (
    !!store.get(`SELECT 1 FROM web_player_logins WHERE principal_id IN (${marks}) LIMIT 1`, ...principalIds) ||
    !!store.get(`SELECT 1 FROM web_email_challenges WHERE principal_id IN (${marks}) LIMIT 1`, ...principalIds)
  );
}

/**
 * True while a guest WITHOUT a login is past its trial but still inside the grace period (state 'active', expires_at
 * <= now < expires_at + graceMs). Always false with graceMs 0 (flag off) and for a guest that already has a login (that
 * one is a kept account, not in grace). Such a guest still cannot chat or read
 * history; it can only sign up, which turns it into a kept account.
 */
export function guestInGrace(store: Pick<BusinessStore, 'get'>, principalId: string, now: number, graceMs: number) {
  if (graceMs <= 0 || playerLoginRetainsGuest(store, principalId)) return false;
  const row = store.get<{ state: string; expires_at: number | null; kind: string }>(
    `SELECT r.state,r.expires_at,p.kind FROM web_guest_retention r
    JOIN web_principals p ON p.id=r.principal_id AND p.world_id=r.world_id WHERE r.principal_id=?`,
    principalId,
  );
  return (
    !!row &&
    row.kind === 'guest' &&
    row.state === 'active' &&
    row.expires_at !== null &&
    row.expires_at <= now &&
    now < row.expires_at + graceMs
  );
}

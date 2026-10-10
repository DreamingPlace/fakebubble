import type { BusinessStore } from '../platform/store-contract.ts';

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
export function guestPurgeDue(store: Pick<BusinessStore, 'get'>, now: number) {
  if (!playerLoginsExist(store))
    return { sql: "(r.state='purging' OR r.state='active' AND r.expires_at<=?)", args: [now] };
  return {
    sql: `(r.state='purging'
      OR r.state='active' AND r.expires_at<=?
        AND NOT EXISTS (SELECT 1 FROM web_player_logins l WHERE l.principal_id=r.principal_id)
      OR r.state IN ('unstarted','active')
        AND EXISTS (SELECT 1 FROM web_player_logins l WHERE l.principal_id=r.principal_id AND l.last_seen_at<=?))`,
    args: [now, now - PLAYER_INACTIVE_MS],
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
) {
  if (tableExists(store, 'player_profile_versions')) {
    if (tableExists(store, 'player_profile_requests'))
      store.run('DELETE FROM player_profile_requests WHERE world_id=?', scope.worldId);
    store.run('DELETE FROM player_profile_versions WHERE world_id=?', scope.worldId);
  }
  if (!playerLoginsExist(store)) return;
  const login = store.get<{ email_norm: string }>(
    'SELECT email_norm FROM web_player_logins WHERE principal_id=?',
    scope.principalId,
  );
  store.run('DELETE FROM web_email_challenges WHERE principal_id=?', scope.principalId);
  if (login) store.run('DELETE FROM web_email_challenges WHERE email_norm=?', login.email_norm);
  store.run('DELETE FROM web_player_logins WHERE principal_id=?', scope.principalId);
}

/** True while a login or challenge of any of these principals remains: the audits fail closed on it. */
export function playerLoginsRemain(store: Pick<BusinessStore, 'get'>, principalIds: string[]) {
  if (!playerLoginsExist(store) || principalIds.length === 0) return false;
  const marks = principalIds.map(() => '?').join(',');
  return (
    !!store.get(`SELECT 1 FROM web_player_logins WHERE principal_id IN (${marks}) LIMIT 1`, ...principalIds) ||
    !!store.get(`SELECT 1 FROM web_email_challenges WHERE principal_id IN (${marks}) LIMIT 1`, ...principalIds)
  );
}

import type { BusinessStore } from '../platform/store-contract.ts';

const tableExists = (store: Pick<BusinessStore, 'get'>, name: string) =>
  !!store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name);
/** Tables created by 118_player_logins.sql: an older database has nothing to purge there. */
export const playerLoginsExist = (store: Pick<BusinessStore, 'get'>) => tableExists(store, 'web_player_logins');

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

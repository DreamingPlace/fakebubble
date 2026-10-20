import type { BusinessStore } from '../platform/store-contract.ts';

const tableExists = (store: Pick<BusinessStore, 'get'>, name: string) =>
  !!store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name);

/**
 * THE one way a holder's access ends (Part 22a), whichever page starts it: the old 玩家授权 revoke (by grant) and 邀请与额度's
 * 结束额度 (by invite code) both call this, inside their own transaction. For one invite code it revokes
 *  - the entitlement (migration 125), and
 *  - any legacy grant of the same code, with the sessions of that grant's principal and its recovery credential / receipts
 *    (what the old revoke always did).
 * The principal, its balance and its login are untouched: a player with a login signs in again as a registered player.
 * Returns what it found and whether anything was still live (false = a repeat of a revoke that already happened).
 */
export function endHolderAccess(store: Pick<BusinessStore, 'get' | 'run'>, now: number, inviteId: string) {
  const entitlement = tableExists(store, 'web_entitlements')
    ? store.get<{ id: string; revoked_at: number | null }>(
        'SELECT id,revoked_at FROM web_entitlements WHERE invite_id=?',
        inviteId,
      )
    : undefined;
  const grant = tableExists(store, 'web_invite_grants')
    ? store.get<{ id: string; principal_id: string; revoked_at: number | null }>(
        'SELECT id,principal_id,revoked_at FROM web_invite_grants WHERE invite_id=?',
        inviteId,
      )
    : undefined;
  if (!entitlement && !grant) return { found: false as const, changed: false };
  const live = (entitlement && entitlement.revoked_at === null) || (grant && grant.revoked_at === null);
  if (!live) return { found: true as const, changed: false };
  if (entitlement)
    store.run('UPDATE web_entitlements SET revoked_at=? WHERE id=? AND revoked_at IS NULL', now, entitlement.id);
  if (grant) {
    store.run('UPDATE web_invite_grants SET revoked_at=? WHERE id=? AND revoked_at IS NULL', now, grant.id);
    // The player's every session and recovery credential end with the grant, as they always did.
    store.run(
      'UPDATE web_sessions SET revoked_at=? WHERE principal_id=? AND revoked_at IS NULL',
      now,
      grant.principal_id,
    );
    for (const table of ['web_invite_credentials', 'web_invite_identity_receipts'])
      if (tableExists(store, table))
        store.run(`UPDATE ${table} SET revoked_at=? WHERE grant_id=? AND revoked_at IS NULL`, now, grant.id);
  }
  return { found: true as const, changed: true };
}

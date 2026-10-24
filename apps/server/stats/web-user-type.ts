import type { StatsUserType } from '../../../packages/contracts/web-stats.ts';
import type { BusinessStore } from '../platform/store-contract.ts';
import { effectiveTier, type ModelFlags } from '../admission/web-model-settings.ts';
import { policyKind } from '../admission/web-points.ts';

/**
 * Part 22d: who a reply was for, decided ONCE at admission and frozen next to the operation (web_operation_user_types). First match
 * wins:
 *   test          the player redeemed a code of an invite batch marked as test (ever: a revoked or lapsed test entitlement still
 *                 counts, the player is in the test group)
 *   unlimited     never charged: an unlimited entitlement, a legacy invite / account, or an 'unlimited' points policy
 *   daily_refill  an active 每天补充 entitlement
 *   registered    a signed-up player (signup bonus or email login)
 *   guest         anyone else
 * There is no 管理员 type: an administrator is a member of the console (web_admin_members), a player is a principal of the site, and
 * nothing in the schema ties the two (the only thing they could share is an email address, which two separate verifications set
 * and which is not a link the system keeps). A type is not invented from that.
 */
type Reader = Pick<BusinessStore, 'get' | 'all'>;
const tableExists = (store: Pick<BusinessStore, 'get'>, name: string) =>
  !!store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name);

export function userTypeOf(store: Reader & ModelFlags, principalId: string, now: number): StatsUserType {
  if (
    tableExists(store, 'web_entitlements') &&
    store.get(
      `SELECT 1 FROM web_entitlements e JOIN web_invite_batches b ON b.id=e.batch_id
      WHERE e.principal_id=? AND e.source='invite' AND b.test=1 LIMIT 1`,
      principalId,
    )
  )
    return 'test';
  const tier = effectiveTier(store, principalId, now);
  if (tier?.unlimited || (tableExists(store, 'web_points_policy') && policyKind(store, principalId) === 'unlimited'))
    return 'unlimited';
  if (tier?.kind === 'daily_refill') return 'daily_refill';
  return tier?.kind === 'registered' ? 'registered' : 'guest';
}

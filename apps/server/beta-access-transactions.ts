import type { Clock } from '../../packages/contracts/index.ts';
import type { BusinessStore } from './store-contract.ts';
import { ensure } from '../../packages/domain/errors.ts';

export interface AccessTransaction { <T>(clock: Clock, work: () => T): T }
const bindings = new WeakMap<BusinessStore, AccessTransaction>();
/** Internal runtime binding, never a player operation. Implementations must preserve outermost permission journaling. */
export function bindBetaAccessTransactions(store: BusinessStore, transaction: AccessTransaction) {
  ensure(!bindings.has(store), 'ACCESS_JOURNAL_ALREADY_BOUND');
  bindings.set(store, transaction);
}
export function betaAccessTransaction<T>(store: BusinessStore, clock: Clock, work: () => T): T {
  const bound = bindings.get(store);
  if (bound) return bound(clock, work);
  // Local unbound Stores remain usable for preparation/fixtures; cloud Stores always fail closed.
  ensure(store.requiresAccessControl !== true, 'BETA_ACCESS_CONTROL_REQUIRED');
  return store.transaction(work);
}

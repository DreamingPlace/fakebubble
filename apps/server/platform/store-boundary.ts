import type { BusinessStore, SQLInputValue } from './store-contract.ts';

/**
 * Principal-scoped context for private reads and writes. `worldId` is the key every user table is reached by
 * (one world per principal, see docs/DATA_BOUNDARY.md); a `CharacterScope` or `PlayerContext` satisfies it.
 */
export interface UserContext {
  readonly worldId: string;
}

type RunResult = { changes: number | bigint; lastInsertRowid: number | bigint };

/** Access to tables whose rows belong to exactly one player principal. Every call names that principal's context. */
export interface UserStore {
  run(context: UserContext, sql: string, ...params: SQLInputValue[]): RunResult;
  get<T>(context: UserContext, sql: string, ...params: SQLInputValue[]): T | undefined;
  all<T>(context: UserContext, sql: string, ...params: SQLInputValue[]): T[];
  transaction<T>(context: UserContext, work: () => T): T;
}

/** Access to tables shared by all players (catalog, invites, admin, quotas, budget, scheduler, retention). */
export interface GlobalStore {
  run(sql: string, ...params: SQLInputValue[]): RunResult;
  get<T>(sql: string, ...params: SQLInputValue[]): T | undefined;
  all<T>(sql: string, ...params: SQLInputValue[]): T[];
  transaction<T>(work: () => T): T;
}

/** Thin wrapper: same connection, same transactions; the context is carried for the call site, not yet enforced. */
export function userStore(store: BusinessStore): UserStore {
  return {
    run: (_context, sql, ...params) => store.run(sql, ...params),
    get: <T>(_context: UserContext, sql: string, ...params: SQLInputValue[]) => store.get<T>(sql, ...params),
    all: <T>(_context: UserContext, sql: string, ...params: SQLInputValue[]) => store.all<T>(sql, ...params),
    transaction: <T>(_context: UserContext, work: () => T) => store.transaction(work),
  };
}

/** Thin wrapper: same connection, same transactions. */
export function globalStore(store: BusinessStore): GlobalStore {
  return {
    run: (sql, ...params) => store.run(sql, ...params),
    get: <T>(sql: string, ...params: SQLInputValue[]) => store.get<T>(sql, ...params),
    all: <T>(sql: string, ...params: SQLInputValue[]) => store.all<T>(sql, ...params),
    transaction: <T>(work: () => T) => store.transaction(work),
  };
}

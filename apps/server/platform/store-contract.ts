import type { SQLInputValue, SQLOutputValue } from 'node:sqlite';
import type { RecoveryPoint } from '../../../packages/contracts/player-api.ts';

// Type-only SQL values; the business contract does not load Node's SQLite implementation.
export type { SQLInputValue, SQLOutputValue };
export type SQLRow = Record<string, SQLOutputValue>;
export interface ReadDatabase {
  prepare(sql: string): {
    get(...params: SQLInputValue[]): SQLRow | undefined;
    iterate(...params: SQLInputValue[]): Iterable<SQLRow>;
  };
}
export interface BusinessStore {
  readonly beta: boolean;
  readonly web?: boolean;
  readonly requiresAccessControl?: boolean;
  readonly externalFeedbackScreenshots?: boolean;
  readonly betaExternalCalls: boolean;
  readonly recoveryPoint: RecoveryPoint | null;
  run(sql: string, ...params: SQLInputValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get<T>(sql: string, ...params: SQLInputValue[]): T | undefined;
  all<T>(sql: string, ...params: SQLInputValue[]): T[];
  transaction<T>(work: () => T): T;
}

import { cloudRecoveryPoint } from './recovery-point.ts';
import { cloudPlatformMigrations } from './schema.ts';
import { createHash } from 'node:crypto';
import { ensure } from '../../../packages/domain/errors.ts';
import type { BusinessStore, ReadDatabase, SQLInputValue, SQLRow } from '../platform/store-contract.ts';

export interface DurableSQLStorage {
  sql: {
    exec(
      query: string,
      ...bindings: (string | number | null | ArrayBuffer | ArrayBufferView)[]
    ): { toArray(): Record<string, unknown>[]; next(): IteratorResult<Record<string, unknown>> };
  };
  transactionSync<T>(callback: () => T): T;
}
export interface SQLMigration {
  version: number;
  sql: string;
}
const schemaVersion = 33;

function binding(value: SQLInputValue): string | number | null | ArrayBufferView {
  if (typeof value === 'bigint') {
    ensure(
      value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER),
      'SQL_INTEGER_OUT_OF_RANGE',
    );
    return Number(value);
  }
  if (typeof value === 'number')
    ensure(
      Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)),
      'SQL_INTEGER_OUT_OF_RANGE',
    );
  return value;
}
function row(value: Record<string, unknown>): SQLRow {
  return Object.fromEntries(
    Object.entries(value).map(([key, v]) => {
      if (v instanceof ArrayBuffer) return [key, new Uint8Array(v)];
      ensure(
        v === null || typeof v === 'string' || typeof v === 'number' || ArrayBuffer.isView(v),
        'SQL_RESULT_INVALID',
      );
      if (typeof v === 'number')
        ensure(Number.isFinite(v) && (!Number.isInteger(v) || Number.isSafeInteger(v)), 'SQL_INTEGER_OUT_OF_RANGE');
      return [key, v];
    }),
  ) as SQLRow;
}

/** One authoritative beta database. No filesystem, provider access, public routes or restore shortcut. */
export class DurableStore implements BusinessStore {
  readonly beta = true;
  readonly requiresAccessControl = true;
  readonly externalFeedbackScreenshots = true;
  readonly schemaVersion = schemaVersion;
  // Spending requires explicit runtime opt-in; database contents never enable external calls.
  readonly betaExternalCalls: boolean;
  get recoveryPoint() {
    return cloudRecoveryPoint(this);
  }
  readonly db: ReadDatabase;
  readonly #storage: DurableSQLStorage;
  #closed = false;
  constructor(
    storage: DurableSQLStorage,
    migrations: readonly SQLMigration[],
    instanceId: string,
    options: { externalCalls?: boolean } = {},
  ) {
    this.betaExternalCalls = options.externalCalls === true;
    ensure(/^[A-Za-z0-9_-]{1,128}$/.test(instanceId), 'INVALID_INSTANCE_ID');
    ensure(
      migrations.length === schemaVersion && migrations.every((m, i) => m.version === i + 1 && m.sql.trim().length > 0),
      'CLOUD_SCHEMA_REQUIRED',
    );
    this.#storage = storage;
    this.db = {
      prepare: (sql) => ({
        get: (...params) => this.get<SQLRow>(sql, ...params),
        iterate: (...params) => this.all<SQLRow>(sql, ...params),
      }),
    };
    this.transaction(() => {
      const initialized = this.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cf_schema_migrations'");
      if (!initialized) {
        ensure(
          !this.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*' LIMIT 1"),
          'CLOUD_EMPTY_INSTANCE_REQUIRED',
        );
        this.exec('CREATE TABLE cf_schema_migrations (version INTEGER PRIMARY KEY, sha256 TEXT NOT NULL) STRICT');
        for (const m of migrations) {
          this.exec(m.sql);
          this.run(
            'INSERT INTO cf_schema_migrations VALUES (?,?)',
            m.version,
            createHash('sha256').update(m.sql).digest('hex'),
          );
        }
        this.run('INSERT INTO beta_instance VALUES (1,?)', instanceId);
      }
      ensure(
        this.get<{ instance_id: string }>('SELECT instance_id FROM beta_instance WHERE singleton=1')?.instance_id ===
          instanceId,
        'CLOUD_INSTANCE_MISMATCH',
      );
      const applied = this.all<{ version: number; sha256: string }>(
        'SELECT * FROM cf_schema_migrations ORDER BY version',
      );
      ensure(
        applied.length === schemaVersion &&
          migrations.every(
            (m, i) =>
              applied[i]?.version === m.version &&
              applied[i]?.sha256 === createHash('sha256').update(m.sql).digest('hex'),
          ),
        'CLOUD_MIGRATION_MISMATCH',
      );
      ensure(
        this.get<{ foreign_keys: number }>('PRAGMA foreign_keys')?.foreign_keys === 1,
        'CLOUD_FOREIGN_KEYS_REQUIRED',
      );
      if (!this.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cf_platform_migrations'"))
        this.exec('CREATE TABLE cf_platform_migrations(version INTEGER PRIMARY KEY,sha256 TEXT NOT NULL) STRICT');
      const platform = this.all<{ version: number; sha256: string }>(
        'SELECT * FROM cf_platform_migrations ORDER BY version',
      );
      const hashes = cloudPlatformMigrations.map((sql) => createHash('sha256').update(sql).digest('hex'));
      ensure(
        platform.length <= hashes.length && platform.every((m, i) => m.version === i + 1 && m.sha256 === hashes[i]),
        'CLOUD_PLATFORM_MIGRATION_MISMATCH',
      );
      for (let i = platform.length; i < hashes.length; i++) {
        // Never discard earlier fixture/imported screenshot bytes. Such an instance needs an explicit conversion tool.
        if (i === 0)
          ensure(
            this.get<{ n: number }>('SELECT count(*) n FROM beta_feedback_screenshots')!.n === 0,
            'CLOUD_SCREENSHOT_CONVERSION_REQUIRED',
          );
        this.exec(cloudPlatformMigrations[i]!);
        this.run('INSERT INTO cf_platform_migrations VALUES (?,?)', i + 1, hashes[i]!);
      }
    });
  }
  all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    ensure(!this.#closed, 'STORE_CLOSED');
    // Consume before returning: DO cursors must not escape across await boundaries.
    return this.#storage.sql
      .exec(sql, ...params.map(binding))
      .toArray()
      .map(row) as T[];
  }
  get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    ensure(!this.#closed, 'STORE_CLOSED');
    const first = this.#storage.sql.exec(sql, ...params.map(binding)).next();
    return first.done ? undefined : (row(first.value) as T);
  }
  run(sql: string, ...params: SQLInputValue[]) {
    return this.transaction(() => {
      this.all(sql, ...params);
      return this.get<{ changes: number; lastInsertRowid: number }>(
        'SELECT changes() AS changes,last_insert_rowid() AS lastInsertRowid',
      )!;
    });
  }
  transaction<T>(work: () => T): T {
    ensure(!this.#closed, 'STORE_CLOSED');
    ensure(Object.prototype.toString.call(work) !== '[object AsyncFunction]', 'ASYNC_TRANSACTION_FORBIDDEN');
    return this.#storage.transactionSync(() => {
      const result = work();
      ensure(
        !(result !== null && (typeof result === 'object' || typeof result === 'function') && 'then' in result),
        'ASYNC_TRANSACTION_FORBIDDEN',
      );
      return result;
    });
  }
  exec(sql: string) {
    this.all(sql);
  }
  close() {
    this.#closed = true;
  }
}

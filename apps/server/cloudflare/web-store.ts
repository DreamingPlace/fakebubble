import { createHash, createHmac } from 'node:crypto';
import { ensure } from '../../../packages/domain/errors.ts';
import type { BusinessStore, SQLInputValue } from '../platform/store-contract.ts';
import type { DurableSQLStorage, SQLMigration } from './store.ts';
import { registerWebRuntime, type WebRuntimeStore } from '../platform/web-store-contract.ts';
import type { PrivateMediaObjects } from './media-objects.ts';
import { parseWebConcurrency, type WebConcurrency } from '../../../config/web-concurrency.ts';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const versions = [...Array.from({ length: 24 }, (_, i) => i + 1), ...Array.from({ length: 15 }, (_, i) => 100 + i)];

/** A separate schema113 authority. No beta namespace, filesystem, implicit seed or paid default. */
export class WebDurableStore implements BusinessStore, WebRuntimeStore {
  readonly beta = false;
  readonly web = true;
  readonly betaExternalCalls = false;
  readonly recoveryPoint = null;
  readonly providerRuntime = true;
  readonly instanceId: string;
  readonly recoveryEpoch: string;
  readonly providerAudio?: PrivateMediaObjects;
  readonly concurrency: WebConcurrency;
  private readonly storage: DurableSQLStorage;
  private closed = false;
  private readonly keys: { ipKey: Buffer; requestKey: Buffer } | null;

  constructor(
    storage: DurableSQLStorage,
    migrations: readonly SQLMigration[],
    identity: {
      instanceId: string;
      recoveryEpoch: string;
      keys?: { ipKey: Buffer; requestKey: Buffer };
      providerAudio?: PrivateMediaObjects;
      /** Validated Worker vars; absent means the deployment default (20 text, 4 audio). */
      concurrency?: WebConcurrency;
    },
  ) {
    ensure(
      [identity.instanceId, identity.recoveryEpoch].every((id) => /^[a-f0-9-]{36}$/.test(id)),
      'WEB_CLOUD_IDENTITY_INVALID',
    );
    ensure(
      migrations.length === versions.length &&
        migrations.every((m, i) => m.version === versions[i] && m.sql.trim().length > 0),
      'WEB_CLOUD_MIGRATIONS_REQUIRED',
    );
    this.storage = storage;
    this.concurrency = parseWebConcurrency(identity.concurrency);
    this.instanceId = identity.instanceId;
    this.recoveryEpoch = identity.recoveryEpoch;
    if (identity.providerAudio) this.providerAudio = identity.providerAudio;
    this.keys = identity.keys
      ? { ipKey: Buffer.from(identity.keys.ipKey), requestKey: Buffer.from(identity.keys.requestKey) }
      : null;
    ensure(
      !this.keys || (this.keys.ipKey.length === 32 && this.keys.requestKey.length === 32),
      'WEB_CLOUD_KEYS_INVALID',
    );
    this.transaction(() => {
      if (!this.get("SELECT 1 FROM sqlite_master WHERE name='cf_web_migrations'")) {
        ensure(
          !this.get("SELECT 1 FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' LIMIT 1"),
          'WEB_CLOUD_EMPTY_REQUIRED',
        );
        this.all('CREATE TABLE cf_web_migrations(version INTEGER PRIMARY KEY,sha256 TEXT NOT NULL) STRICT');
        for (const m of migrations) {
          this.all(m.sql);
          this.run('INSERT INTO cf_web_migrations VALUES (?,?)', m.version, digest(m.sql));
        }
        this.run(
          'INSERT INTO web_instance(singleton,instance_id,recovery_epoch) VALUES (1,?,?)',
          this.instanceId,
          this.recoveryEpoch,
        );
      }
      let applied = this.all<{ version: number; sha256: string }>('SELECT * FROM cf_web_migrations ORDER BY version');
      // Every applied step must be hash-identical to the code's step of that version; steps the ledger lacks are
      // the newer ones and run in order (an authority at 113 gains 114). A ledger ahead of the code is a mismatch.
      ensure(
        applied.length <= migrations.length &&
          applied.every((m, i) => m.version === migrations[i]!.version && m.sha256 === digest(migrations[i]!.sql)),
        'WEB_CLOUD_MIGRATION_MISMATCH',
      );
      for (const m of migrations.slice(applied.length)) {
        this.all(m.sql);
        this.run('INSERT INTO cf_web_migrations VALUES (?,?)', m.version, digest(m.sql));
      }
      applied = this.all<{ version: number; sha256: string }>('SELECT * FROM cf_web_migrations ORDER BY version');
      ensure(applied.length === migrations.length, 'WEB_CLOUD_MIGRATION_MISMATCH');
      const row = this.get<{ instance_id: string; recovery_epoch: string }>(
        'SELECT * FROM web_instance WHERE singleton=1',
      );
      ensure(
        row?.instance_id === this.instanceId && row.recovery_epoch === this.recoveryEpoch,
        'WEB_CLOUD_INSTANCE_MISMATCH',
      );
      this.requireProviderRuntime();
      ensure(
        !!this.providerAudio ===
          this.all<{ name: string }>('PRAGMA table_info(web_provider_outputs)').some(
            (column) => column.name === 'audio_ref_json',
          ),
        'WEB_CLOUD_MEDIA_MODE_MISMATCH',
      );
      ensure(
        this.get<{ foreign_keys: number }>('PRAGMA foreign_keys')?.foreign_keys === 1 &&
          !this.get('PRAGMA foreign_key_check'),
        'WEB_CLOUD_FOREIGN_KEYS_INVALID',
      );
    });
    registerWebRuntime(this);
  }

  webIpKeyFingerprint() {
    ensure(this.keys, 'WEB_CLOUD_KEYS_REQUIRED');
    return createHash('sha256').update(this.keys.ipKey).digest('hex');
  }
  webReceiptDigest(kind: 'receipt' | 'usage', json: string) {
    ensure(this.keys, 'WEB_CLOUD_KEYS_REQUIRED');
    return createHmac('sha256', this.keys.requestKey).update(`web-attempt-${kind}\0`).update(json).digest('hex');
  }
  webPrivateAudioFiles(): never {
    throw new Error('WEB_CLOUD_LOCAL_FILES_FORBIDDEN');
  }
  requireInviteTest() {
    this.requireProviderRuntime();
  }
  requireProviderRuntime() {
    ensure(
      (this.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? -1) >= 113 &&
        !!this.get("SELECT 1 FROM sqlite_master WHERE name='web_provider_attempts'"),
      'WEB_PROVIDER_RUNTIME_NOT_AUTHORIZED',
    );
  }
  all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    ensure(!this.closed, 'STORE_CLOSED');
    // workerd forbids PRAGMA user_version. Expose the existing business read contract
    // from the hash-verified migration ledger; never pretend this is an in-memory Node DB.
    if (sql === 'PRAGMA user_version' && params.length === 0)
      return this.all<T>('SELECT max(version) AS user_version FROM cf_web_migrations');
    const bindings = params.map((value) => {
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
    });
    return this.storage.sql
      .exec(sql, ...bindings)
      .toArray()
      .map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([key, value]) => {
            if (typeof value === 'number')
              ensure(
                Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)),
                'SQL_INTEGER_OUT_OF_RANGE',
              );
            return [key, value instanceof ArrayBuffer ? Buffer.from(value) : value];
          }),
        ),
      ) as T[];
  }
  get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.all<T>(sql, ...params)[0];
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
    ensure(!this.closed, 'STORE_CLOSED');
    ensure(Object.prototype.toString.call(work) !== '[object AsyncFunction]', 'ASYNC_TRANSACTION_FORBIDDEN');
    return this.storage.transactionSync(() => {
      const result = work();
      ensure(
        !(result !== null && (typeof result === 'object' || typeof result === 'function') && 'then' in result),
        'ASYNC_TRANSACTION_FORBIDDEN',
      );
      return result;
    });
  }
  close() {
    this.closed = true;
  }
}

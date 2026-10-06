import { createHash } from 'node:crypto';
import type { DurableSQLStorage } from './store.ts';
import type { GuardFence, GuardIdentity, RecoveryGuard } from './recovery-guard.ts';
import { guardId } from './guard-access-state.ts';
import { ensure } from '../../../packages/domain/errors.ts';

export interface GuardRecoveryReceipt {
  revision: number;
  source: GuardFence;
  target: GuardIdentity;
  evidenceHash: string;
  costWatermark: number;
}
const schema = `
CREATE TABLE guard_recovery_reservation(singleton INTEGER PRIMARY KEY CHECK(singleton=1),revision INTEGER NOT NULL,
 receipt_json TEXT NOT NULL,receipt_hash TEXT NOT NULL) STRICT;
`;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Frozen recovery admission only. A receipt never authorizes either instance, changes identity or grants budget. */
export class GuardRecovery {
  readonly #storage: DurableSQLStorage;
  readonly #inspect: (id: GuardIdentity) => ReturnType<RecoveryGuard['inspect']>;
  readonly #watermark: (id: GuardIdentity) => number;
  readonly #target: (id: GuardIdentity) => void;
  constructor(
    storage: DurableSQLStorage,
    inspect: (id: GuardIdentity) => ReturnType<RecoveryGuard['inspect']>,
    watermark: (id: GuardIdentity) => number,
    target: (id: GuardIdentity) => void,
  ) {
    this.#storage = storage;
    this.#inspect = inspect;
    this.#watermark = watermark;
    this.#target = target;
    storage.transactionSync(() => {
      if (!this.get("SELECT 1 FROM sqlite_master WHERE name='guard_recovery_schema'")) {
        ensure(
          !this.get("SELECT 1 FROM sqlite_master WHERE name='guard_recovery_reservation'"),
          'GUARD_RECOVERY_SCHEMA_MISMATCH',
        );
        this.sql(
          'CREATE TABLE guard_recovery_schema(singleton INTEGER PRIMARY KEY CHECK(singleton=1),sha256 TEXT NOT NULL) STRICT',
        );
        this.sql(schema);
        this.sql('INSERT INTO guard_recovery_schema VALUES(1,?)', hash(schema));
      }
      ensure(
        this.get<{ sha256: string }>('SELECT sha256 FROM guard_recovery_schema WHERE singleton=1')?.sha256 ===
          hash(schema),
        'GUARD_RECOVERY_SCHEMA_MISMATCH',
      );
    });
  }
  private sql(query: string, ...bindings: (string | number)[]) {
    return this.#storage.sql.exec(query, ...bindings).toArray();
  }
  private get<T>(query: string, ...bindings: (string | number)[]): T | undefined {
    return this.sql(query, ...bindings)[0] as T | undefined;
  }
  private current() {
    const row = this.get<{ revision: number; receipt_json: string; receipt_hash: string }>(
      'SELECT * FROM guard_recovery_reservation WHERE singleton=1',
    );
    if (!row) return null;
    const receipt = JSON.parse(row.receipt_json) as GuardRecoveryReceipt;
    ensure(
      hash(receipt) === row.receipt_hash &&
        receipt.revision === row.revision &&
        Number.isSafeInteger(row.revision) &&
        row.revision > 0,
      'GUARD_RECOVERY_INTEGRITY',
    );
    return receipt;
  }
  private fresh(source: GuardFence, costWatermark: number) {
    const current = this.#inspect(source);
    ensure(current.frozen && current.pending === null, 'GUARD_RECOVERY_NOT_QUIESCENT');
    ensure(hash(current.fence) === hash(source), 'GUARD_FENCE_MISMATCH');
    ensure(
      Number.isSafeInteger(costWatermark) && costWatermark >= 0 && this.#watermark(source) === costWatermark,
      'GUARD_RECOVERY_COSTS_CHANGED',
    );
  }
  reserve(
    source: GuardFence,
    target: GuardIdentity,
    evidenceHash: string,
    costWatermark: number,
    expectedRevision: number,
  ): GuardRecoveryReceipt {
    ensure(target && Object.keys(target).length === 3, 'GUARD_RECOVERY_TARGET_INVALID');
    for (const id of [target.instanceId, target.epoch, target.businessId]) guardId(id);
    ensure(
      target.instanceId === source.instanceId &&
        target.epoch !== source.epoch &&
        target.businessId !== source.businessId,
      'GUARD_RECOVERY_TARGET_INVALID',
    );
    ensure(
      typeof evidenceHash === 'string' &&
        /^[a-f0-9]{64}$/.test(evidenceHash) &&
        Number.isSafeInteger(expectedRevision) &&
        expectedRevision >= 0 &&
        expectedRevision < Number.MAX_SAFE_INTEGER,
      'GUARD_RECOVERY_REQUEST_INVALID',
    );
    // Project fields: caller metadata cannot silently become an authorization claim in the receipt.
    const fence = {
      instanceId: source.instanceId,
      epoch: source.epoch,
      businessId: source.businessId,
      version: source.version,
      stateHash: source.stateHash,
    };
    const identity = { instanceId: target.instanceId, epoch: target.epoch, businessId: target.businessId };
    return this.#storage.transactionSync(() => {
      this.#target(identity);
      this.fresh(fence, costWatermark);
      const old = this.current(),
        next = { revision: expectedRevision + 1, source: fence, target: identity, evidenceHash, costWatermark };
      if (old && hash(old) === hash(next)) return old;
      ensure((old?.revision ?? 0) === expectedRevision, 'GUARD_RECOVERY_REVISION_CONFLICT');
      // Rechecking late facts may advance evidence, never retarget an uncertain reservation.
      if (old)
        ensure(
          hash(old.source) === hash(fence) && hash(old.target) === hash(identity),
          'GUARD_RECOVERY_TARGET_CONFLICT',
        );
      this.sql(
        'INSERT INTO guard_recovery_reservation VALUES(1,?,?,?) ON CONFLICT(singleton) DO UPDATE SET revision=excluded.revision,receipt_json=excluded.receipt_json,receipt_hash=excluded.receipt_hash',
        next.revision,
        JSON.stringify(next),
        hash(next),
      );
      return next;
    });
  }
  verify(receipt: GuardRecoveryReceipt) {
    return this.#storage.transactionSync(() => {
      const current = this.current();
      ensure(current && hash(current) === hash(receipt), 'GUARD_RECOVERY_REVISION_CONFLICT');
      this.fresh(current.source, current.costWatermark);
      return current;
    });
  }
}

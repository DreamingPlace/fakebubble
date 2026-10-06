import type { GuardRecoveryReceipt } from './guard-recovery.ts';
import { GuardRecovery } from './guard-recovery.ts';
import { GuardCostFacts } from './guard-cost-facts.ts';
import { createHash } from 'node:crypto';
import type { Clock } from '../../../packages/contracts/index.ts';
import { ensure } from '../../../packages/domain/errors.ts';
import type { DurableSQLStorage } from './store.ts';
import {
  emptyGuardAccessState,
  guardAccessTransition,
  guardId,
  guardStateHash,
  parseGuardAccessState,
} from './guard-access-state.ts';
import type { GuardAccessState } from './guard-access-state.ts';

export interface GuardIdentity {
  instanceId: string;
  epoch: string;
  businessId: string;
}
export interface GuardFence extends GuardIdentity {
  version: number;
  stateHash: string;
}
export interface GuardIntent {
  operationId: string;
  requestHash: string;
  beforeVersion: number;
  beforeHash: string;
  afterVersion: number | null;
  afterHash: string | null;
  targetHash: string;
  targetState: GuardAccessState;
  state: 'prepared' | 'committed';
}
interface Meta {
  instance_id: string;
  epoch: string;
  business_id: string;
  version: number;
  state_hash: string;
  state_json: string;
  pending_id: string | null;
  frozen_at: number | null;
}
interface Operation {
  id: string;
  request_hash: string;
  before_version: number;
  before_hash: string;
  after_version: number | null;
  after_hash: string | null;
  target_hash: string;
  target_json: string;
}
const schema = `
CREATE TABLE guard_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),instance_id TEXT NOT NULL,epoch TEXT NOT NULL,business_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version>=0),state_hash TEXT NOT NULL,state_json TEXT NOT NULL,pending_id TEXT,frozen_at INTEGER) STRICT;
CREATE TABLE guard_operations(id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,before_version INTEGER NOT NULL,before_hash TEXT NOT NULL,
  target_hash TEXT NOT NULL,target_json TEXT NOT NULL,after_version INTEGER,after_hash TEXT,prepared_at INTEGER NOT NULL,committed_at INTEGER,
  CHECK((after_version IS NULL AND after_hash IS NULL AND committed_at IS NULL) OR (after_version=before_version+1 AND after_hash IS NOT NULL AND committed_at IS NOT NULL AND committed_at>=prepared_at))) STRICT;
`;
const schemaHash = createHash('sha256').update(schema).digest('hex');
const epochSchema = `CREATE TABLE guard_epoch_adoptions(source_epoch TEXT PRIMARY KEY,source_business TEXT NOT NULL UNIQUE,
 receipt_json TEXT NOT NULL,fence_json TEXT NOT NULL,sha256 TEXT NOT NULL) STRICT;`;
const epochHash = (value: string) => createHash('sha256').update(value).digest('hex');

function fingerprint(value: unknown): asserts value is string {
  ensure(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 'GUARD_HASH_INVALID');
}
function identity(value: GuardIdentity) {
  guardId(value.instanceId);
  guardId(value.epoch);
  guardId(value.businessId);
}
const fence = (m: Meta): GuardFence => ({
  instanceId: m.instance_id,
  epoch: m.epoch,
  businessId: m.business_id,
  version: m.version,
  stateHash: m.state_hash,
});
const intent = (r: Operation): GuardIntent => ({
  operationId: r.id,
  requestHash: r.request_hash,
  beforeVersion: r.before_version,
  beforeHash: r.before_hash,
  afterVersion: r.after_version,
  afterHash: r.after_hash,
  targetHash: r.target_hash,
  targetState: parseGuardAccessState(JSON.parse(r.target_json)),
  state: r.after_version === null ? 'prepared' : 'committed',
});

/** Independent guard storage only. No public HTTP, business tables, paid-call approval, activation, reset or pending-intent cancellation. */
export class RecoveryGuard {
  readonly costs: GuardCostFacts;
  readonly recovery: GuardRecovery;
  readonly #storage: DurableSQLStorage;
  readonly #clock: Clock;
  constructor(storage: DurableSQLStorage, clock: Clock) {
    this.#storage = storage;
    this.#clock = clock;
    storage.transactionSync(() => {
      const marked = this.get<{ sha256: string }>(
        "SELECT name AS sha256 FROM sqlite_master WHERE type='table' AND name='guard_schema'",
      );
      if (!marked) {
        ensure(
          !this.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*' LIMIT 1"),
          'GUARD_EMPTY_STORAGE_REQUIRED',
        );
        this.sql(
          'CREATE TABLE guard_schema(singleton INTEGER PRIMARY KEY CHECK(singleton=1),sha256 TEXT NOT NULL) STRICT',
        );
        this.sql(schema);
        this.sql('INSERT INTO guard_schema VALUES (1,?)', schemaHash);
      }
      ensure(
        this.get<{ sha256: string }>('SELECT sha256 FROM guard_schema WHERE singleton=1')?.sha256 === schemaHash,
        'GUARD_SCHEMA_MISMATCH',
      );
    });
    storage.transactionSync(() => {
      if (!this.get("SELECT 1 FROM sqlite_master WHERE name='guard_epoch_schema'")) {
        ensure(
          !this.get("SELECT 1 FROM sqlite_master WHERE name='guard_epoch_adoptions'"),
          'GUARD_EPOCH_SCHEMA_MISMATCH',
        );
        this.sql(
          'CREATE TABLE guard_epoch_schema(singleton INTEGER PRIMARY KEY CHECK(singleton=1),sha256 TEXT NOT NULL) STRICT',
        );
        this.sql(epochSchema);
        this.sql('INSERT INTO guard_epoch_schema VALUES(1,?)', epochHash(epochSchema));
      }
      ensure(
        this.get<{ sha256: string }>('SELECT sha256 FROM guard_epoch_schema WHERE singleton=1')?.sha256 ===
          epochHash(epochSchema),
        'GUARD_EPOCH_SCHEMA_MISMATCH',
      );
    });
    this.costs = new GuardCostFacts(
      storage,
      clock,
      (fence) => this.check(fence),
      (id) => this.costIdentity(id),
      (id, sent, sequence) => {
        const m = this.meta(),
          current = id.epoch === m.epoch && id.businessId === m.business_id;
        // Retired authorities can finish already-known calls, never alter facts for a later generation's sends.
        const retired = current ? null : this.adoption(id.epoch);
        ensure(
          id.instanceId === sent.instanceId && (current || (retired && sequence <= retired.receipt.costWatermark)),
          'GUARD_COST_SOURCE_MISMATCH',
        );
      },
    );
    this.recovery = new GuardRecovery(
      storage,
      (id) => this.inspect(id),
      (id) => this.costs.watermark(id),
      (target) => {
        ensure(
          !this.get(
            'SELECT 1 FROM guard_epoch_adoptions WHERE source_epoch=? OR source_business=?',
            target.epoch,
            target.businessId,
          ),
          'GUARD_EPOCH_REUSE',
        );
      },
    );
  }
  private sql(query: string, ...bindings: (string | number | null)[]) {
    return this.#storage.sql.exec(query, ...bindings).toArray();
  }
  private get<T>(query: string, ...bindings: (string | number | null)[]): T | undefined {
    return this.sql(query, ...bindings)[0] as T | undefined;
  }
  private now() {
    const now = this.#clock.now();
    ensure(Number.isSafeInteger(now) && now > 0, 'GUARD_CLOCK_INVALID');
    return now;
  }
  private meta() {
    const m = this.get<Meta>('SELECT * FROM guard_meta WHERE singleton=1');
    ensure(m, 'GUARD_NOT_INITIALIZED');
    ensure(Number.isSafeInteger(m.version) && m.version >= 0, 'GUARD_INTEGRITY_ERROR');
    ensure(guardStateHash(parseGuardAccessState(JSON.parse(m.state_json))) === m.state_hash, 'GUARD_INTEGRITY_ERROR');
    return m;
  }
  private sameIdentity(m: Meta, expected: GuardIdentity) {
    identity(expected);
    ensure(
      m.instance_id === expected.instanceId && m.epoch === expected.epoch && m.business_id === expected.businessId,
      'GUARD_FENCE_MISMATCH',
    );
  }
  private adoption(epoch: string) {
    const row = this.get<{ source_business: string; receipt_json: string; fence_json: string; sha256: string }>(
      'SELECT * FROM guard_epoch_adoptions WHERE source_epoch=?',
      epoch,
    );
    if (!row) return null;
    ensure(row.sha256 === epochHash(row.receipt_json + '\n' + row.fence_json), 'GUARD_EPOCH_INTEGRITY');
    const receipt = JSON.parse(row.receipt_json) as GuardRecoveryReceipt,
      adopted = JSON.parse(row.fence_json) as GuardFence;
    ensure(
      receipt.source.epoch === epoch &&
        receipt.source.businessId === row.source_business &&
        adopted.epoch === receipt.target.epoch &&
        adopted.businessId === receipt.target.businessId &&
        adopted.instanceId === receipt.target.instanceId &&
        adopted.version === receipt.source.version + 1 &&
        adopted.stateHash === receipt.source.stateHash,
      'GUARD_EPOCH_INTEGRITY',
    );
    return { receipt, fence: adopted };
  }
  private costIdentity(expected: GuardIdentity) {
    identity(expected);
    const m = this.meta();
    if (expected.epoch !== m.epoch || expected.businessId !== m.business_id) {
      const old = this.adoption(expected.epoch);
      ensure(
        old?.receipt.source.businessId === expected.businessId && old.receipt.source.instanceId === expected.instanceId,
        'GUARD_FENCE_MISMATCH',
      );
    }
    ensure(expected.instanceId === m.instance_id, 'GUARD_FENCE_MISMATCH');
    return parseGuardAccessState(JSON.parse(m.state_json));
  }
  /** Destructive maintenance gate only; never authorizes business traffic, sends, or a new backup. */
  authorizeBackupCleanup(expected: GuardIdentity) {
    identity(expected);
    const m = this.meta();
    ensure(expected.instanceId === m.instance_id, 'GUARD_FENCE_MISMATCH');
    if (expected.epoch === m.epoch && expected.businessId === m.business_id) {
      ensure(m.frozen_at !== null && m.pending_id === null, 'GUARD_BACKUP_NOT_QUIESCENT');
      return { retired: false };
    }
    const old = this.adoption(expected.epoch);
    ensure(
      old?.receipt.source.instanceId === expected.instanceId && old.receipt.source.businessId === expected.businessId,
      'GUARD_FENCE_MISMATCH',
    );
    return { retired: true };
  }
  /** Operator-only transition primitive: both old and new instances remain unable to send. NOT recovery activation. */
  adoptRecovery(receipt: GuardRecoveryReceipt): GuardFence {
    return this.#storage.transactionSync(() => {
      const prior = this.adoption(receipt.source.epoch),
        m = this.meta();
      if (prior) {
        ensure(JSON.stringify(prior.receipt) === JSON.stringify(receipt), 'GUARD_EPOCH_CONFLICT');
        this.sameFence(m, prior.fence);
        ensure(m.frozen_at !== null && m.pending_id === null, 'GUARD_RECOVERY_NOT_QUIESCENT');
        return prior.fence;
      }
      this.recovery.verify(receipt);
      this.sameFence(m, receipt.source);
      ensure(
        m.version < Number.MAX_SAFE_INTEGER &&
          !this.get(
            'SELECT 1 FROM guard_epoch_adoptions WHERE source_epoch=? OR source_business=?',
            receipt.target.epoch,
            receipt.target.businessId,
          ),
        'GUARD_EPOCH_REUSE',
      );
      const next = { ...receipt.target, version: m.version + 1, stateHash: m.state_hash };
      const original = JSON.stringify(receipt),
        result = JSON.stringify(next);
      this.sql(
        'INSERT INTO guard_epoch_adoptions VALUES(?,?,?,?,?)',
        m.epoch,
        m.business_id,
        original,
        result,
        epochHash(original + '\n' + result),
      );
      this.sql(
        'UPDATE guard_meta SET epoch=?,business_id=?,version=? WHERE singleton=1',
        next.epoch,
        next.businessId,
        next.version,
      );
      this.sql('DELETE FROM guard_recovery_reservation');
      return next;
    });
  }
  private sameFence(m: Meta, expected: GuardFence) {
    this.sameIdentity(m, expected);
    fingerprint(expected.stateHash);
    ensure(
      Number.isSafeInteger(expected.version) &&
        expected.version >= 0 &&
        m.version === expected.version &&
        m.state_hash === expected.stateHash,
      'GUARD_FENCE_MISMATCH',
    );
  }
  /** Provisioning-only: the future operator service must withhold this method from business bindings. Never adopts a populated business snapshot. */
  initialize(expected: GuardIdentity): GuardFence {
    identity(expected);
    return this.#storage.transactionSync(() => {
      ensure(!this.get('SELECT 1 FROM guard_meta'), 'GUARD_ALREADY_INITIALIZED');
      const state = emptyGuardAccessState();
      this.sql(
        'INSERT INTO guard_meta VALUES (1,?,?,?,0,?,?,NULL,NULL)',
        expected.instanceId,
        expected.epoch,
        expected.businessId,
        guardStateHash(state),
        JSON.stringify(state),
      );
      return fence(this.meta());
    });
  }
  inspect(expected: GuardIdentity) {
    return this.#storage.transactionSync(() => {
      const m = this.meta();
      this.sameIdentity(m, expected);
      return {
        fence: fence(m),
        pending: m.pending_id,
        frozen: m.frozen_at !== null,
        state: parseGuardAccessState(JSON.parse(m.state_json)),
      };
    });
  }
  check(expected: GuardFence): void {
    this.#storage.transactionSync(() => {
      const m = this.meta();
      this.sameFence(m, expected);
      ensure(m.frozen_at === null, 'GUARD_FROZEN');
      ensure(m.pending_id === null, 'GUARD_PENDING');
    });
  }
  operation(expected: GuardIdentity, operationId: string): GuardIntent | null {
    guardId(operationId);
    const m = this.meta();
    this.sameIdentity(m, expected);
    const row = this.get<Operation>('SELECT * FROM guard_operations WHERE id=?', operationId);
    return row ? intent(row) : null;
  }
  prepare(expected: GuardFence, operationId: string, requestHash: string, target: unknown): GuardIntent {
    guardId(operationId);
    fingerprint(requestHash);
    const state = parseGuardAccessState(target),
      targetHash = guardStateHash(state);
    return this.#storage.transactionSync(() => {
      const m = this.meta();
      this.sameIdentity(m, expected);
      ensure(m.frozen_at === null, 'GUARD_FROZEN');
      const existing = this.get<Operation>('SELECT * FROM guard_operations WHERE id=?', operationId);
      if (existing) {
        ensure(
          existing.request_hash === requestHash &&
            existing.before_version === expected.version &&
            existing.before_hash === expected.stateHash &&
            existing.target_hash === targetHash,
          'GUARD_OPERATION_CONFLICT',
        );
        return intent(existing);
      }
      this.sameFence(m, expected);
      ensure(m.pending_id === null, 'GUARD_PENDING');
      guardAccessTransition(parseGuardAccessState(JSON.parse(m.state_json)), state);
      ensure(
        m.version < Number.MAX_SAFE_INTEGER &&
          this.get<{ n: number }>('SELECT count(*) n FROM guard_operations')!.n < 100_000,
        'GUARD_CAPACITY_REQUIRED',
      );
      this.sql(
        'INSERT INTO guard_operations VALUES (?,?,?,?,?,?,NULL,NULL,?,NULL)',
        operationId,
        requestHash,
        m.version,
        m.state_hash,
        targetHash,
        JSON.stringify(state),
        this.now(),
      );
      this.sql('UPDATE guard_meta SET pending_id=? WHERE singleton=1', operationId);
      return intent(this.get<Operation>('SELECT * FROM guard_operations WHERE id=?', operationId)!);
    });
  }
  /** Trusts the authenticated business coordinator's persisted commit proof. This alone cannot prove a cross-DO transaction. */
  confirm(expected: GuardFence, operationId: string, requestHash: string, next: unknown): GuardFence {
    guardId(operationId);
    fingerprint(requestHash);
    const state = parseGuardAccessState(next),
      hash = guardStateHash(state);
    return this.#storage.transactionSync(() => {
      const m = this.meta();
      this.sameIdentity(m, expected);
      ensure(m.frozen_at === null, 'GUARD_FROZEN');
      const op = this.get<Operation>('SELECT * FROM guard_operations WHERE id=?', operationId);
      ensure(
        op &&
          op.request_hash === requestHash &&
          op.before_version === expected.version &&
          op.before_hash === expected.stateHash &&
          op.target_hash === hash,
        'GUARD_OPERATION_CONFLICT',
      );
      if (op.after_version !== null) {
        ensure(op.after_hash === hash, 'GUARD_OPERATION_CONFLICT');
        // The old receipt is not a current service permit; check() rejects it after any later mutation.
        return { ...expected, version: op.after_version, stateHash: hash };
      }
      this.sameFence(m, expected);
      ensure(m.pending_id === operationId, 'GUARD_OPERATION_CONFLICT');
      guardAccessTransition(parseGuardAccessState(JSON.parse(m.state_json)), state);
      const version = m.version + 1;
      this.sql(
        'UPDATE guard_operations SET after_version=?,after_hash=?,committed_at=? WHERE id=?',
        version,
        hash,
        this.now(),
        operationId,
      );
      this.sql(
        'UPDATE guard_meta SET version=?,state_hash=?,state_json=?,pending_id=NULL WHERE singleton=1',
        version,
        hash,
        JSON.stringify(state),
      );
      return { ...expected, version, stateHash: hash };
    });
  }
  /** A freeze is deliberately one-way here. Restore/reconciliation needs a separately implemented and approved operator protocol. */
  freeze(expected: GuardFence): void {
    this.#storage.transactionSync(() => {
      const m = this.meta();
      this.sameFence(m, expected);
      this.sql('UPDATE guard_meta SET frozen_at=COALESCE(frozen_at,?) WHERE singleton=1', this.now());
    });
  }
}

import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import type { Clock } from '../../../packages/contracts/index.ts';
import type { CostCall, CostCallInput, CostObservation, CostPrice } from '../../../packages/contracts/admin-costs.ts';
import {
  costCallInput,
  costReconciliation,
  costObservation,
  costPrice,
  costReservation,
} from '../budget/beta-costs.ts';
import { ensure } from '../../../packages/domain/errors.ts';
import type { DurableSQLStorage } from './store.ts';
import type { GuardFence, GuardIdentity } from './recovery-guard.ts';
import { guardId } from './guard-access-state.ts';
import type { GuardAccessState } from './guard-access-state.ts';

export interface GuardSendIntent {
  call: CostCallInput;
  meteringId: string | null;
  price: CostPrice;
  globalBudgetId: string;
  ownerBudgetId: string;
  reservedMicros: string;
  dispatchedAt: number;
  requestHash: string;
}
interface FactRow {
  sequence: number;
  kind: 'send' | 'observation' | 'reconciliation';
  call_id: string;
  event_id: string;
  payload_hash: string;
  payload_json: string;
  created_at: number;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fields(value: unknown, names: string[]): asserts value is Record<string, unknown> {
  ensure(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).length === names.length &&
      names.every((n) => Object.hasOwn(value, n)),
    'GUARD_COST_INVALID',
  );
}
function id(value: unknown): asserts value is string {
  ensure(typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value), 'GUARD_COST_INVALID');
}
function time(value: unknown): asserts value is number {
  ensure(
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 8_640_000_000_000_000,
    'GUARD_COST_INVALID',
  );
}
function sendIntent(value: unknown): GuardSendIntent {
  fields(value, [
    'call',
    'meteringId',
    'price',
    'globalBudgetId',
    'ownerBudgetId',
    'reservedMicros',
    'dispatchedAt',
    'requestHash',
  ]);
  const call = costCallInput(value.call),
    price = costPrice(value.price);
  id(value.globalBudgetId);
  id(value.ownerBudgetId);
  time(value.dispatchedAt);
  if (value.meteringId !== null) id(value.meteringId);
  ensure(
    (call.scope.kind === 'player') === (value.meteringId !== null) &&
      call.provider === price.provider &&
      call.model === price.model &&
      value.dispatchedAt >= price.validFrom &&
      value.dispatchedAt < price.validUntil &&
      value.reservedMicros === costReservation(price, call.bounds) &&
      typeof value.requestHash === 'string' &&
      /^[a-f0-9]{64}$/.test(value.requestHash),
    'GUARD_COST_INVALID',
  );
  return {
    call,
    meteringId: value.meteringId,
    price,
    globalBudgetId: value.globalBudgetId,
    ownerBudgetId: value.ownerBudgetId,
    reservedMicros: value.reservedMicros as string,
    dispatchedAt: value.dispatchedAt,
    requestHash: value.requestHash,
  };
}
function sendFence(value: unknown): GuardFence {
  fields(value, ['instanceId', 'epoch', 'businessId', 'version', 'stateHash']);
  guardId(value.instanceId);
  guardId(value.epoch);
  guardId(value.businessId);
  ensure(
    Number.isSafeInteger(value.version) &&
      Number(value.version) >= 0 &&
      typeof value.stateHash === 'string' &&
      /^[a-f0-9]{64}$/.test(value.stateHash),
    'GUARD_COST_INVALID',
  );
  return {
    instanceId: value.instanceId,
    epoch: value.epoch,
    businessId: value.businessId,
    version: value.version as number,
    stateHash: value.stateHash,
  };
}
/** Copy only cost/attribution metadata from an already-dispatched business ledger entry; never copy prompts, responses or credentials. */
export function guardSendIntent(call: CostCall, price: CostPrice, requestHash: string): GuardSendIntent {
  ensure(
    call.state === 'dispatched' &&
      call.dispatchedAt !== null &&
      call.priceId === price.id &&
      call.currency === price.currency,
    'GUARD_COST_INVALID',
  );
  return sendIntent({
    call: {
      id: call.id,
      scope: call.scope,
      function: call.function,
      taskId: call.taskId,
      stage: call.stage,
      provider: call.provider,
      model: call.model,
      bounds: call.bounds,
    },
    meteringId: call.meteringId,
    price,
    globalBudgetId: call.globalBudgetId,
    ownerBudgetId: call.ownerBudgetId,
    reservedMicros: call.reservedMicros,
    dispatchedAt: call.dispatchedAt,
    requestHash,
  });
}
const schema = `
CREATE TABLE guard_cost_facts(sequence INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL CHECK(kind IN ('send','observation')),
  call_id TEXT NOT NULL,event_id TEXT NOT NULL,payload_hash TEXT NOT NULL,payload_json TEXT NOT NULL,created_at INTEGER NOT NULL,provider_request_id TEXT,
  UNIQUE(kind,call_id,event_id)) STRICT;
CREATE INDEX guard_cost_by_call ON guard_cost_facts(call_id,sequence);
CREATE INDEX guard_cost_receipt ON guard_cost_facts(call_id,sequence) WHERE provider_request_id IS NOT NULL;
`;
const reconciliationSchema = `
ALTER TABLE guard_cost_facts RENAME TO guard_cost_facts_old;
DROP INDEX guard_cost_by_call;
DROP INDEX guard_cost_receipt;
CREATE TABLE guard_cost_facts(sequence INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL CHECK(kind IN ('send','observation','reconciliation')),
  call_id TEXT NOT NULL,event_id TEXT NOT NULL,payload_hash TEXT NOT NULL,payload_json TEXT NOT NULL,created_at INTEGER NOT NULL,provider_request_id TEXT,
  UNIQUE(kind,call_id,event_id)) STRICT;
INSERT INTO guard_cost_facts SELECT * FROM guard_cost_facts_old;
DROP TABLE guard_cost_facts_old;
CREATE INDEX guard_cost_by_call ON guard_cost_facts(call_id,sequence);
CREATE INDEX guard_cost_receipt ON guard_cost_facts(call_id,sequence) WHERE provider_request_id IS NOT NULL;
`;
const migrations = [schema, reconciliationSchema] as const;
export type GuardCostFact = { sequence: number; at: number; callId: string; eventId: string } & (
  | { kind: 'send'; fence: GuardFence; intent: GuardSendIntent }
  | { kind: 'observation'; observation: CostObservation }
  | { kind: 'reconciliation'; reconciliation: ReturnType<typeof costReconciliation> }
);

/** Append-only independent recovery evidence, NOT a budget authority or a provider transport. */
export class GuardCostFacts {
  readonly #storage: DurableSQLStorage;
  readonly #clock: Clock;
  readonly #check: (fence: GuardFence) => void;
  readonly #identity: (identity: GuardIdentity) => GuardAccessState;
  readonly #source: (identity: GuardIdentity, sent: GuardFence, sequence: number) => void;
  constructor(
    storage: DurableSQLStorage,
    clock: Clock,
    check: (fence: GuardFence) => void,
    identity: (identity: GuardIdentity) => GuardAccessState,
    source: (identity: GuardIdentity, sent: GuardFence, sequence: number) => void,
  ) {
    this.#storage = storage;
    this.#clock = clock;
    this.#check = check;
    this.#identity = identity;
    this.#source = source;
    storage.transactionSync(() => {
      ensure(
        this.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='guard_schema'"),
        'GUARD_SCHEMA_REQUIRED',
      );
      if (!this.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='guard_cost_migrations'")) {
        ensure(
          !this.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='guard_cost_facts'"),
          'GUARD_COST_MIGRATION_MISMATCH',
        );
        this.sql('CREATE TABLE guard_cost_migrations(version INTEGER PRIMARY KEY,sha256 TEXT NOT NULL) STRICT');
      }
      const applied = this.sql('SELECT version,sha256 FROM guard_cost_migrations ORDER BY version') as {
        version: number;
        sha256: string;
      }[];
      const hashes = migrations.map((sql) => digest(sql));
      ensure(
        applied.length <= hashes.length && applied.every((m, i) => m.version === i + 1 && m.sha256 === hashes[i]),
        'GUARD_COST_MIGRATION_MISMATCH',
      );
      for (let i = applied.length; i < hashes.length; i++) {
        this.sql(migrations[i]!);
        this.sql('INSERT INTO guard_cost_migrations VALUES (?,?)', i + 1, hashes[i]!);
      }
    });
  }
  private sql(query: string, ...params: (string | number | null)[]) {
    return this.#storage.sql.exec(query, ...params).toArray();
  }
  private get<T>(query: string, ...params: (string | number | null)[]): T | undefined {
    return this.sql(query, ...params)[0] as T | undefined;
  }
  private now() {
    const now = this.#clock.now();
    time(now);
    return now;
  }
  private row(kind: string, callId: string, eventId: string) {
    return this.get<FactRow>(
      'SELECT * FROM guard_cost_facts WHERE kind=? AND call_id=? AND event_id=?',
      kind,
      callId,
      eventId,
    );
  }
  private decoded(row: FactRow): GuardCostFact {
    const value = JSON.parse(row.payload_json);
    ensure(
      Number.isSafeInteger(row.sequence) && row.sequence > 0 && digest(value) === row.payload_hash,
      'GUARD_COST_INTEGRITY_ERROR',
    );
    const common = { sequence: row.sequence, at: row.created_at, callId: row.call_id, eventId: row.event_id };
    if (row.kind === 'send') {
      fields(value, ['fence', 'intent']);
      const intent = sendIntent(value.intent);
      ensure(intent.call.id === row.call_id && row.event_id === '', 'GUARD_COST_INTEGRITY_ERROR');
      return { ...common, kind: 'send', fence: sendFence(value.fence), intent };
    }
    if (row.kind === 'reconciliation')
      return { ...common, kind: 'reconciliation', reconciliation: costReconciliation(value) };
    return { ...common, kind: 'observation', observation: costObservation(value) };
  }
  private append(kind: FactRow['kind'], callId: string, eventId: string, payload: unknown, receipt: string | null) {
    const text = JSON.stringify(payload);
    ensure(Buffer.byteLength(text) <= 16_384, 'GUARD_COST_TOO_LARGE');
    const hash = digest(payload),
      prior = this.row(kind, callId, eventId);
    if (prior) {
      this.decoded(prior);
      ensure(prior.payload_hash === hash, 'GUARD_COST_CONFLICT');
      return { fresh: false, sequence: prior.sequence };
    }
    const last = this.get<{ n: number }>('SELECT COALESCE(MAX(sequence),0) n FROM guard_cost_facts')!.n;
    ensure(Number.isSafeInteger(last) && last < 1_000_000, 'GUARD_COST_CAPACITY_REQUIRED');
    this.sql(
      'INSERT INTO guard_cost_facts(kind,call_id,event_id,payload_hash,payload_json,created_at,provider_request_id) VALUES (?,?,?,?,?,?,?)',
      kind,
      callId,
      eventId,
      hash,
      text,
      this.now(),
      receipt,
    );
    return { fresh: true, sequence: this.row(kind, callId, eventId)!.sequence };
  }
  /** Only fresh=true on the original acknowledged call can precede transport. Replay is NEVER permission to resend. */
  recordSend(expected: GuardFence, value: unknown) {
    const fence = sendFence(expected),
      intent = sendIntent(value);
    return this.#storage.transactionSync(() => {
      this.#check(fence);
      const state = this.#identity(fence),
        now = this.now();
      ensure(intent.dispatchedAt <= now && now < intent.price.validUntil, 'GUARD_COST_EXPIRED');
      if (intent.call.scope.kind === 'player') {
        const playerId = intent.call.scope.playerId,
          account = state.accounts.find((a) => a.id === playerId);
        ensure(
          account?.status === 'active' &&
            account.meteringId === intent.meteringId &&
            !state.tombstones.includes(playerId),
          'GUARD_COST_OWNER_FORBIDDEN',
        );
      }
      return this.append('send', intent.call.id, '', { fence, intent }, null);
    });
  }
  /** Late charge facts must remain recordable while permission access is frozen/pending. They cannot authorize publication or more sends. */
  recordObservation(identity: GuardIdentity, callId: string, eventId: string, value: unknown) {
    id(callId);
    id(eventId);
    const observation = costObservation(value);
    return this.#storage.transactionSync(() => {
      this.#identity(identity);
      ensure(!this.row('reconciliation', callId, eventId), 'GUARD_COST_CONFLICT');
      const row = this.row('send', callId, '');
      ensure(row, 'GUARD_COST_SEND_REQUIRED');
      const sent = this.decoded(row);
      ensure(sent.kind === 'send' && observation.usage.unit === sent.intent.call.bounds.unit, 'GUARD_COST_INVALID');
      this.#source(identity, sent.fence, sent.sequence);
      const previous = this.get<{ provider_request_id: string }>(
        'SELECT provider_request_id FROM guard_cost_facts WHERE call_id=? AND provider_request_id IS NOT NULL ORDER BY sequence DESC LIMIT 1',
        callId,
      );
      ensure(
        !previous ||
          observation.providerRequestId === null ||
          observation.providerRequestId === previous.provider_request_id,
        'GUARD_COST_RECEIPT_CONFLICT',
      );
      return this.append('observation', callId, eventId, observation, observation.providerRequestId);
    });
  }
  /** Already-authorized, committed admin correction; late delivery never grants a new send. */
  recordReconciliation(identity: GuardIdentity, callId: string, eventId: string, value: unknown) {
    id(callId);
    id(eventId);
    const correction = costReconciliation(value);
    return this.#storage.transactionSync(() => {
      this.#identity(identity);
      const row = this.row('send', callId, '');
      ensure(row, 'GUARD_COST_SEND_REQUIRED');
      const send = this.decoded(row);
      ensure(send.kind === 'send' && send.intent.price.currency === correction.currency, 'GUARD_COST_INVALID');
      this.#source(identity, send.fence, send.sequence);
      ensure(!this.row('observation', callId, eventId), 'GUARD_COST_CONFLICT');
      return this.append('reconciliation', callId, eventId, correction, null);
    });
  }
  watermark(identity: GuardIdentity): number {
    this.#identity(identity);
    const n = this.get<{ n: number }>('SELECT COALESCE(MAX(sequence),0) n FROM guard_cost_facts')!.n;
    ensure(Number.isSafeInteger(n) && n >= 0, 'GUARD_COST_INTEGRITY_ERROR');
    return n;
  }
  /** Internal bounded recovery export through a fixed watermark; not a player/admin HTTP endpoint. */
  facts(identity: GuardIdentity, after: number, through: number, limit = 100) {
    ensure(
      Number.isSafeInteger(after) &&
        after >= 0 &&
        Number.isSafeInteger(through) &&
        through >= after &&
        Number.isSafeInteger(limit) &&
        limit >= 1 &&
        limit <= 100,
      'GUARD_COST_CURSOR_INVALID',
    );
    return this.#storage.transactionSync(() => {
      ensure(through <= this.watermark(identity), 'GUARD_COST_CURSOR_INVALID');
      const rows = this.sql(
        'SELECT * FROM guard_cost_facts WHERE sequence>? AND sequence<=? ORDER BY sequence LIMIT ?',
        after,
        through,
        limit,
      ) as unknown as FactRow[];
      ensure(
        rows.every((row, i) => row.sequence === after + i + 1) && (rows.length > 0 || after === through),
        'GUARD_COST_INTEGRITY_ERROR',
      );
      const facts = rows.map((row) => this.decoded(row));
      return {
        facts,
        after: facts.at(-1)?.sequence ?? after,
        through,
        done: (facts.at(-1)?.sequence ?? after) === through,
      };
    });
  }
}

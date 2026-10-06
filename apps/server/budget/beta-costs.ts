import { createHash } from 'node:crypto';
import type { ReadDatabase } from '../platform/store-contract.ts';
import type { Clock } from '../../../packages/contracts/index.ts';
import type {
  CostBounds,
  CostBudget,
  CostCall,
  CostCallInput,
  CostObservation,
  CostOwner,
  CostPrice,
  CostScope,
  CostUsage,
} from '../../../packages/contracts/admin-costs.ts';
import { ensure } from '../../../packages/domain/errors.ts';
import type { BusinessStore as Store } from '../platform/store-contract.ts';

const maxMoney = 10n ** 40n - 1n,
  million = 1_000_000n;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function record(value: unknown): asserts value is Record<string, unknown> {
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value), 'INVALID_COST_INPUT');
}
function object(value: unknown, fields: string[]): asserts value is Record<string, unknown> {
  ensure(
    value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).length === fields.length &&
      fields.every((key) => Object.hasOwn(value, key)),
    'INVALID_COST_INPUT',
  );
}
function id(value: unknown): asserts value is string {
  ensure(typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value), 'INVALID_COST_INPUT');
}
function money(value: unknown): asserts value is string {
  ensure(typeof value === 'string' && /^(0|[1-9][0-9]{0,39})$/.test(value), 'INVALID_COST_AMOUNT');
}
function currency(value: unknown): asserts value is string {
  ensure(typeof value === 'string' && /^[A-Z]{3}$/.test(value), 'INVALID_COST_CURRENCY');
}
function time(value: unknown): asserts value is number {
  ensure(
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 8_640_000_000_000_000,
    'INVALID_COST_TIME',
  );
}
function quantity(value: unknown): asserts value is number {
  ensure(
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000_000,
    'INVALID_COST_USAGE',
  );
}
function amount(value: bigint) {
  ensure(value >= 0n && value <= maxMoney, 'COST_AMOUNT_OVERFLOW');
  return value.toString();
}
function owner(value: unknown): CostOwner {
  record(value);
  if (value.kind === 'player') {
    object(value, ['kind', 'playerId']);
    id(value.playerId);
    return { kind: 'player', playerId: value.playerId };
  }
  object(value, ['kind']);
  ensure(value.kind === 'global' || value.kind === 'operations', 'INVALID_COST_INPUT');
  return { kind: value.kind };
}
const ownerKey = (value: CostOwner) => (value.kind === 'player' ? 'player:' + value.playerId : value.kind);
function scope(value: unknown): CostScope {
  record(value);
  if (value.kind === 'player') {
    object(value, ['kind', 'playerId', 'worldId', 'conversationId', 'characterId']);
    id(value.playerId);
    id(value.worldId);
    id(value.conversationId);
    id(value.characterId);
    return {
      kind: 'player',
      playerId: value.playerId,
      worldId: value.worldId,
      conversationId: value.conversationId,
      characterId: value.characterId,
    };
  }
  object(value, ['kind', 'characterId']);
  ensure(value.kind === 'operations', 'INVALID_COST_INPUT');
  if (value.characterId !== null) id(value.characterId);
  return { kind: 'operations', characterId: value.characterId };
}
export function costPrice(value: unknown): CostPrice {
  object(value, ['id', 'provider', 'model', 'currency', 'validFrom', 'validUntil', 'rates']);
  id(value.id);
  id(value.provider);
  id(value.model);
  currency(value.currency);
  time(value.validFrom);
  time(value.validUntil);
  ensure(value.validUntil > value.validFrom, 'INVALID_COST_TIME');
  const rates = value.rates;
  record(rates);
  const common = {
    id: value.id,
    provider: value.provider,
    model: value.model,
    currency: value.currency,
    validFrom: value.validFrom,
    validUntil: value.validUntil,
  };
  if (rates.unit === 'tokens') {
    object(rates, ['unit', 'cacheHitInput', 'cacheMissInput', 'output']);
    money(rates.cacheHitInput);
    money(rates.cacheMissInput);
    money(rates.output);
    return {
      ...common,
      rates: {
        unit: 'tokens',
        cacheHitInput: rates.cacheHitInput,
        cacheMissInput: rates.cacheMissInput,
        output: rates.output,
      },
    };
  }
  object(rates, ['unit', 'bytes']);
  ensure(rates.unit === 'utf8_bytes', 'INVALID_COST_INPUT');
  money(rates.bytes);
  return { ...common, rates: { unit: 'utf8_bytes', bytes: rates.bytes } };
}
function bounds(value: unknown): CostBounds {
  record(value);
  if (value.unit === 'tokens') {
    object(value, ['unit', 'inputTokens', 'outputTokens']);
    quantity(value.inputTokens);
    quantity(value.outputTokens);
    return { unit: 'tokens', inputTokens: value.inputTokens, outputTokens: value.outputTokens };
  }
  object(value, ['unit', 'bytes']);
  ensure(value.unit === 'utf8_bytes', 'INVALID_COST_INPUT');
  quantity(value.bytes);
  return { unit: 'utf8_bytes', bytes: value.bytes };
}
export function costUsage(value: unknown): CostUsage {
  record(value);
  if (value.unit === 'tokens') {
    object(value, ['unit', 'inputTokens', 'cacheHitInputTokens', 'cacheMissInputTokens', 'outputTokens']);
    const { inputTokens, cacheHitInputTokens, cacheMissInputTokens, outputTokens } = value;
    for (const v of [inputTokens, cacheHitInputTokens, cacheMissInputTokens, outputTokens]) if (v !== null) quantity(v);
    const input = inputTokens as number | null,
      hit = cacheHitInputTokens as number | null,
      miss = cacheMissInputTokens as number | null;
    ensure(
      input === null ||
        ((hit === null || hit <= input) &&
          (miss === null || miss <= input) &&
          (hit === null || miss === null || hit + miss === input)),
      'INVALID_COST_USAGE',
    );
    return {
      unit: 'tokens',
      inputTokens: input,
      cacheHitInputTokens: hit,
      cacheMissInputTokens: miss,
      outputTokens: outputTokens as number | null,
    };
  }
  object(value, ['unit', 'bytes']);
  ensure(value.unit === 'utf8_bytes', 'INVALID_COST_INPUT');
  if (value.bytes !== null) quantity(value.bytes);
  return { unit: 'utf8_bytes', bytes: value.bytes as number | null };
}
export function estimateCost(price: CostPrice, usage: CostUsage): string | null {
  const rates = costPrice(price).rates,
    used = costUsage(usage);
  ensure(rates.unit === used.unit, 'INVALID_COST_USAGE');
  let numerator: bigint;
  if (rates.unit === 'tokens' && used.unit === 'tokens') {
    if (
      used.inputTokens === null ||
      used.outputTokens === null ||
      (used.cacheHitInputTokens === null && used.cacheMissInputTokens === null)
    )
      return null;
    const hit = used.cacheHitInputTokens ?? used.inputTokens - used.cacheMissInputTokens!,
      miss = used.cacheMissInputTokens ?? used.inputTokens - hit;
    numerator =
      BigInt(hit) * BigInt(rates.cacheHitInput) +
      BigInt(miss) * BigInt(rates.cacheMissInput) +
      BigInt(used.outputTokens) * BigInt(rates.output);
  } else if (rates.unit === 'utf8_bytes' && used.unit === 'utf8_bytes') {
    if (used.bytes === null) return null;
    numerator = BigInt(used.bytes) * BigInt(rates.bytes);
  } else {
    ensure(false, 'INVALID_COST_USAGE');
  }
  return amount((numerator + million - 1n) / million);
}
function reservation(price: CostPrice, limit: CostBounds): string {
  if (limit.unit === 'utf8_bytes') return estimateCost(price, limit)!;
  ensure(price.rates.unit === 'tokens', 'INVALID_COST_USAGE');
  const hitHigher = BigInt(price.rates.cacheHitInput) > BigInt(price.rates.cacheMissInput);
  return estimateCost(price, {
    unit: 'tokens',
    inputTokens: limit.inputTokens,
    outputTokens: limit.outputTokens,
    cacheHitInputTokens: hitHigher ? limit.inputTokens : 0,
    cacheMissInputTokens: hitHigher ? 0 : limit.inputTokens,
  })!;
}
function input(value: unknown): CostCallInput {
  object(value, ['id', 'scope', 'function', 'taskId', 'stage', 'provider', 'model', 'bounds']);
  id(value.id);
  id(value.taskId);
  id(value.provider);
  id(value.model);
  const who = scope(value.scope),
    limit = bounds(value.bounds);
  const functions =
    who.kind === 'player'
      ? ['chat', 'proactive_chat', 'moment_post', 'moment_reply']
      : ['character_preview', 'voice_preview', 'source_summary'];
  ensure(typeof value.function === 'string' && functions.includes(value.function), 'INVALID_COST_INPUT');
  const stages =
    value.function === 'source_summary'
      ? ['source_summary']
      : value.function === 'voice_preview'
        ? ['speech']
        : value.function === 'character_preview'
          ? ['draft', 'review']
          : ['draft', 'review', 'speech'];
  ensure(
    typeof value.stage === 'string' &&
      stages.includes(value.stage) &&
      (value.stage === 'speech' ? limit.unit === 'utf8_bytes' : limit.unit === 'tokens'),
    'INVALID_COST_INPUT',
  );
  return {
    id: value.id,
    scope: who,
    function: value.function as CostCallInput['function'],
    taskId: value.taskId,
    stage: value.stage as CostCallInput['stage'],
    provider: value.provider,
    model: value.model,
    bounds: limit,
  };
}
function observation(value: unknown): CostObservation {
  object(value, ['outcome', 'providerRequestId', 'reportedModel', 'usage', 'errorCode']);
  ensure(
    value.outcome === 'succeeded' || value.outcome === 'failed' || value.outcome === 'interrupted',
    'INVALID_COST_INPUT',
  );
  if (value.reportedModel !== null) id(value.reportedModel);
  ensure(
    value.providerRequestId === null ||
      (typeof value.providerRequestId === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(value.providerRequestId)),
    'INVALID_COST_INPUT',
  );
  ensure(
    value.errorCode === null || (typeof value.errorCode === 'string' && /^[A-Z][A-Z0-9_]{0,80}$/.test(value.errorCode)),
    'INVALID_COST_INPUT',
  );
  ensure(value.outcome !== 'succeeded' || value.errorCode === null, 'INVALID_COST_INPUT');
  return {
    outcome: value.outcome,
    providerRequestId: value.providerRequestId as string | null,
    reportedModel: value.reportedModel as string | null,
    usage: costUsage(value.usage),
    errorCode: value.errorCode as string | null,
  };
}
const callInput = (call: CostCall) =>
  input({
    id: call.id,
    scope: call.scope,
    function: call.function,
    taskId: call.taskId,
    stage: call.stage,
    provider: call.provider,
    model: call.model,
    bounds: call.bounds,
  });

/** Business-service ledger. Adapters receive callbacks later; no model/audio process writes these tables. */
export class BetaCosts {
  readonly store: Store;
  readonly clock: Clock;
  constructor(store: Store, clock: Clock) {
    ensure(store.beta, 'BETA_DISABLED');
    this.store = store;
    this.clock = clock;
  }
  addPrice(value: unknown): CostPrice {
    const price = costPrice(value),
      digest = hash(price),
      now = this.now();
    return this.store.transaction(() => {
      const old = this.store.get<{ input_hash: string }>(
        'SELECT input_hash FROM beta_cost_prices WHERE id=?',
        price.id,
      );
      if (old) {
        ensure(old.input_hash === digest, 'COST_PRICE_IMMUTABLE');
        return this.price(price.id);
      }
      ensure(
        !this.store.get(
          `SELECT 1 FROM beta_cost_prices WHERE provider=? AND model=? AND unit=? AND valid_from<? AND valid_until>?`,
          price.provider,
          price.model,
          price.rates.unit,
          price.validUntil,
          price.validFrom,
        ),
        'COST_PRICE_OVERLAP',
      );
      this.store.run(
        'INSERT INTO beta_cost_prices VALUES (?,?,?,?,?,?,?,?,?,?)',
        price.id,
        price.provider,
        price.model,
        price.rates.unit,
        price.currency,
        price.validFrom,
        price.validUntil,
        digest,
        JSON.stringify(price),
        now,
      );
      return price;
    });
  }
  price(id: string): CostPrice {
    const row = this.store.get<{ value_json: string }>('SELECT value_json FROM beta_cost_prices WHERE id=?', id);
    ensure(row, 'COST_PRICE_REQUIRED');
    return costPrice(JSON.parse(row.value_json));
  }
  configureBudget(value: unknown): CostBudget {
    object(value, ['requestId', 'id', 'owner', 'currency', 'from', 'until', 'expectedRevision', 'limitMicros']);
    id(value.requestId);
    id(value.id);
    currency(value.currency);
    time(value.from);
    time(value.until);
    money(value.limitMicros);
    ensure(
      value.until > value.from &&
        typeof value.expectedRevision === 'number' &&
        Number.isSafeInteger(value.expectedRevision) &&
        value.expectedRevision >= 0 &&
        value.expectedRevision < Number.MAX_SAFE_INTEGER,
      'INVALID_COST_INPUT',
    );
    const who = owner(value.owner),
      v = {
        requestId: value.requestId,
        id: value.id,
        owner: who,
        currency: value.currency,
        from: value.from,
        until: value.until,
        expectedRevision: value.expectedRevision,
        limitMicros: value.limitMicros,
      },
      digest = hash(v);
    return this.store.transaction(() => {
      const receipt = this.store.get<{ input_hash: string; result_json: string }>(
        'SELECT * FROM beta_cost_admin_receipts WHERE request_id=?',
        v.requestId,
      );
      if (receipt) {
        ensure(receipt.input_hash === digest, 'IDEMPOTENCY_CONFLICT');
        return JSON.parse(receipt.result_json) as CostBudget;
      }
      if (who.kind === 'player')
        ensure(this.store.get('SELECT 1 FROM beta_accounts WHERE player_id=?', who.playerId), 'NOT_FOUND');
      const row = this.store.get<{ value_json: string }>('SELECT value_json FROM beta_cost_budgets WHERE id=?', v.id),
        old: CostBudget | null = row ? JSON.parse(row.value_json) : null;
      ensure((old?.revision ?? 0) === v.expectedRevision, 'COST_BUDGET_CONFLICT');
      if (old)
        ensure(
          ownerKey(old.owner) === ownerKey(who) &&
            old.currency === v.currency &&
            old.from === v.from &&
            old.until === v.until,
          'COST_BUDGET_WINDOW_IMMUTABLE',
        );
      ensure(
        !this.store.get(
          'SELECT 1 FROM beta_cost_budgets WHERE id!=? AND owner_key=? AND currency=? AND starts_at<? AND ends_at>?',
          v.id,
          ownerKey(who),
          v.currency,
          v.until,
          v.from,
        ),
        'COST_BUDGET_OVERLAP',
      );
      const result: CostBudget = {
        id: v.id,
        owner: who,
        currency: v.currency,
        from: v.from,
        until: v.until,
        revision: v.expectedRevision + 1,
        limitMicros: v.limitMicros,
        heldMicros: old?.heldMicros ?? '0',
        chargedMicros: old?.chargedMicros ?? '0',
      };
      this.store.run(
        `INSERT INTO beta_cost_budgets VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET value_json=excluded.value_json`,
        result.id,
        ownerKey(who),
        result.currency,
        result.from,
        result.until,
        JSON.stringify(result),
      );
      this.store.run(
        'INSERT INTO beta_cost_admin_receipts VALUES (?,?,?,?)',
        v.requestId,
        digest,
        JSON.stringify(result),
        this.now(),
      );
      return result;
    });
  }
  budget(id: string): CostBudget {
    const row = this.store.get<{ value_json: string }>('SELECT value_json FROM beta_cost_budgets WHERE id=?', id);
    ensure(row, 'COST_BUDGET_REQUIRED');
    return JSON.parse(row.value_json) as CostBudget;
  }
  reserve(value: unknown): { call: CostCall; duplicate: boolean } {
    const v = input(value),
      digest = hash(v),
      now = this.now();
    return this.store.transaction(() => {
      const old = this.store.get<{ input_hash: string }>('SELECT input_hash FROM beta_cost_calls WHERE id=?', v.id);
      if (old) {
        ensure(old.input_hash === digest, 'IDEMPOTENCY_CONFLICT');
        return { call: this.call(v.id), duplicate: true };
      }
      let meteringId: string | null = null;
      if (v.scope.kind === 'player') {
        const s = v.scope,
          account = this.store.get<{ status: string; metering_id: string }>(
            'SELECT status,metering_id FROM beta_accounts WHERE player_id=?',
            s.playerId,
          );
        ensure(account, 'NOT_FOUND');
        ensure(account.status === 'active', 'ACCOUNT_SUSPENDED');
        meteringId = account.metering_id;
        ensure(
          this.store.get(
            `SELECT 1 FROM worlds w JOIN participants p ON p.world_id=w.id WHERE w.owner_id=? AND w.id=? AND p.conversation_id=? AND p.character_id=?`,
            s.playerId,
            s.worldId,
            s.conversationId,
            s.characterId,
          ),
          'COST_SCOPE_MISMATCH',
        );
      }
      const priceRow = this.store.get<{ id: string }>(
        'SELECT id FROM beta_cost_prices WHERE provider=? AND model=? AND unit=? AND valid_from<=? AND valid_until>?',
        v.provider,
        v.model,
        v.bounds.unit,
        now,
        now,
      );
      ensure(priceRow, 'COST_PRICE_REQUIRED');
      const price = this.price(priceRow.id),
        reservedMicros = reservation(price, v.bounds);
      const global = this.activeBudget({ kind: 'global' }, price.currency, now),
        personal = this.activeBudget(
          v.scope.kind === 'player' ? { kind: 'player', playerId: v.scope.playerId } : { kind: 'operations' },
          price.currency,
          now,
        );
      for (const b of [global, personal]) {
        ensure(
          BigInt(b.chargedMicros) + BigInt(b.heldMicros) + BigInt(reservedMicros) <= BigInt(b.limitMicros),
          'BETA_USAGE_LIMIT',
        );
        this.saveBudget({ ...b, heldMicros: amount(BigInt(b.heldMicros) + BigInt(reservedMicros)) });
      }
      const call: CostCall = {
        ...v,
        meteringId,
        priceId: price.id,
        currency: price.currency,
        globalBudgetId: global.id,
        ownerBudgetId: personal.id,
        reservedMicros,
        state: 'reserved',
        revision: 1,
        basis: 'pending',
        amountMicros: null,
        reviewRequired: false,
        observation: null,
        createdAt: now,
        dispatchedAt: null,
        updatedAt: now,
      };
      const s = v.scope;
      this.store.run(
        `INSERT INTO beta_cost_calls(id,input_hash,player_id,metering_id,world_id,conversation_id,character_id,function,task_id,stage,provider,model,
        price_id,currency,global_budget_id,owner_budget_id,state,value_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        v.id,
        digest,
        s.kind === 'player' ? s.playerId : null,
        meteringId,
        s.kind === 'player' ? s.worldId : null,
        s.kind === 'player' ? s.conversationId : null,
        s.characterId,
        v.function,
        v.taskId,
        v.stage,
        v.provider,
        v.model,
        price.id,
        price.currency,
        global.id,
        personal.id,
        call.state,
        JSON.stringify(call),
        now,
      );
      return { call, duplicate: false };
    });
  }
  /** Persist once before transport starts. A replay is not permission for a second external call. */
  dispatch(id: string): CostCall {
    return this.store.transaction(() => {
      const call = this.call(id);
      ensure(call.state === 'reserved', 'COST_CALL_ALREADY_DISPATCHED');
      if (call.scope.kind === 'player')
        ensure(
          this.store.get("SELECT 1 FROM beta_accounts WHERE player_id=? AND status='active'", call.scope.playerId),
          'ACCOUNT_SUSPENDED',
        );
      const now = this.now();
      ensure(now >= call.createdAt, 'INVALID_COST_TIME');
      const price = this.price(call.priceId);
      ensure(
        now < price.validUntil && [call.globalBudgetId, call.ownerBudgetId].every((id) => now < this.budget(id).until),
        'COST_RESERVATION_EXPIRED',
      );
      for (const id of [call.globalBudgetId, call.ownerBudgetId]) {
        const b = this.budget(id);
        ensure(BigInt(b.heldMicros) + BigInt(b.chargedMicros) <= BigInt(b.limitMicros), 'BETA_USAGE_LIMIT');
      }
      return this.saveCall({
        ...call,
        state: 'dispatched',
        dispatchedAt: now,
        updatedAt: now,
        revision: call.revision + 1,
      });
    });
  }
  observe(id: string, requestId: string, value: unknown): CostCall {
    const v = observation(value);
    return this.event(id, requestId, 'observation', v, (call) => {
      ensure(['dispatched', 'unknown', 'finished'].includes(call.state), 'COST_CALL_CLOSED');
      ensure(v.usage.unit === call.bounds.unit, 'INVALID_COST_USAGE');
      ensure(
        call.observation?.providerRequestId == null || v.providerRequestId === call.observation.providerRequestId,
        'COST_PROVIDER_RECEIPT_MISMATCH',
      );
      const estimated = estimateCost(this.price(call.priceId), v.usage);
      // A late callback never erases a known charge or silently overrides an operator's reconciled bill.
      if (call.state === 'finished' && (call.basis === 'reconciled' || estimated === null)) {
        return { ...call, observation: v, reviewRequired: call.reviewRequired || hash(v) !== hash(call.observation) };
      }
      const next: CostCall = {
        ...call,
        state: estimated === null ? 'unknown' : 'finished',
        basis: estimated === null ? 'unknown' : 'estimated',
        amountMicros: estimated,
        reviewRequired: estimated === null,
        observation: v,
      };
      this.adjustBudgets(call, next);
      return next;
    });
  }
  reconcile(id: string, requestId: string, value: unknown): CostCall {
    const v = costReconciliation(value);
    return this.event(id, requestId, 'reconciliation', v, (call) => {
      ensure(
        call.dispatchedAt !== null && call.state !== 'cancelled' && call.revision === v.expectedRevision,
        'COST_CALL_CONFLICT',
      );
      ensure(call.currency === v.currency, 'COST_CURRENCY_MISMATCH');
      const next: CostCall = {
        ...call,
        state: 'finished',
        basis: 'reconciled',
        amountMicros: v.amountMicros,
        reviewRequired: false,
      };
      this.adjustBudgets(call, next);
      return next;
    });
  }
  cancelReserved(id: string, requestId: string): CostCall {
    return this.event(id, requestId, 'cancel', {}, (call) => {
      ensure(call.state === 'reserved' && call.dispatchedAt === null, 'COST_CALL_ALREADY_DISPATCHED');
      const next: CostCall = {
        ...call,
        state: 'cancelled',
        basis: 'not_sent',
        amountMicros: '0',
        reviewRequired: false,
      };
      this.adjustBudgets(call, next);
      return next;
    });
  }
  call(id: string): CostCall {
    const row = this.store.get<{ value_json: string }>('SELECT value_json FROM beta_cost_calls WHERE id=?', id);
    ensure(row, 'NOT_FOUND');
    return JSON.parse(row.value_json) as CostCall;
  }
  private activeBudget(who: CostOwner, code: string, now: number) {
    const row = this.store.get<{ id: string }>(
      'SELECT id FROM beta_cost_budgets WHERE owner_key=? AND currency=? AND starts_at<=? AND ends_at>?',
      ownerKey(who),
      code,
      now,
      now,
    );
    ensure(row, 'COST_BUDGET_REQUIRED');
    return this.budget(row.id);
  }
  private saveBudget(budget: CostBudget) {
    this.store.run('UPDATE beta_cost_budgets SET value_json=? WHERE id=?', JSON.stringify(budget), budget.id);
  }
  private saveCall(call: CostCall): CostCall {
    ensure(Number.isSafeInteger(call.revision), 'COST_CALL_CONFLICT');
    this.store.run(
      'UPDATE beta_cost_calls SET state=?,value_json=? WHERE id=?',
      call.state,
      JSON.stringify(call),
      call.id,
    );
    return call;
  }
  private adjustBudgets(before: CostCall, after: CostCall) {
    const commitment = (call: CostCall) => ({
      held: ['reserved', 'dispatched', 'unknown'].includes(call.state) ? BigInt(call.reservedMicros) : 0n,
      charged: call.state === 'finished' ? BigInt(call.amountMicros!) : 0n,
    });
    const a = commitment(before),
      b = commitment(after);
    for (const id of [before.globalBudgetId, before.ownerBudgetId]) {
      const current = this.budget(id);
      this.saveBudget({
        ...current,
        heldMicros: amount(BigInt(current.heldMicros) + b.held - a.held),
        chargedMicros: amount(BigInt(current.chargedMicros) + b.charged - a.charged),
      });
    }
  }
  private event(
    id: string,
    requestId: string,
    kind: 'observation' | 'reconciliation' | 'cancel',
    value: unknown,
    update: (call: CostCall) => CostCall,
  ): CostCall {
    idText(id);
    idText(requestId);
    const digest = hash({ kind, value });
    return this.store.transaction(() => {
      const old = this.store.get<{ input_hash: string; result_json: string }>(
        'SELECT input_hash,result_json FROM beta_cost_events WHERE call_id=? AND request_id=?',
        id,
        requestId,
      );
      if (old) {
        ensure(old.input_hash === digest, 'IDEMPOTENCY_CONFLICT');
        return JSON.parse(old.result_json) as CostCall;
      }
      const previous = this.call(id),
        now = this.now();
      ensure(now >= previous.updatedAt, 'INVALID_COST_TIME');
      const next = this.saveCall({ ...update(previous), revision: previous.revision + 1, updatedAt: now });
      this.store.run(
        'INSERT INTO beta_cost_events(call_id,request_id,kind,input_hash,input_json,result_json,created_at) VALUES (?,?,?,?,?,?,?)',
        id,
        requestId,
        kind,
        digest,
        JSON.stringify(value),
        JSON.stringify(next),
        now,
      );
      return next;
    });
  }
  private now() {
    const now = this.clock.now();
    time(now);
    return now;
  }
}
// Local alias avoids shadowing the validator in methods with a call-id argument.
function idText(value: unknown): asserts value is string {
  id(value);
}

/** Verify frozen prices, account scope, receipts and budget counters before a backup can be trusted. */
export function validateCostLedger(db: ReadDatabase) {
  const valid = (condition: unknown) => ensure(condition, 'BACKUP_INVALID_COST_LEDGER');
  const prices = new Map<string, CostPrice>(),
    budgets = new Map<string, { value: CostBudget; held: bigint; charged: bigint }>();
  for (const row of db.prepare('SELECT * FROM beta_cost_prices').iterate()) {
    const price = costPrice(JSON.parse(String(row.value_json)));
    valid(
      price.id === row.id &&
        price.provider === row.provider &&
        price.model === row.model &&
        price.rates.unit === row.unit &&
        price.currency === row.currency &&
        price.validFrom === row.valid_from &&
        price.validUntil === row.valid_until &&
        hash(price) === row.input_hash,
    );
    prices.set(price.id, price);
  }
  for (const row of db.prepare('SELECT * FROM beta_cost_budgets').iterate()) {
    const b = JSON.parse(String(row.value_json)) as CostBudget;
    money(b.limitMicros);
    money(b.heldMicros);
    money(b.chargedMicros);
    id(b.id);
    currency(b.currency);
    time(b.from);
    time(b.until);
    valid(
      b.id === row.id &&
        ownerKey(owner(b.owner)) === row.owner_key &&
        b.currency === row.currency &&
        b.from === row.starts_at &&
        b.until === row.ends_at &&
        Number.isSafeInteger(b.revision) &&
        b.revision > 0,
    );
    budgets.set(b.id, { value: b, held: 0n, charged: 0n });
  }
  valid(
    !db
      .prepare(`SELECT 1 FROM beta_cost_prices a JOIN beta_cost_prices b ON a.id<b.id AND a.provider=b.provider AND a.model=b.model AND a.unit=b.unit
    AND a.valid_from<b.valid_until AND a.valid_until>b.valid_from LIMIT 1`)
      .get(),
  );
  valid(
    !db
      .prepare(`SELECT 1 FROM beta_cost_budgets a JOIN beta_cost_budgets b ON a.id<b.id AND a.owner_key=b.owner_key AND a.currency=b.currency
    AND a.starts_at<b.ends_at AND a.ends_at>b.starts_at LIMIT 1`)
      .get(),
  );
  const lastEvent = db.prepare('SELECT result_json FROM beta_cost_events WHERE call_id=? ORDER BY seq DESC LIMIT 1');
  for (const row of db.prepare('SELECT * FROM beta_cost_calls').iterate()) {
    const call = JSON.parse(String(row.value_json)) as CostCall,
      v = callInput(call),
      p = prices.get(call.priceId);
    money(call.reservedMicros);
    valid(
      v.id === row.id &&
        hash(v) === row.input_hash &&
        call.state === row.state &&
        call.provider === row.provider &&
        call.model === row.model &&
        call.priceId === row.price_id &&
        call.currency === row.currency &&
        call.globalBudgetId === row.global_budget_id &&
        call.ownerBudgetId === row.owner_budget_id &&
        call.taskId === row.task_id &&
        call.stage === row.stage &&
        call.function === row.function &&
        call.createdAt === row.created_at,
    );
    valid(
      p &&
        p.provider === call.provider &&
        p.model === call.model &&
        p.currency === call.currency &&
        p.validFrom <= call.createdAt &&
        p.validUntil > call.createdAt &&
        reservation(p, call.bounds) === call.reservedMicros,
    );
    time(call.createdAt);
    time(call.updatedAt);
    valid(
      call.updatedAt >= call.createdAt &&
        Number.isSafeInteger(call.revision) &&
        call.revision > 0 &&
        typeof call.reviewRequired === 'boolean',
    );
    if (call.dispatchedAt !== null) {
      time(call.dispatchedAt);
      valid(call.dispatchedAt >= call.createdAt && call.dispatchedAt <= call.updatedAt);
    }
    if (call.observation !== null) observation(call.observation);
    valid(call.scope.characterId === row.character_id);
    if (call.scope.kind === 'player') {
      valid(
        call.scope.playerId === row.player_id &&
          call.meteringId === row.metering_id &&
          call.scope.worldId === row.world_id &&
          call.scope.conversationId === row.conversation_id,
      );
      valid(
        db
          .prepare(
            'SELECT 1 FROM beta_accounts a JOIN worlds w ON w.owner_id=a.player_id WHERE a.player_id=? AND a.metering_id=? AND w.id=?',
          )
          .get(call.scope.playerId, call.meteringId, call.scope.worldId),
      );
    } else
      valid(
        row.player_id === null &&
          row.metering_id === null &&
          call.meteringId === null &&
          row.world_id === null &&
          row.conversation_id === null,
      );
    const holding = ['reserved', 'dispatched', 'unknown'].includes(call.state);
    if (holding)
      valid(
        call.amountMicros === null &&
          call.basis === (call.state === 'unknown' ? 'unknown' : 'pending') &&
          (call.state === 'reserved' ? call.dispatchedAt === null : call.dispatchedAt !== null),
      );
    else if (call.state === 'cancelled')
      valid(call.basis === 'not_sent' && call.amountMicros === '0' && call.dispatchedAt === null);
    else {
      valid(
        call.state === 'finished' && ['estimated', 'reconciled'].includes(call.basis) && call.dispatchedAt !== null,
      );
      money(call.amountMicros);
      if (call.basis === 'estimated' && !call.reviewRequired)
        valid(call.observation && estimateCost(p!, call.observation.usage) === call.amountMicros);
    }
    for (const [budgetId, key] of [
      [call.globalBudgetId, 'global'],
      [call.ownerBudgetId, call.scope.kind === 'player' ? 'player:' + call.scope.playerId : 'operations'],
    ]) {
      const b = budgets.get(budgetId!);
      valid(
        b &&
          ownerKey(b.value.owner) === key &&
          b.value.currency === call.currency &&
          b.value.from <= call.createdAt &&
          b.value.until > call.createdAt,
      );
      if (holding) b!.held += BigInt(call.reservedMicros);
      else if (call.state === 'finished') b!.charged += BigInt(call.amountMicros!);
    }
    const last = lastEvent.get(call.id);
    valid(['reserved', 'dispatched'].includes(call.state) ? !last : last?.result_json === row.value_json);
  }
  for (const b of budgets.values())
    valid(b.held.toString() === b.value.heldMicros && b.charged.toString() === b.value.chargedMicros);
  const latestCall = db.prepare('SELECT value_json FROM beta_cost_calls WHERE id=?');
  const previousEvent = db.prepare(
    'SELECT result_json FROM beta_cost_events WHERE call_id=? AND seq<? ORDER BY seq DESC LIMIT 1',
  );
  for (const row of db.prepare('SELECT * FROM beta_cost_events ORDER BY seq').iterate()) {
    const value = JSON.parse(String(row.input_json)),
      result = JSON.parse(String(row.result_json)) as CostCall;
    const stored = latestCall.get(row.call_id!);
    valid(stored);
    const latest = JSON.parse(String(stored!.value_json)) as CostCall;
    valid(
      latest &&
        result.id === latest.id &&
        hash(callInput(result)) === hash(callInput(latest)) &&
        result.revision <= latest.revision &&
        hash({ kind: row.kind, value }) === row.input_hash,
    );
    for (const key of [
      'priceId',
      'currency',
      'reservedMicros',
      'meteringId',
      'globalBudgetId',
      'ownerBudgetId',
      'createdAt',
      'dispatchedAt',
    ] as const)
      valid(result[key] === latest[key]);
    valid(result.updatedAt === row.created_at && Number.isSafeInteger(result.revision) && result.revision > 1);
    if (row.kind === 'observation') {
      const observed = observation(value),
        estimated = estimateCost(prices.get(result.priceId)!, observed.usage);
      valid(hash(observed) === hash(result.observation));
      if (result.basis === 'reconciled' || (result.state === 'finished' && estimated === null)) {
        const previous = previousEvent.get(row.call_id!, row.seq!);
        valid(previous);
        const before = JSON.parse(String(previous!.result_json)) as CostCall;
        valid(
          before.state === 'finished' &&
            result.state === 'finished' &&
            result.basis === before.basis &&
            result.amountMicros === before.amountMicros &&
            result.reviewRequired === (before.reviewRequired || hash(observed) !== hash(before.observation)),
        );
      } else
        valid(
          result.amountMicros === estimated &&
            result.state === (estimated === null ? 'unknown' : 'finished') &&
            result.basis === (estimated === null ? 'unknown' : 'estimated') &&
            result.reviewRequired === (estimated === null),
        );
    } else if (row.kind === 'reconciliation') {
      object(value, ['expectedRevision', 'currency', 'amountMicros', 'reference']);
      money(value.amountMicros);
      id(value.reference);
      valid(
        value.expectedRevision === result.revision - 1 &&
          value.currency === result.currency &&
          value.amountMicros === result.amountMicros &&
          result.basis === 'reconciled' &&
          result.state === 'finished' &&
          result.reviewRequired === false,
      );
    } else
      valid(
        row.kind === 'cancel' &&
          result.state === 'cancelled' &&
          result.amountMicros === '0' &&
          result.basis === 'not_sent' &&
          result.dispatchedAt === null &&
          Object.keys(value).length === 0,
      );
    if (result.revision === latest.revision) valid(JSON.stringify(result) === JSON.stringify(latest));
  }
  for (const row of db.prepare('SELECT * FROM beta_cost_admin_receipts').iterate()) {
    const b = JSON.parse(String(row.result_json)) as CostBudget,
      current = budgets.get(b.id);
    money(b.limitMicros);
    money(b.heldMicros);
    money(b.chargedMicros);
    valid(
      current &&
        ownerKey(owner(b.owner)) === ownerKey(current.value.owner) &&
        b.currency === current.value.currency &&
        b.from === current.value.from &&
        b.until === current.value.until &&
        Number.isSafeInteger(b.revision) &&
        b.revision > 0 &&
        b.revision <= current.value.revision,
    );
    valid(
      hash({
        requestId: row.request_id,
        id: b.id,
        owner: owner(b.owner),
        currency: b.currency,
        from: b.from,
        until: b.until,
        expectedRevision: b.revision - 1,
        limitMicros: b.limitMicros,
      }) === row.input_hash,
    );
  }
}

// Shared strict metadata validators for the independent Cloudflare recovery evidence.
export { input as costCallInput, observation as costObservation, reservation as costReservation };

export function costReconciliation(value: unknown) {
  object(value, ['expectedRevision', 'currency', 'amountMicros', 'reference']);
  currency(value.currency);
  money(value.amountMicros);
  idText(value.reference);
  ensure(
    typeof value.expectedRevision === 'number' &&
      Number.isSafeInteger(value.expectedRevision) &&
      value.expectedRevision > 0,
    'INVALID_COST_INPUT',
  );
  return {
    expectedRevision: value.expectedRevision,
    currency: value.currency,
    amountMicros: value.amountMicros,
    reference: value.reference,
  };
}

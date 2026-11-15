import { randomUUID } from 'node:crypto';
import type { Clock } from '../../../packages/contracts/index.ts';
import { DomainError, ensure } from '../../../packages/domain/errors.ts';
import { budgetHash } from '../budget/web-provider-budget-contract.ts';
import { contentHash } from '../characters/admin-content-hash.ts';
import type { ClipDirectionBudget, ClipDirectionModel } from '../characters/web-clip-direction.ts';
import type { BusinessStore } from '../platform/store-contract.ts';
import { COCREATION_TIDY_PROMPT } from './web-cocreation-tidy-prompt.ts';

/**
 * Part 39: 整理, the optional text half of the inbox. ONE budgeted call on the draft text model that tidies a submission into a story
 * entry and flags personal content or a contradiction of the canon. It only returns text: the administrator's edit box is filled, nothing
 * is adopted, nothing is written to the cast. Money exactly as for every other provider call (the clip-direction pattern): the price
 * must be in force, the local hold and the shared-budget reservation are made BEFORE the provider is called; an UNKNOWN call is never
 * sent again and its hold is never released; a known bill is settled once. Idempotent per request id.
 */
export const TIDY_OUTPUT_TOKENS = 900;
export const TIDY_USER_MAX = 3800;
export type TidyResult = { story: string; flags: string[] };
export type TidyInput = { members: string[]; text: string; reason: string; world: string; canon: string[] };
type Actor = { memberId: string; sessionId: string };
interface Row {
  id: string;
  request_hash: string;
  submission_id: string;
  state: 'intent' | 'sent' | 'unknown' | 'known' | 'released';
  outcome: 'succeeded' | 'failed' | null;
  error_code: string | null;
  result_json: string | null;
  held_micros: number;
  budget_id: string;
  fingerprint: string;
  charged_micros: number | null;
  receipt_json: string | null;
  shared_settled: number;
}
const natural = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0;
const clip = (value: string, max: number) => [...value].slice(0, max).join('');

/** The exact model-facing user message: the canon context is trimmed (deterministically) so it never exceeds TIDY_USER_MAX. */
export function tidyUserMessage(input: TidyInput): string {
  let world = clip(input.world, 600);
  let canon = input.canon.slice(0, 6).map((line) => clip(line, 100));
  const build = () => JSON.stringify({ members: input.members, text: input.text, reason: input.reason, world, canon });
  let message = build();
  while (message.length > TIDY_USER_MAX && (canon.length > 0 || world.length > 0)) {
    if (canon.length > 0) canon = canon.slice(0, -1);
    else world = clip(world, Math.max(0, world.length - 100));
    message = build();
  }
  return message;
}

/** The reply must be exactly {"story","flags"}; the story at most 600 code points, up to three short flags. */
export function parseTidy(text: string): TidyResult | null {
  try {
    const value = JSON.parse(text.trim()) as unknown;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (Object.keys(record).sort().join(',') !== 'flags,story') return null;
    const { story, flags } = record;
    if (
      typeof story !== 'string' ||
      story.trim() === '' ||
      [...story].length > 600 ||
      /[\u0000-\u001f\u007f]/u.test(story)
    )
      return null;
    if (
      !Array.isArray(flags) ||
      flags.length > 3 ||
      !flags.every(
        (f) => typeof f === 'string' && f.trim() !== '' && [...f].length <= 60 && !/[\u0000-\u001f\u007f]/u.test(f),
      )
    )
      return null;
    return { story, flags: flags as string[] };
  } catch {
    return null;
  }
}

export class WebCocreationTidy {
  private readonly store: BusinessStore;
  private readonly clock: Clock;
  private readonly model: ClipDirectionModel;
  private readonly budget: ClipDirectionBudget;
  private readonly nextId: () => string;
  private readonly inFlight = new Set<string>();
  private readonly settling = new Set<string>();
  constructor(
    store: BusinessStore,
    clock: Clock,
    model: ClipDirectionModel,
    budget: ClipDirectionBudget,
    nextId: () => string = randomUUID,
  ) {
    this.store = store;
    this.clock = clock;
    this.model = model;
    this.budget = budget;
    this.nextId = nextId;
  }
  private now() {
    const now = this.clock.now();
    ensure(natural(now), 'INVALID_TIME');
    return now;
  }
  private price() {
    const now = this.now();
    return this.store.get<{ id: string; upper_micros_per_unit: number }>(
      `SELECT id,upper_micros_per_unit FROM web_provider_prices
      WHERE provider='deepseek' AND phase='draft' AND model=? AND currency='USD' AND unit='token' AND valid_from<=? AND valid_until>?
      ORDER BY version DESC LIMIT 1`,
      this.model.model,
      now,
      now,
    );
  }
  /** Most tokens the request can use: every input byte is at least one token, plus the output bound. */
  private bound(user: string) {
    return Buffer.byteLength(COCREATION_TIDY_PROMPT, 'utf8') + Buffer.byteLength(user, 'utf8') + TIDY_OUTPUT_TOKENS;
  }
  /** What a 整理 would hold, or why not (the button's hover). */
  estimate(input: TidyInput) {
    if (!this.installed()) return { ok: false as const, reason: 'UNAVAILABLE' };
    const price = this.price();
    if (!price) return { ok: false as const, reason: 'PRICE_MISSING' };
    return { ok: true as const, estimateMicros: this.bound(tidyUserMessage(input)) * price.upper_micros_per_unit };
  }
  private row(requestId: string) {
    return this.store.get<Row>('SELECT * FROM web_cocreation_tidy_calls WHERE request_id=?', requestId);
  }
  /** Tidy one submission's text. A replay of the same request id never sends again. */
  async tidy(
    authorize: () => Actor,
    input: { submissionId: string; requestId: string; content: TidyInput },
  ): Promise<TidyResult> {
    const actor = authorize();
    const user = tidyUserMessage(input.content);
    const requestHash = contentHash([actor.memberId, input.submissionId, user]);
    const prior = this.row(input.requestId);
    if (prior) return this.replay(prior, requestHash);
    const price = this.price();
    if (!price) throw new DomainError('WEB_PROVIDER_PRICE_REQUIRED');
    const max = this.bound(user),
      held = max * price.upper_micros_per_unit;
    ensure(natural(held) && held > 0, 'COCREATION_TIDY_INVALID');
    const instance = this.store.get<{ instance_id: string }>('SELECT instance_id FROM web_instance WHERE singleton=1');
    ensure(instance, 'WEB_LOCAL_INSTANCE_MISMATCH');
    const id = this.nextId(),
      budgetId = JSON.stringify([instance.instance_id, 'cocreation-tidy', id]),
      fingerprint = budgetHash([
        actor.memberId,
        input.submissionId,
        input.requestId,
        requestHash,
        this.model.model,
        price.id,
        max,
        held,
      ]);
    ensure(this.inFlight.size < 2, 'COCREATION_TIDY_BUSY');
    // 1. The local hold and the intent row are one transaction.
    this.store.transaction(() => {
      const current = authorize();
      ensure(this.row(input.requestId) === undefined, 'COCREATION_TIDY_INVALID');
      ensure(
        this.store.run(
          `UPDATE web_provider_spending SET held_micros=held_micros+?
          WHERE provider='deepseek' AND (limit_micros IS NULL OR held_micros+spent_micros+?<=limit_micros)
          AND held_micros<=9007199254740991-spent_micros-?`,
          held,
          held,
          held,
        ).changes === 1,
        'WEB_PROVIDER_BUDGET_EXHAUSTED',
      );
      this.store.run(
        `INSERT INTO web_cocreation_tidy_calls(id,request_id,request_hash,submission_id,model,price_id,max_units,held_micros,
        budget_id,fingerprint,state,member_id,session_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,'intent',?,?,?)`,
        id,
        input.requestId,
        requestHash,
        input.submissionId,
        this.model.model,
        price.id,
        max,
        held,
        budgetId,
        fingerprint,
        current.memberId,
        current.sessionId,
        this.now(),
      );
    });
    this.inFlight.add(id);
    try {
      // 2. Reserve in the shared budget BEFORE the provider is called.
      try {
        await this.budget.reserve(budgetId, 'deepseek', fingerprint, held);
      } catch (error) {
        if (error instanceof DomainError && error.code === 'WEB_SHARED_BUDGET_EXHAUSTED') {
          this.release(id, held, error.code);
          throw error;
        }
        this.markUnknown(id, causeCode(error));
        throw new DomainError('COCREATION_TIDY_UNKNOWN');
      }
      // 3. The possible-send boundary.
      try {
        this.store.transaction(() => {
          authorize();
          ensure(
            this.store.run("UPDATE web_cocreation_tidy_calls SET state='sent' WHERE id=? AND state='intent'", id)
              .changes === 1,
            'COCREATION_TIDY_INVALID',
          );
        });
      } catch (error) {
        this.markUnknown(id, causeCode(error));
        throw error;
      }
      // 4. The call. Any failure from here on is UNKNOWN: kept, never retried.
      let result: Awaited<ReturnType<ClipDirectionModel['completePlain']>>;
      try {
        result = await this.model.completePlain(
          { system: COCREATION_TIDY_PROMPT, user, maxTokens: TIDY_OUTPUT_TOKENS },
          new AbortController().signal,
          () => {
            authorize();
            ensure(
              this.store.get("SELECT 1 FROM web_cocreation_tidy_calls WHERE id=? AND state='sent'", id) !== undefined,
              'COCREATION_TIDY_INVALID',
            );
          },
        );
      } catch (error) {
        this.markUnknown(id, causeCode(error));
        throw new DomainError('COCREATION_TIDY_UNKNOWN');
      }
      if (result.model !== this.model.model) {
        this.markUnknown(id, 'WEB_PROVIDER_WIRE_MISMATCH');
        throw new DomainError('COCREATION_TIDY_UNKNOWN');
      }
      const units = result.inputTokens + result.outputTokens;
      if (!natural(units) || units > max) {
        this.markUnknown(id, 'WEB_PROVIDER_USAGE_MISMATCH');
        throw new DomainError('COCREATION_TIDY_UNKNOWN');
      }
      // 5. The bill is known: recorded once, whatever the text turns out to be.
      const parsed = parseTidy(result.text);
      const code = parsed ? null : 'COCREATION_TIDY_INVALID';
      this.confirm(id, code, units, result.receipt, parsed ? JSON.stringify(parsed) : null);
      await this.settleShared(id).catch(() => undefined);
      if (code || !parsed) throw new DomainError('COCREATION_TIDY_INVALID');
      return parsed;
    } finally {
      this.inFlight.delete(id);
    }
  }
  private replay(prior: Row, requestHash: string): TidyResult {
    ensure(prior.request_hash === requestHash, 'IDEMPOTENCY_CONFLICT');
    if (prior.state === 'known') {
      if (prior.shared_settled === 0) void this.settleShared(prior.id).catch(() => undefined);
      ensure(prior.outcome === 'succeeded' && prior.result_json, prior.error_code ?? 'COCREATION_TIDY_INVALID');
      return JSON.parse(prior.result_json) as TidyResult;
    }
    if (prior.state === 'released') throw new DomainError(prior.error_code ?? 'WEB_SHARED_BUDGET_EXHAUSTED');
    if (this.inFlight.has(prior.id)) throw new DomainError('COCREATION_TIDY_BUSY');
    this.markUnknown(prior.id, 'COCREATION_TIDY_RESTARTED');
    throw new DomainError('COCREATION_TIDY_UNKNOWN');
  }
  private markUnknown(id: string, code: string) {
    if (
      this.store.run(
        "UPDATE web_cocreation_tidy_calls SET state='unknown',error_code=? WHERE id=? AND state IN ('intent','sent')",
        code,
        id,
      ).changes === 1
    )
      console.log(JSON.stringify({ event: 'cocreation_tidy_unknown', code }));
  }
  private release(id: string, held: number, code: string) {
    this.store.transaction(() => {
      if (
        this.store.run(
          "UPDATE web_cocreation_tidy_calls SET state='released',error_code=? WHERE id=? AND state='intent'",
          code,
          id,
        ).changes === 1
      )
        ensure(
          this.store.run(
            "UPDATE web_provider_spending SET held_micros=held_micros-? WHERE provider='deepseek' AND held_micros>=?",
            held,
            held,
          ).changes === 1,
          'WEB_PROVIDER_BUDGET_CONFLICT',
        );
    });
  }
  private confirm(id: string, errorCode: string | null, units: number, receipt: unknown, resultJson: string | null) {
    this.store.transaction(() => {
      const row = this.store.get<Row & { price_id: string }>('SELECT * FROM web_cocreation_tidy_calls WHERE id=?', id);
      ensure(row && (row.state === 'sent' || row.state === 'unknown'), 'COCREATION_TIDY_BILL_UNCONFIRMED');
      const price = this.store.get<{ upper_micros_per_unit: number }>(
        'SELECT upper_micros_per_unit FROM web_provider_prices WHERE id=?',
        row.price_id,
      )!;
      const charged = units * price.upper_micros_per_unit;
      ensure(natural(charged) && charged <= row.held_micros, 'COCREATION_TIDY_BILL_UNCONFIRMED');
      this.store.run(
        `UPDATE web_cocreation_tidy_calls SET state='known',outcome=?,error_code=?,charged_micros=?,receipt_json=?,result_json=?,settled_at=?
        WHERE id=?`,
        errorCode ? 'failed' : 'succeeded',
        errorCode,
        charged,
        JSON.stringify(receipt),
        resultJson,
        this.now(),
        id,
      );
      ensure(
        this.store.run(
          `UPDATE web_provider_spending SET held_micros=held_micros-?,spent_micros=spent_micros+?
          WHERE provider='deepseek' AND held_micros>=?`,
          row.held_micros,
          charged,
          row.held_micros,
        ).changes === 1,
        'WEB_PROVIDER_BUDGET_CONFLICT',
      );
    });
  }
  private async settleShared(id: string) {
    if (this.settling.has(id)) return;
    this.settling.add(id);
    try {
      const row = this.store.get<Row>('SELECT * FROM web_cocreation_tidy_calls WHERE id=?', id);
      if (!row || row.shared_settled === 1) return;
      ensure(
        row.state === 'known' && row.charged_micros !== null && row.receipt_json !== null,
        'COCREATION_TIDY_BILL_UNCONFIRMED',
      );
      await this.budget.settle(row.budget_id, row.fingerprint, row.charged_micros, JSON.parse(row.receipt_json));
      this.store.run("UPDATE web_cocreation_tidy_calls SET shared_settled=1 WHERE id=? AND state='known'", id);
    } finally {
      this.settling.delete(id);
    }
  }
  /** A call still in flight or a known bill not yet settled: the owner's timer keeps coming back for it. */
  /** The ledger exists (a database that predates Part 39's step has none: nothing to recover, nothing pending). */
  private installed() {
    return !!this.store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_cocreation_tidy_calls'");
  }
  pending() {
    if (!this.installed()) return false;
    return !!this.store.get(
      `SELECT 1 FROM web_cocreation_tidy_calls WHERE (state='known' AND shared_settled=0) OR state IN ('intent','sent') LIMIT 1`,
    );
  }
  /** After a restart: a call that may have been sent becomes unknown (never resent, hold kept); a known bill is settled. */
  async recoverBills() {
    if (!this.installed()) return 0;
    let n = 0;
    for (const row of this.store.all<{ id: string }>(
      "SELECT id FROM web_cocreation_tidy_calls WHERE state IN ('intent','sent') LIMIT 16",
    ))
      if (!this.inFlight.has(row.id)) {
        this.markUnknown(row.id, 'COCREATION_TIDY_RESTARTED');
        n++;
      }
    for (const row of this.store.all<{ id: string }>(
      "SELECT id FROM web_cocreation_tidy_calls WHERE state='known' AND shared_settled=0 LIMIT 16",
    )) {
      await this.settleShared(row.id);
      n++;
    }
    return n;
  }
}

function causeCode(error: unknown) {
  const code = (error as { code?: unknown } | null)?.code ?? (error instanceof Error ? error.message : '');
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(code) ? code : 'COCREATION_TIDY_PROVIDER_FAILED';
}

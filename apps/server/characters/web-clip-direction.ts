import { createHash, randomUUID } from 'node:crypto';
import type { Clock } from '../../../packages/contracts/index.ts';
import { DomainError, ensure } from '../../../packages/domain/errors.ts';
import { stripDirectionMarkup } from '../../../workers/audio/fish.ts';
import { budgetHash } from '../budget/web-provider-budget-contract.ts';
import { PROMPTS_CLIP } from '../generation/clip-prompts.generated.ts';
import type { BusinessStore } from '../platform/store-contract.ts';
import { contentHash } from './admin-content-hash.ts';
import { webCharacterDeleted } from './web-character-deleted.ts';
import { identifier } from './template-validation.ts';

/**
 * Part 30 section 3: 按反馈重录, the text half. The draft text model rewrites ONE line with direction markup placed inside the
 * sentence, following the person's feedback. Money exactly as for every other call: the price must be in force, the local hold and
 * the shared-budget reservation are made BEFORE the provider is called, an UNKNOWN call is never sent again and keeps its hold,
 * a known bill is settled once. The hard rule is checked after the bill is recorded: removing the markup must give back the
 * line's exact text, else the answer is refused (CLIP_MARKUP_MISMATCH) and nothing is stored but the ledger row.
 */
export const CLIP_DIRECTION_PROMPT = PROMPTS_CLIP.clipDirectionTask;
/** sha256 of prompts/v7/clip-direction-task.md (the file, with its newline). Pinned in tests/web/unit/web-clip-takes-30.test.ts. */
export const CLIP_DIRECTION_PROMPT_SHA256 = 'c8b0ce6a1107d754adac4b15054666fbab8f4ad44a3d6fdc4f77cb94403d9a4f';
export const CLIP_FEEDBACK_MAX = 200;
const OUTPUT_TOKENS = 700;

export interface ClipDirectionBudget {
  reserve(id: string, provider: 'deepseek', fingerprint: string, micros: number): void | Promise<void>;
  settle(id: string, fingerprint: string, micros: number, receipt: unknown): void | Promise<void>;
}
export interface ClipDirectionModel {
  readonly model: string;
  completePlain(
    input: { system: string; user: string; maxTokens: number },
    signal: AbortSignal,
  ): Promise<{ text: string; inputTokens: number; outputTokens: number; model: string; receipt: unknown }>;
}
type Actor = { memberId: string; sessionId: string };
interface Row {
  id: string;
  request_hash: string;
  state: 'intent' | 'sent' | 'unknown' | 'known' | 'released';
  outcome: 'succeeded' | 'failed' | null;
  error_code: string | null;
  markup: string | null;
  held_micros: number;
  budget_id: string;
  fingerprint: string;
  charged_micros: number | null;
  receipt_json: string | null;
  shared_settled: number;
}
const natural = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0;

/** The exact text of one model-facing request, so the estimate and the call agree. */
const userMessage = (text: string, feedback: string) => JSON.stringify({ line: text, feedback });

export class WebClipDirection {
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
  private bound(text: string, feedback: string) {
    const bytes = Buffer.byteLength(CLIP_DIRECTION_PROMPT, 'utf8') + Buffer.byteLength(userMessage(text, feedback), 'utf8');
    return bytes + OUTPUT_TOKENS;
  }
  private valid(text: string, feedback: unknown): asserts feedback is string {
    ensure(
      typeof feedback === 'string' &&
        feedback.trim().length > 0 &&
        [...feedback].length <= CLIP_FEEDBACK_MAX &&
        typeof text === 'string' &&
        text.length > 0,
      'CLIP_FEEDBACK_INVALID',
    );
  }
  /** What the rewrite would hold, or why not. */
  estimate(text: string, feedback: unknown) {
    try {
      this.valid(text, feedback);
    } catch {
      return { ok: false as const, reason: 'FEEDBACK_INVALID' };
    }
    const price = this.price();
    if (!price) return { ok: false as const, reason: 'PRICE_MISSING' };
    return { ok: true as const, estimateMicros: this.bound(text, feedback) * price.upper_micros_per_unit };
  }
  private row(requestId: string) {
    return this.store.get<Row>('SELECT * FROM web_clip_direction_calls WHERE request_id=?', requestId);
  }
  /** Rewrite `text` with markup per `feedback`. Idempotent per requestId: a replay never sends again. */
  async direct(
    authorize: () => Actor,
    input: { characterId: string; slotKey: string; requestId: string; text: string; feedback: unknown },
  ): Promise<{ markup: string }> {
    const actor = authorize();
    identifier(input.requestId);
    this.valid(input.text, input.feedback);
    const feedback = input.feedback;
    ensure(!webCharacterDeleted(this.store, input.characterId), 'CHARACTER_DELETED');
    const requestHash = contentHash([actor.memberId, input.characterId, input.slotKey, input.text, feedback]);
    const prior = this.row(input.requestId);
    if (prior) return this.replay(prior, requestHash, input.text);
    const price = this.price();
    if (!price) throw new DomainError('WEB_PROVIDER_PRICE_REQUIRED');
    const max = this.bound(input.text, feedback),
      held = max * price.upper_micros_per_unit;
    ensure(natural(held) && held > 0, 'CLIP_FEEDBACK_INVALID');
    const instance = this.store.get<{ instance_id: string }>('SELECT instance_id FROM web_instance WHERE singleton=1');
    ensure(instance, 'WEB_LOCAL_INSTANCE_MISMATCH');
    const id = this.nextId(),
      budgetId = JSON.stringify([instance.instance_id, 'clip-direction', id]),
      fingerprint = budgetHash([actor.memberId, input.characterId, input.requestId, requestHash, this.model.model, price.id, max, held]);
    ensure(this.inFlight.size < 2, 'SPEECH_BUSY');
    // 1. The local hold and the intent row are one transaction.
    this.store.transaction(() => {
      const current = authorize();
      ensure(this.row(input.requestId) === undefined, 'SPEECH_REQUEST_INVALID');
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
        `INSERT INTO web_clip_direction_calls(id,request_id,request_hash,character_id,slot_key,model,price_id,max_units,held_micros,
        budget_id,fingerprint,state,member_id,session_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,'intent',?,?,?)`,
        id,
        input.requestId,
        requestHash,
        input.characterId,
        input.slotKey,
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
        throw new DomainError('CLIP_DIRECTION_UNKNOWN');
      }
      // 3. The possible-send boundary.
      try {
        this.store.transaction(() => {
          authorize();
          ensure(
            this.store.run("UPDATE web_clip_direction_calls SET state='sent' WHERE id=? AND state='intent'", id).changes === 1,
            'SPEECH_REQUEST_INVALID',
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
          { system: CLIP_DIRECTION_PROMPT, user: userMessage(input.text, feedback), maxTokens: OUTPUT_TOKENS },
          new AbortController().signal,
        );
      } catch (error) {
        this.markUnknown(id, causeCode(error));
        throw new DomainError('CLIP_DIRECTION_UNKNOWN');
      }
      const units = result.inputTokens + result.outputTokens;
      if (!natural(units) || units > max) {
        this.markUnknown(id, 'WEB_PROVIDER_USAGE_MISMATCH');
        throw new DomainError('CLIP_DIRECTION_UNKNOWN');
      }
      // 5. The bill is known: recorded once, whatever the text turns out to be.
      const markup = result.text.trim();
      const code = stripDirectionMarkup(markup) === input.text && [...markup].length <= 900 ? null : 'CLIP_MARKUP_MISMATCH';
      this.confirm(id, code, units, result.receipt, code ? null : markup);
      await this.settleShared(id).catch(() => undefined);
      if (code) throw new DomainError(code);
      return { markup };
    } finally {
      this.inFlight.delete(id);
    }
  }
  private replay(prior: Row, requestHash: string, text: string): { markup: string } {
    ensure(prior.request_hash === requestHash, 'IDEMPOTENCY_CONFLICT');
    if (prior.state === 'known') {
      if (prior.shared_settled === 0) void this.settleShared(prior.id).catch(() => undefined);
      ensure(prior.outcome === 'succeeded' && prior.markup, prior.error_code ?? 'CLIP_MARKUP_MISMATCH');
      ensure(stripDirectionMarkup(prior.markup) === text, 'CLIP_MARKUP_MISMATCH');
      return { markup: prior.markup };
    }
    if (prior.state === 'released') throw new DomainError(prior.error_code ?? 'WEB_SHARED_BUDGET_EXHAUSTED');
    if (this.inFlight.has(prior.id)) throw new DomainError('SPEECH_IN_PROGRESS');
    this.markUnknown(prior.id, 'SPEECH_RESTARTED');
    throw new DomainError('CLIP_DIRECTION_UNKNOWN');
  }
  private markUnknown(id: string, code: string) {
    if (
      this.store.run(
        "UPDATE web_clip_direction_calls SET state='unknown',error_code=? WHERE id=? AND state IN ('intent','sent')",
        code,
        id,
      ).changes === 1
    )
      console.log(JSON.stringify({ event: 'clip_direction_unknown', code }));
  }
  private release(id: string, held: number, code: string) {
    this.store.transaction(() => {
      if (
        this.store.run(
          "UPDATE web_clip_direction_calls SET state='released',error_code=? WHERE id=? AND state='intent'",
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
  private confirm(id: string, errorCode: string | null, units: number, receipt: unknown, markup: string | null) {
    this.store.transaction(() => {
      const row = this.store.get<Row & { price_id: string }>('SELECT * FROM web_clip_direction_calls WHERE id=?', id);
      ensure(row && (row.state === 'sent' || row.state === 'unknown'), 'SPEECH_BILL_UNCONFIRMED');
      const price = this.store.get<{ upper_micros_per_unit: number }>(
        'SELECT upper_micros_per_unit FROM web_provider_prices WHERE id=?',
        row.price_id,
      )!;
      const charged = units * price.upper_micros_per_unit;
      ensure(natural(charged) && charged <= row.held_micros, 'SPEECH_BILL_UNCONFIRMED');
      this.store.run(
        `UPDATE web_clip_direction_calls SET state='known',outcome=?,error_code=?,charged_micros=?,receipt_json=?,markup=?,settled_at=?
        WHERE id=?`,
        errorCode ? 'failed' : 'succeeded',
        errorCode,
        charged,
        JSON.stringify(receipt),
        markup,
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
      const row = this.store.get<Row>('SELECT * FROM web_clip_direction_calls WHERE id=?', id);
      if (!row || row.shared_settled === 1) return;
      ensure(row.state === 'known' && row.charged_micros !== null && row.receipt_json !== null, 'SPEECH_BILL_UNCONFIRMED');
      await this.budget.settle(row.budget_id, row.fingerprint, row.charged_micros, JSON.parse(row.receipt_json));
      this.store.run("UPDATE web_clip_direction_calls SET shared_settled=1 WHERE id=? AND state='known'", id);
    } finally {
      this.settling.delete(id);
    }
  }
  /** After a restart (driven by the admin speech recovery): a call that may have been sent becomes unknown, a known bill is settled. */
  async recoverBills() {
    let n = 0;
    for (const row of this.store.all<{ id: string }>(
      "SELECT id FROM web_clip_direction_calls WHERE state IN ('intent','sent') LIMIT 16",
    ))
      if (!this.inFlight.has(row.id)) {
        this.markUnknown(row.id, 'SPEECH_RESTARTED');
        n++;
      }
    for (const row of this.store.all<{ id: string }>(
      "SELECT id FROM web_clip_direction_calls WHERE state='known' AND shared_settled=0 LIMIT 16",
    )) {
      await this.settleShared(row.id);
      n++;
    }
    return n;
  }
  pending() {
    return !!this.store.get(
      `SELECT 1 FROM web_clip_direction_calls WHERE (state='known' AND shared_settled=0) OR state IN ('intent','sent') LIMIT 1`,
    );
  }
  /** The latest unresolved call of a slot (UNKNOWN or refused), for the slot to show 「未确认 · CODE」. */
  issues(characterId: string) {
    return this.store.all<{ slot_key: string; state: string; error_code: string | null; created_at: number }>(
      `SELECT slot_key,state,error_code,created_at FROM web_clip_direction_calls
      WHERE character_id=? AND (state IN ('unknown','released') OR (state='known' AND outcome='failed')) ORDER BY created_at DESC,id`,
      characterId,
    );
  }
}

function causeCode(error: unknown) {
  const code = (error as { code?: unknown } | null)?.code ?? (error instanceof Error ? error.message : '');
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(code) ? code : 'SPEECH_PROVIDER_FAILED';
}

/** The hash a request is bound to (for tests that pin the prompt bytes). */
export const clipPromptHash = () => createHash('sha256').update(`${CLIP_DIRECTION_PROMPT}\n`).digest('hex');

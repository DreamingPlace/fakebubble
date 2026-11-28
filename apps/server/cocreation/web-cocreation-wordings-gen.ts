import { randomUUID } from 'node:crypto';
import type { Clock } from '../../../packages/contracts/index.ts';
import {
  COCREATION_THEMES,
  COCREATION_WORDING_LIMITS,
  cocreationWordingOk,
  type CocreationThemeId,
} from '../../../packages/contracts/cocreation-wordings.ts';
import { DomainError, ensure } from '../../../packages/domain/errors.ts';
import { budgetHash } from '../budget/web-provider-budget-contract.ts';
import { contentHash } from '../characters/admin-content-hash.ts';
import type { ClipDirectionBudget, ClipDirectionModel } from '../characters/web-clip-direction.ts';
import type { BusinessStore } from '../platform/store-contract.ts';
import { COCREATION_WORDINGS_PROMPT } from './web-cocreation-wordings-prompt.ts';

/**
 * Part 39b: 生成, the optional text half of 「题目」. ONE budgeted call on the draft text model per character that drafts 6-10 wordings per
 * theme. The drafts land in that character's pool SWITCHED OFF: nothing reaches a player until an administrator edits and switches it on.
 * Money exactly as for 整理 and every other provider call: the price must be in force, the local hold and the shared-budget reservation are
 * made BEFORE the provider is called; an UNKNOWN call is never sent again and its hold is never released; a known bill is settled once.
 * Idempotent per request id. The confirmed estimate must cover the hold (COCREATION_WORDINGS_ESTIMATE_STALE otherwise).
 */
export const WORDINGS_OUTPUT_TOKENS = 2400;
export const WORDINGS_USER_MAX = 3800;
export type WordingsInput = { name: string; personality: string; existing: string[] };
export type WordingDrafts = Record<CocreationThemeId, string[]>;
type Actor = { memberId: string; sessionId: string };
interface Row {
  id: string;
  request_hash: string;
  character_id: string;
  state: 'intent' | 'sent' | 'unknown' | 'known' | 'released';
  outcome: 'succeeded' | 'failed' | null;
  error_code: string | null;
  added: number | null;
  held_micros: number;
  budget_id: string;
  fingerprint: string;
  charged_micros: number | null;
  receipt_json: string | null;
  shared_settled: number;
}
const natural = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0;
const clip = (value: string, max: number) => [...value].slice(0, max).join('');

/** The exact model-facing user message; the existing wordings are trimmed (deterministically) so it never exceeds WORDINGS_USER_MAX. */
export function wordingsUserMessage(input: WordingsInput): string {
  let existing = input.existing.slice(0, 30).map((line) => clip(line, 40));
  const build = () =>
    JSON.stringify({
      name: clip(input.name, 20),
      personality: clip(input.personality, 300),
      themes: COCREATION_THEMES.map(({ id, label }) => ({ id, label })),
      existing,
    });
  let message = build();
  while (message.length > WORDINGS_USER_MAX && existing.length > 0) {
    existing = existing.slice(0, -1);
    message = build();
  }
  return message;
}

/** The reply must be exactly {"wordings":{<each theme id>:[...]}}; wordings that do not pass are dropped, a theme left with fewer than six refuses the whole answer. */
export function parseWordings(text: string): WordingDrafts | null {
  try {
    const value = JSON.parse(text.trim()) as unknown;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const top = value as Record<string, unknown>;
    if (Object.keys(top).join(',') !== 'wordings') return null;
    const wordings = top.wordings;
    if (wordings === null || typeof wordings !== 'object' || Array.isArray(wordings)) return null;
    const record = wordings as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(',') !==
      COCREATION_THEMES.map((t) => t.id)
        .sort()
        .join(',')
    )
      return null;
    const out = {} as WordingDrafts;
    for (const theme of COCREATION_THEMES) {
      const list = record[theme.id];
      if (!Array.isArray(list)) return null;
      const seen = new Set<string>();
      const kept: string[] = [];
      for (const item of list) {
        if (typeof item !== 'string') continue;
        const wording = item.trim();
        if (!cocreationWordingOk(wording) || seen.has(wording)) continue;
        seen.add(wording);
        kept.push(wording);
      }
      if (kept.length < COCREATION_WORDING_LIMITS.generatedMin) return null;
      out[theme.id] = kept.slice(0, COCREATION_WORDING_LIMITS.generatedMax);
    }
    return out;
  } catch {
    return null;
  }
}

export class WebCocreationWordingGen {
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
    return (
      Buffer.byteLength(COCREATION_WORDINGS_PROMPT, 'utf8') + Buffer.byteLength(user, 'utf8') + WORDINGS_OUTPUT_TOKENS
    );
  }
  /** What a 生成 for this character would hold, or why not. */
  estimate(input: WordingsInput) {
    if (!this.installed()) return { ok: false as const, reason: 'UNAVAILABLE' };
    const price = this.price();
    if (!price) return { ok: false as const, reason: 'PRICE_MISSING' };
    return { ok: true as const, estimateMicros: this.bound(wordingsUserMessage(input)) * price.upper_micros_per_unit };
  }
  private row(requestId: string) {
    return this.store.get<Row>('SELECT * FROM web_cocreation_wording_calls WHERE request_id=?', requestId);
  }
  /**
   * Draft the wordings of one character. `land` writes the drafts into the pool (switched off) in the SAME transaction that records the
   * known bill, and returns how many it added. A replay of the same request id never sends again.
   */
  async generate(
    authorize: () => Actor,
    input: {
      characterId: string;
      requestId: string;
      acknowledgeMicros: number;
      content: WordingsInput;
      land: (drafts: WordingDrafts) => number;
    },
  ): Promise<{ added: number }> {
    const actor = authorize();
    const user = wordingsUserMessage(input.content);
    // The request is who asked for which character: the pool the message was built from moves on (the drafts land in it), so it is not hashed.
    const requestHash = contentHash([actor.memberId, input.characterId]);
    const prior = this.row(input.requestId);
    if (prior) return this.replay(prior, requestHash);
    const price = this.price();
    if (!price) throw new DomainError('WEB_PROVIDER_PRICE_REQUIRED');
    const max = this.bound(user),
      held = max * price.upper_micros_per_unit;
    ensure(natural(held) && held > 0, 'COCREATION_WORDINGS_INVALID');
    // The confirmed estimate is what the administrator saw: a price that moved since then is asked about again.
    ensure(natural(input.acknowledgeMicros) && input.acknowledgeMicros >= held, 'COCREATION_WORDINGS_ESTIMATE_STALE');
    const instance = this.store.get<{ instance_id: string }>('SELECT instance_id FROM web_instance WHERE singleton=1');
    ensure(instance, 'WEB_LOCAL_INSTANCE_MISMATCH');
    const id = this.nextId(),
      budgetId = JSON.stringify([instance.instance_id, 'cocreation-wordings', id]),
      fingerprint = budgetHash([
        actor.memberId,
        input.characterId,
        input.requestId,
        requestHash,
        this.model.model,
        price.id,
        max,
        held,
      ]);
    ensure(this.inFlight.size < 2, 'COCREATION_WORDINGS_BUSY');
    // 1. The local hold and the intent row are one transaction.
    this.store.transaction(() => {
      const current = authorize();
      ensure(this.row(input.requestId) === undefined, 'COCREATION_WORDINGS_INVALID');
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
        `INSERT INTO web_cocreation_wording_calls(id,request_id,request_hash,character_id,model,price_id,max_units,held_micros,
        budget_id,fingerprint,state,member_id,session_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,'intent',?,?,?)`,
        id,
        input.requestId,
        requestHash,
        input.characterId,
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
        throw new DomainError('COCREATION_WORDINGS_UNKNOWN');
      }
      // 3. The possible-send boundary.
      try {
        this.store.transaction(() => {
          authorize();
          ensure(
            this.store.run("UPDATE web_cocreation_wording_calls SET state='sent' WHERE id=? AND state='intent'", id)
              .changes === 1,
            'COCREATION_WORDINGS_INVALID',
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
          { system: COCREATION_WORDINGS_PROMPT, user, maxTokens: WORDINGS_OUTPUT_TOKENS },
          new AbortController().signal,
          () => {
            authorize();
            ensure(
              this.store.get("SELECT 1 FROM web_cocreation_wording_calls WHERE id=? AND state='sent'", id) !==
                undefined,
              'COCREATION_WORDINGS_INVALID',
            );
          },
        );
      } catch (error) {
        this.markUnknown(id, causeCode(error));
        throw new DomainError('COCREATION_WORDINGS_UNKNOWN');
      }
      if (result.model !== this.model.model) {
        this.markUnknown(id, 'WEB_PROVIDER_WIRE_MISMATCH');
        throw new DomainError('COCREATION_WORDINGS_UNKNOWN');
      }
      const units = result.inputTokens + result.outputTokens;
      if (!natural(units) || units > max) {
        this.markUnknown(id, 'WEB_PROVIDER_USAGE_MISMATCH');
        throw new DomainError('COCREATION_WORDINGS_UNKNOWN');
      }
      // 5. The bill is known: recorded once, whatever the text turns out to be; the drafts land in the same transaction.
      const parsed = parseWordings(result.text);
      const code = parsed ? null : 'COCREATION_WORDINGS_INVALID';
      const added = this.confirm(id, code, units, result.receipt, parsed ? () => input.land(parsed) : null);
      await this.settleShared(id).catch(() => undefined);
      if (code) throw new DomainError(code);
      return { added };
    } finally {
      this.inFlight.delete(id);
    }
  }
  private replay(prior: Row, requestHash: string): { added: number } {
    ensure(prior.request_hash === requestHash, 'IDEMPOTENCY_CONFLICT');
    if (prior.state === 'known') {
      if (prior.shared_settled === 0) void this.settleShared(prior.id).catch(() => undefined);
      ensure(prior.outcome === 'succeeded', prior.error_code ?? 'COCREATION_WORDINGS_INVALID');
      return { added: prior.added ?? 0 };
    }
    if (prior.state === 'released') throw new DomainError(prior.error_code ?? 'WEB_SHARED_BUDGET_EXHAUSTED');
    if (this.inFlight.has(prior.id)) throw new DomainError('COCREATION_WORDINGS_BUSY');
    this.markUnknown(prior.id, 'COCREATION_WORDINGS_RESTARTED');
    throw new DomainError('COCREATION_WORDINGS_UNKNOWN');
  }
  private markUnknown(id: string, code: string) {
    if (
      this.store.run(
        "UPDATE web_cocreation_wording_calls SET state='unknown',error_code=? WHERE id=? AND state IN ('intent','sent')",
        code,
        id,
      ).changes === 1
    )
      console.log(JSON.stringify({ event: 'cocreation_wordings_unknown', code }));
  }
  private release(id: string, held: number, code: string) {
    this.store.transaction(() => {
      if (
        this.store.run(
          "UPDATE web_cocreation_wording_calls SET state='released',error_code=? WHERE id=? AND state='intent'",
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
  private confirm(id: string, errorCode: string | null, units: number, receipt: unknown, land: (() => number) | null) {
    return this.store.transaction(() => {
      const row = this.store.get<Row & { price_id: string }>(
        'SELECT * FROM web_cocreation_wording_calls WHERE id=?',
        id,
      );
      ensure(row && (row.state === 'sent' || row.state === 'unknown'), 'COCREATION_WORDINGS_BILL_UNCONFIRMED');
      const price = this.store.get<{ upper_micros_per_unit: number }>(
        'SELECT upper_micros_per_unit FROM web_provider_prices WHERE id=?',
        row.price_id,
      )!;
      const charged = units * price.upper_micros_per_unit;
      ensure(natural(charged) && charged <= row.held_micros, 'COCREATION_WORDINGS_BILL_UNCONFIRMED');
      const added = land ? land() : 0;
      this.store.run(
        `UPDATE web_cocreation_wording_calls SET state='known',outcome=?,error_code=?,added=?,charged_micros=?,receipt_json=?,settled_at=?
        WHERE id=?`,
        errorCode ? 'failed' : 'succeeded',
        errorCode,
        added,
        charged,
        JSON.stringify(receipt),
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
      return added;
    });
  }
  private async settleShared(id: string) {
    if (this.settling.has(id)) return;
    this.settling.add(id);
    try {
      const row = this.store.get<Row>('SELECT * FROM web_cocreation_wording_calls WHERE id=?', id);
      if (!row || row.shared_settled === 1) return;
      ensure(
        row.state === 'known' && row.charged_micros !== null && row.receipt_json !== null,
        'COCREATION_WORDINGS_BILL_UNCONFIRMED',
      );
      await this.budget.settle(row.budget_id, row.fingerprint, row.charged_micros, JSON.parse(row.receipt_json));
      this.store.run("UPDATE web_cocreation_wording_calls SET shared_settled=1 WHERE id=? AND state='known'", id);
    } finally {
      this.settling.delete(id);
    }
  }
  private installed() {
    return !!this.store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_cocreation_wording_calls'");
  }
  pending() {
    if (!this.installed()) return false;
    return !!this.store.get(
      `SELECT 1 FROM web_cocreation_wording_calls WHERE (state='known' AND shared_settled=0) OR state IN ('intent','sent') LIMIT 1`,
    );
  }
  /** After a restart: a call that may have been sent becomes unknown (never resent, hold kept); a known bill is settled. */
  async recoverBills() {
    if (!this.installed()) return 0;
    let n = 0;
    for (const row of this.store.all<{ id: string }>(
      "SELECT id FROM web_cocreation_wording_calls WHERE state IN ('intent','sent') LIMIT 16",
    ))
      if (!this.inFlight.has(row.id)) {
        this.markUnknown(row.id, 'COCREATION_WORDINGS_RESTARTED');
        n++;
      }
    for (const row of this.store.all<{ id: string }>(
      "SELECT id FROM web_cocreation_wording_calls WHERE state='known' AND shared_settled=0 LIMIT 16",
    )) {
      await this.settleShared(row.id);
      n++;
    }
    return n;
  }
}

function causeCode(error: unknown) {
  const code = (error as { code?: unknown } | null)?.code ?? (error instanceof Error ? error.message : '');
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(code) ? code : 'COCREATION_WORDINGS_PROVIDER_FAILED';
}

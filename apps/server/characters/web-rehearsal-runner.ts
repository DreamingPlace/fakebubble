import { randomUUID } from 'node:crypto';
import type { AcceptedV7StageOutput, Clock, TextGenerationRequest } from '../../../packages/contracts/index.ts';
import type {
  ProviderCallSpec,
  ProviderMeter,
  ProviderObservation,
} from '../../../packages/contracts/provider-calls.ts';
import type { TextRoute } from '../../../packages/contracts/text-route.ts';
import { isPlayerModelId, type PlayerModelId } from '../../../packages/contracts/player-models.ts';
import { DomainError, ensure } from '../../../packages/domain/errors.ts';
import { webConcurrency } from '../../../config/web-concurrency.ts';
import type { BusinessStore } from '../platform/store-contract.ts';
import type { DeepSeekTextGenerator } from '../generation/deepseek.ts';
import { applyTextReview, DROP_INVALID_METADATA, parseTextDraft } from '../generation/accepted-text-protocol.ts';
import { draftModelRef } from '../generation/web-text-routing.ts';
import { budgetHash } from '../budget/web-provider-budget-contract.ts';
import { previewDigest, requirePreviewActor } from './web-character-preview.ts';
import { webCharacterDeleted } from './web-character-deleted.ts';
import { webCharacterPreviewsRunning } from './web-character-preview-schema.ts';
import { rehearsalInstalled } from './web-rehearsal-schema.ts';
import { rehearsalRequest, type RehearsalFrozen } from './web-rehearsal-request.ts';
import { forbiddenWords } from './web-rehearsal-sets.ts';
import {
  parseHints,
  parseVerdict,
  REHEARSAL_HINT_PROMPT,
  REHEARSAL_HINT_PROMPT_SHA256,
  REHEARSAL_JUDGE_OUTPUT_TOKENS,
  REHEARSAL_VERDICT_PROMPT,
  REHEARSAL_VERDICT_PROMPT_SHA256,
} from './web-rehearsal-prompts.ts';
import type { WebPreviewBudget } from './web-character-preview-runner.ts';

/**
 * Part 35: what the judge calls need from a provider: one plain completion on a house reviewer model, with a send gate. The
 * generation Worker is the only caller of a provider; it runs only the pinned judge prompts (web-rehearsal-prompts.ts).
 */
export interface RehearsalJudgeModel {
  completeJson(
    input: { system: string; systemSha256: string; user: string; maxTokens: number; model: string },
    signal: AbortSignal,
    authorize?: () => void | Promise<void>,
  ): Promise<{ text: string; inputTokens: number; outputTokens: number; model: string; receipt: unknown }>;
}
type Generator = Pick<
  DeepSeekTextGenerator,
  'textProtocol' | 'policyHash' | 'generateAcceptedStages' | 'generateAcceptedReviewFromKnownDraft'
>;
type Phase = 'draft' | 'review' | 'judge';
interface Call {
  run_id: string;
  seq: number;
  phase: Phase;
  provider: 'deepseek' | 'xai' | 'gemini';
  budget_id: string;
  fingerprint: string;
  wire_hash: string;
  lease_token: string;
  model: string;
  price_id: string;
  max_units: number;
  held_micros: number;
  state: 'intent' | 'sent' | 'unknown' | 'known';
  outcome: 'succeeded' | 'failed' | null;
  charged_micros: number | null;
  receipt_json: string | null;
  output_json: string | null;
  output_hash: string | null;
  metadata_json: string | null;
  shared_settled: number;
}
interface Unit {
  run_id: string;
  seq: number;
  kind: 'hint' | 'cell' | 'judge';
  model_key: string | null;
  turn: number | null;
  item_key: string | null;
  status: 'queued' | 'generating' | 'done' | 'failed' | 'unconfirmed' | 'skipped';
  lease_token: string | null;
  lease_until: number | null;
  deadline_at: number;
  retry_at: number;
  error_code: string | null;
  request_json: string | null;
  request_digest: string | null;
  result_json: string | null;
}
type UnitContext = Unit & {
  member_id: string;
  session_id: string;
  character_id: string;
  frozen_json: string;
  reviewer: string;
};
export interface RehearsalClaim {
  runId: string;
  seq: number;
  token: string;
}
const natural = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0;
const TERMINAL = ['done', 'failed', 'unconfirmed', 'skipped'];

/**
 * Part 35: runs a 多轮预演 one unit at a time inside the preview queue's single text slot. The guarantees are the preview's:
 * the price must be in force, the local hold and the capacity ticket are taken BEFORE every provider call, an UNKNOWN call is never
 * sent again and keeps both its hold and its ticket (the unit is 未确认 and the other models go on), a known bill is settled once.
 *
 * Replies come from the same two stages as a chat reply (the draft model of the column, then the house reviewer), through the
 * Part 21b route table with ONE model per stage: a column is never silently written by another model.
 */
export class WebRehearsalRunner {
  private readonly store: BusinessStore;
  private readonly clock: Clock;
  private readonly generator: Generator;
  private readonly budget: WebPreviewBudget;
  private readonly nextId: () => string;
  judge: RehearsalJudgeModel | null = null;
  constructor(
    store: BusinessStore,
    clock: Clock,
    generator: Generator,
    budget: WebPreviewBudget,
    nextId: () => string = randomUUID,
  ) {
    this.store = store;
    this.clock = clock;
    this.generator = generator;
    this.budget = budget;
    this.nextId = nextId;
  }
  useJudge(judge: RehearsalJudgeModel) {
    this.judge = judge;
  }
  private get on() {
    return rehearsalInstalled(this.store);
  }
  private now() {
    const now = this.clock.now();
    ensure(natural(now), 'INVALID_TIME');
    return now;
  }
  private calls(runId: string, seq: number) {
    return this.store.all<Call>(
      'SELECT * FROM web_rehearsal_calls WHERE run_id=? AND seq=? ORDER BY phase',
      runId,
      seq,
    );
  }
  private unit(runId: string, seq: number): UnitContext {
    const row = this.store.get<UnitContext>(
      `SELECT u.*,r.member_id,r.session_id,r.character_id,r.frozen_json,r.reviewer FROM web_rehearsal_units u
      JOIN web_rehearsal_runs r ON r.id=u.run_id WHERE u.run_id=? AND u.seq=?`,
      runId,
      seq,
    );
    ensure(row, 'NOT_FOUND');
    return row;
  }
  private finish(
    runId: string,
    seq: number,
    status: 'done' | 'failed' | 'unconfirmed' | 'skipped',
    code: string | null,
    result?: unknown,
  ) {
    this.store.run(
      `UPDATE web_rehearsal_units SET status=?,error_code=?,result_json=coalesce(?,result_json),finished_at=?,lease_until=NULL
      WHERE run_id=? AND seq=? AND status IN ('queued','generating')`,
      status,
      code,
      result === undefined ? null : JSON.stringify(result),
      this.now(),
      runId,
      seq,
    );
  }
  /** The administrator who started the run still holds a live session and may preview the character. */
  private authorized(row: Pick<UnitContext, 'member_id' | 'session_id' | 'character_id'>, now: number) {
    try {
      requirePreviewActor(this.store, now, { memberId: row.member_id, sessionId: row.session_id }, row.character_id);
      return true;
    } catch {
      return false;
    }
  }
  private live(claim: RehearsalClaim) {
    const row = this.unit(claim.runId, claim.seq);
    const now = this.now();
    ensure(
      row.status === 'generating' && row.lease_token === claim.token && row.lease_until! > now,
      'REHEARSAL_LEASE_STALE',
    );
    ensure(row.deadline_at > now, 'REHEARSAL_EXPIRED');
    ensure(this.authorized(row, now), 'ADMIN_PERMISSION_REQUIRED');
    ensure(!webCharacterDeleted(this.store, row.character_id), 'CHARACTER_DELETED');
    return row;
  }
  /** Uncertain reservations and sends keep BOTH the money hold and the capacity ticket; nothing resends them. */
  private uncertain(runId: string, seq: number) {
    this.store.run(
      "UPDATE web_rehearsal_calls SET state='unknown' WHERE run_id=? AND seq=? AND state IN ('intent','sent')",
      runId,
      seq,
    );
  }

  // ---- queue -----------------------------------------------------------------------------------------------------------

  /** A turn the conversation has: its text exists (a dropped item's turns never get one). */
  private playerTurns(runId: string) {
    return this.store.all<{ turn: number; text: string | null; item_key: string | null }>(
      'SELECT turn,text,item_key FROM web_rehearsal_turns WHERE run_id=? ORDER BY turn',
      runId,
    );
  }
  /**
   * Where a unit stands: `run` (ready), `wait` (something it needs is not finished), or `skip` with the reason. A cell needs the
   * hint writers finished and its own model's earlier replies; a judge needs its item's replies.
   */
  private readiness(row: UnitContext): { go: 'run' } | { go: 'wait' } | { go: 'skip'; code: string } {
    if (row.kind === 'hint') return { go: 'run' };
    const hints = this.store.all<{ status: string }>(
      "SELECT status FROM web_rehearsal_units WHERE run_id=? AND kind='hint'",
      row.run_id,
    );
    if (hints.some((h) => !TERMINAL.includes(h.status))) return { go: 'wait' };
    const turns = this.playerTurns(row.run_id);
    if (row.kind === 'cell') {
      const mine = turns.find((t) => t.turn === row.turn);
      if (!mine || mine.text === null) return { go: 'skip', code: 'REHEARSAL_ITEM_DROPPED' };
      for (const earlier of turns.filter((t) => t.turn < row.turn! && t.text !== null)) {
        const unit = this.store.get<Unit>(
          "SELECT * FROM web_rehearsal_units WHERE run_id=? AND kind='cell' AND model_key=? AND turn=?",
          row.run_id,
          row.model_key,
          earlier.turn,
        );
        if (!unit || !TERMINAL.includes(unit.status)) return { go: 'wait' };
        if (unit.status !== 'done') return { go: 'skip', code: 'REHEARSAL_REPLY_MISSING' };
      }
      return { go: 'run' };
    }
    const item = this.store.get<{ state: string }>(
      'SELECT state FROM web_rehearsal_items WHERE run_id=? AND item_key=?',
      row.run_id,
      row.item_key,
    );
    if (!item || item.state === 'dropped') return { go: 'skip', code: 'REHEARSAL_ITEM_DROPPED' };
    for (const turn of turns.filter((t) => t.item_key === row.item_key)) {
      const unit = this.store.get<Unit>(
        "SELECT * FROM web_rehearsal_units WHERE run_id=? AND kind='cell' AND model_key=? AND turn=?",
        row.run_id,
        row.model_key,
        turn.turn,
      );
      if (!unit || !TERMINAL.includes(unit.status)) return { go: 'wait' };
      if (unit.status !== 'done') return { go: 'skip', code: 'REHEARSAL_REPLY_MISSING' };
    }
    return { go: 'run' };
  }

  claim(): RehearsalClaim | null {
    if (!this.on) return null;
    return this.store.transaction(() => {
      const now = this.now();
      for (const u of this.store.all<Unit>(
        `SELECT * FROM web_rehearsal_units WHERE status IN ('queued','generating')
        AND (deadline_at<=? OR status='generating' AND lease_until<=?)`,
        now,
        now,
      )) {
        this.uncertain(u.run_id, u.seq);
        const calls = this.calls(u.run_id, u.seq);
        if (calls.some((c) => c.state !== 'known'))
          this.finish(u.run_id, u.seq, 'unconfirmed', 'REHEARSAL_CALL_UNKNOWN');
        else if (u.deadline_at <= now) this.finish(u.run_id, u.seq, 'failed', 'REHEARSAL_EXPIRED');
        else
          this.store.run(
            "UPDATE web_rehearsal_units SET status='queued',lease_until=NULL WHERE run_id=? AND seq=?",
            u.run_id,
            u.seq,
          );
      }
      if (
        webCharacterPreviewsRunning(this.store) >= 1 ||
        this.store.get<{ n: number }>("SELECT count(*) n FROM web_operations WHERE status='text_running'")!.n >=
          webConcurrency(this.store).maxTextRunning
      )
        return null;
      // Units are taken in seq order; one that waits on another does not hold up the rest, one that cannot be run is closed.
      for (const next of this.store.all<{ run_id: string; seq: number }>(
        `SELECT u.run_id,u.seq FROM web_rehearsal_units u JOIN web_rehearsal_runs r ON r.id=u.run_id
        WHERE u.status='queued' AND u.retry_at<=? ORDER BY r.created_at,u.run_id,u.seq`,
        now,
      )) {
        const row = this.unit(next.run_id, next.seq);
        if (!this.authorized(row, now)) {
          this.finish(row.run_id, row.seq, 'failed', 'ADMIN_PERMISSION_REQUIRED');
          continue;
        }
        if (webCharacterDeleted(this.store, row.character_id)) {
          this.finish(row.run_id, row.seq, 'failed', 'CHARACTER_DELETED');
          continue;
        }
        const ready = this.readiness(row);
        if (ready.go === 'wait') continue;
        if (ready.go === 'skip') {
          this.finish(row.run_id, row.seq, 'skipped', ready.code);
          continue;
        }
        const token = this.nextId();
        this.store.run(
          "UPDATE web_rehearsal_units SET status='generating',lease_until=?,lease_token=? WHERE run_id=? AND seq=?",
          Math.min(now + 150_000, row.deadline_at),
          token,
          row.run_id,
          row.seq,
        );
        return { runId: row.run_id, seq: row.seq, token };
      }
      return null;
    });
  }
  nextDue() {
    if (!this.on) return null;
    const row = this.store.get<{ due: number | null }>(
      `SELECT min(min(deadline_at,CASE status WHEN 'queued' THEN max(retry_at,?) ELSE lease_until END)) due
      FROM web_rehearsal_units WHERE status IN ('queued','generating')`,
      this.now() + 1000,
    );
    const pending = this.store.get(
      "SELECT 1 FROM web_rehearsal_calls WHERE state='known' AND shared_settled=0 LIMIT 1",
    );
    const at = Math.min(row?.due ?? Infinity, pending ? this.now() + 10_000 : Infinity);
    return Number.isFinite(at) ? at : null;
  }

  // ---- money -----------------------------------------------------------------------------------------------------------

  private async settle(row: Call) {
    if (row.shared_settled) return;
    ensure(
      row.state === 'known' && row.charged_micros !== null && row.receipt_json !== null,
      'REHEARSAL_BILL_UNCONFIRMED',
    );
    await this.budget.settle(row.budget_id, row.fingerprint, row.charged_micros, JSON.parse(row.receipt_json));
    this.store.run(
      "UPDATE web_rehearsal_calls SET shared_settled=1 WHERE run_id=? AND seq=? AND phase=? AND state='known'",
      row.run_id,
      row.seq,
      row.phase,
    );
  }
  async recoverBills() {
    if (!this.on) return 0;
    const rows = this.store.all<Call>(
      "SELECT * FROM web_rehearsal_calls WHERE state='known' AND shared_settled=0 LIMIT 16",
    );
    for (const row of rows) await this.settle(row);
    return rows.length;
  }
  /**
   * Budget BEFORE the call: price row, capacity ticket and money hold in one transaction, then the shared reservation. A hold is at
   * most (input bytes + output bound) tokens at the ledger's upper price: every input byte is at least one token.
   */
  private reserve(
    claim: RehearsalClaim,
    phase: Phase,
    ref: { provider: Call['provider']; model: string },
    outputTokens: number,
    wireHash: string,
    bytes: number,
    inputBound: number,
  ) {
    return this.store.transaction(() => {
      const row = this.live(claim),
        now = this.now(),
        priceStage = phase === 'draft' ? 'draft' : 'review';
      ensure(
        /^[a-f0-9]{64}$/.test(wireHash) && natural(bytes) && bytes > 0 && natural(outputTokens),
        'REHEARSAL_STAGE_INVALID',
      );
      ensure(!this.calls(claim.runId, claim.seq).some((c) => c.phase === phase), 'REHEARSAL_ATTEMPT_UNRESOLVED');
      if (phase === 'review')
        ensure(
          this.calls(claim.runId, claim.seq).some(
            (c) => c.phase === 'draft' && c.state === 'known' && c.outcome === 'succeeded' && c.shared_settled === 1,
          ),
          'REHEARSAL_OUTPUT_UNCONFIRMED',
        );
      const price = this.store.get<{ id: string; upper_micros_per_unit: number }>(
        `SELECT * FROM web_provider_prices
        WHERE provider=? AND phase=? AND model=? AND currency='USD' AND unit='token' AND valid_from<=? AND valid_until>?
        ORDER BY version DESC LIMIT 1`,
        ref.provider,
        priceStage,
        ref.model,
        now,
        now,
      );
      ensure(price, 'WEB_PROVIDER_PRICE_REQUIRED');
      const max = Math.min(inputBound, bytes) + outputTokens,
        held = max * price.upper_micros_per_unit;
      ensure(natural(max) && max > 0 && natural(held) && held > 0, 'REHEARSAL_STAGE_INVALID');
      ensure(
        this.store.run(
          `UPDATE web_external_budgets SET reserved=reserved+1
          WHERE provider=? AND stage='text' AND phase=? AND reserved<capacity`,
          ref.provider,
          priceStage,
        ).changes === 1,
        'WEB_DISPATCH_CAPACITY',
      );
      ensure(
        this.store.run(
          `UPDATE web_provider_spending SET held_micros=held_micros+?
          WHERE provider=? AND (limit_micros IS NULL OR held_micros+spent_micros+?<=limit_micros)
          AND held_micros<=9007199254740991-spent_micros-?`,
          held,
          ref.provider,
          held,
          held,
        ).changes === 1,
        'WEB_PROVIDER_BUDGET_EXHAUSTED',
      );
      const instance = this.store.get<{ instance_id: string }>(
        'SELECT instance_id FROM web_instance WHERE singleton=1',
      );
      ensure(instance, 'WEB_LOCAL_INSTANCE_MISMATCH');
      const budgetId = JSON.stringify([instance.instance_id, 'admin-rehearsal', claim.runId, claim.seq, phase]);
      const fingerprint = budgetHash([
        row.member_id,
        row.session_id,
        row.character_id,
        claim.runId,
        claim.seq,
        row.request_digest ?? '',
        wireHash,
        ref.model,
        price.id,
        max,
        held,
      ]);
      this.store.run(
        `INSERT INTO web_rehearsal_calls(run_id,seq,phase,provider,budget_id,fingerprint,wire_hash,lease_token,model,price_id,
        max_units,held_micros,state,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'intent',?)`,
        claim.runId,
        claim.seq,
        phase,
        ref.provider,
        budgetId,
        fingerprint,
        wireHash,
        claim.token,
        ref.model,
        price.id,
        max,
        held,
        now,
      );
      return this.calls(claim.runId, claim.seq).find((c) => c.phase === phase)!;
    });
  }
  /** Crossing the possible-send boundary: shared reservation first, then `sent`. A failure on either side leaves the call unknown. */
  private async dispatch(claim: RehearsalClaim, call: Call, signal: AbortSignal) {
    await this.budget.reserve(call.budget_id, 'deepseek', call.fingerprint, call.held_micros);
    this.store.transaction(() => {
      ensure(!signal.aborted, 'REHEARSAL_INTERRUPTED');
      this.live(claim);
      ensure(
        this.store.run(
          `UPDATE web_rehearsal_calls SET state='sent' WHERE run_id=? AND seq=? AND phase=? AND lease_token=? AND state='intent'`,
          claim.runId,
          claim.seq,
          call.phase,
          claim.token,
        ).changes === 1,
        'REHEARSAL_LEASE_STALE',
      );
    });
  }
  private release(call: Call, charged: number) {
    ensure(
      this.store.run(
        `UPDATE web_provider_spending SET held_micros=held_micros-?,spent_micros=spent_micros+? WHERE provider=? AND held_micros>=?`,
        call.held_micros,
        charged,
        call.provider,
        call.held_micros,
      ).changes === 1,
      'REHEARSAL_BUDGET_CORRUPT',
    );
    ensure(
      this.store.run(
        `UPDATE web_external_budgets SET reserved=reserved-1 WHERE provider=? AND stage='text' AND phase=? AND reserved>0`,
        call.provider,
        call.phase === 'draft' ? 'draft' : 'review',
      ).changes === 1,
      'REHEARSAL_BUDGET_CORRUPT',
    );
  }
  private price(call: Call) {
    return this.store.get<{ upper_micros_per_unit: number }>(
      'SELECT upper_micros_per_unit FROM web_provider_prices WHERE id=?',
      call.price_id,
    )!.upper_micros_per_unit;
  }

  // ---- a reply (draft + review) -----------------------------------------------------------------------------------------

  private frozenOf(row: UnitContext) {
    return JSON.parse(row.frozen_json) as RehearsalFrozen;
  }
  /** The request of a cell, built once from the script and this model's earlier replies and frozen on the unit. */
  private cellRequest(row: UnitContext): TextGenerationRequest {
    if (row.request_json) {
      ensure(previewDigest(row.request_json) === row.request_digest, 'REHEARSAL_REQUEST_CHANGED');
      return JSON.parse(row.request_json) as TextGenerationRequest;
    }
    const turns = this.playerTurns(row.run_id).filter((t) => t.text !== null);
    const index = turns.findIndex((t) => t.turn === row.turn);
    ensure(index >= 0, 'REHEARSAL_REQUEST_INVALID');
    const replies: string[][] = [];
    for (const earlier of turns.slice(0, index)) {
      const unit = this.store.get<{ result_json: string | null; status: string }>(
        "SELECT result_json,status FROM web_rehearsal_units WHERE run_id=? AND kind='cell' AND model_key=? AND turn=?",
        row.run_id,
        row.model_key,
        earlier.turn,
      );
      ensure(unit?.status === 'done' && unit.result_json, 'REHEARSAL_REPLY_MISSING');
      replies.push((JSON.parse(unit.result_json) as { bubbles: string[] }).bubbles);
    }
    const request = rehearsalRequest(
      this.frozenOf(row),
      row.run_id,
      row.model_key!,
      index + 1,
      turns.map((t) => t.text!),
      replies,
    );
    const json = JSON.stringify(request);
    this.store.run(
      'UPDATE web_rehearsal_units SET request_json=?,request_digest=? WHERE run_id=? AND seq=? AND request_json IS NULL',
      json,
      previewDigest(json),
      row.run_id,
      row.seq,
    );
    return request;
  }
  private knownDraft(row: UnitContext, request: TextGenerationRequest) {
    const call = this.calls(row.run_id, row.seq).find((c) => c.phase === 'draft');
    ensure(
      call?.state === 'known' &&
        call.outcome === 'succeeded' &&
        call.output_json &&
        call.metadata_json &&
        previewDigest(call.output_json) === call.output_hash,
      'REHEARSAL_OUTPUT_UNCONFIRMED',
    );
    return {
      payload: JSON.parse(call.output_json),
      metadata: JSON.parse(call.metadata_json) as AcceptedV7StageOutput['metadata'],
      requestDigest: previewDigest(JSON.stringify(request)),
      policyHash: this.generator.policyHash!,
    };
  }
  private confirm(
    claim: RehearsalClaim,
    phase: Phase,
    observation: ProviderObservation,
    stage?: AcceptedV7StageOutput,
    judgeText?: string,
  ) {
    return this.store.transaction(() => {
      const call = this.calls(claim.runId, claim.seq).find((c) => c.phase === phase),
        row = this.unit(claim.runId, claim.seq),
        usage = observation.usage;
      ensure(
        call &&
          ['sent', 'unknown'].includes(call.state) &&
          usage.unit === 'tokens' &&
          natural(usage.inputTokens) &&
          natural(usage.outputTokens),
        'REHEARSAL_BILL_UNCONFIRMED',
      );
      const units = usage.inputTokens + usage.outputTokens;
      ensure(natural(units) && units <= call.max_units, 'REHEARSAL_USAGE_INVALID');
      if (stage) {
        const meta = stage.metadata;
        ensure(
          observation.outcome === 'succeeded' &&
            row.request_json !== null &&
            stage.jobId === (JSON.parse(row.request_json) as TextGenerationRequest).jobId &&
            stage.stage === phase &&
            stage.requestDigest === row.request_digest &&
            stage.policyHash === this.generator.policyHash &&
            stage.wireRequestHash === call.wire_hash &&
            meta.stage === phase &&
            meta.model === call.model &&
            meta.status === 'succeeded' &&
            meta.usage?.inputTokens === usage.inputTokens &&
            meta.usage.outputTokens === usage.outputTokens &&
            meta.usage.totalTokens === units,
          'REHEARSAL_STAGE_UNCONFIRMED',
        );
        const request = JSON.parse(row.request_json!) as TextGenerationRequest;
        if (phase === 'draft') parseTextDraft(stage.payload, request);
        else {
          const draft = this.knownDraft(row, request);
          applyTextReview(stage.payload, parseTextDraft(draft.payload, request), request, DROP_INVALID_METADATA);
        }
      }
      const charged = units * this.price(call),
        now = this.now();
      ensure(natural(charged) && charged <= call.held_micros, 'REHEARSAL_USAGE_INVALID');
      const output = stage ? JSON.stringify(stage.payload) : (judgeText ?? null);
      this.store.run(
        `UPDATE web_rehearsal_calls SET state='known',outcome=?,charged_micros=?,receipt_json=?,output_json=?,output_hash=?,
        metadata_json=?,settled_at=? WHERE run_id=? AND seq=? AND phase=?`,
        stage || judgeText !== undefined ? 'succeeded' : 'failed',
        charged,
        JSON.stringify(observation),
        output,
        output ? previewDigest(output) : null,
        stage ? JSON.stringify(stage.metadata) : null,
        now,
        claim.runId,
        claim.seq,
        phase,
      );
      this.release(call, charged);
      return this.calls(claim.runId, claim.seq).find((c) => c.phase === phase)!;
    });
  }
  private async cell(claim: RehearsalClaim, signal: AbortSignal) {
    const row = this.live(claim);
    const model = row.model_key;
    ensure(isPlayerModelId(model), 'REHEARSAL_REQUEST_INVALID');
    const request = this.cellRequest(row);
    const have = (phase: Phase) => this.calls(claim.runId, claim.seq).some((c) => c.phase === phase);
    // Bills already known (a requeued unit) are settled before anything new is sent.
    for (const call of this.calls(claim.runId, claim.seq)) {
      ensure(call.state === 'known' && call.outcome === 'succeeded', 'REHEARSAL_ATTEMPT_UNRESOLVED');
      await this.settle(call);
    }
    if (!(have('draft') && have('review'))) await this.pass(claim, row, request, model, signal, have('draft'));
    this.commit(claim, request);
  }
  private async pass(
    claim: RehearsalClaim,
    row: UnitContext,
    request: TextGenerationRequest,
    model: PlayerModelId,
    signal: AbortSignal,
    withKnownDraft: boolean,
  ) {
    const observations = new Map<Phase, ProviderObservation>();
    const draftRef = draftModelRef(model);
    const reviewRef = { provider: 'deepseek' as const, model: row.reviewer };
    const route: TextRoute = { draft: [draftRef], review: [reviewRef] };
    const expected: Array<'draft' | 'review'> = withKnownDraft ? ['review'] : ['draft', 'review'];
    const meter: ProviderMeter = {
      reserve: (specs) => {
        ensure(
          specs.length === expected.length && specs.every((spec, i) => spec.stage === expected[i]),
          'REHEARSAL_STAGE_INVALID',
        );
        return {
          start: async (stage, hash, bytes) => {
            ensure(
              !signal.aborted && (stage === 'draft' || stage === 'review') && hash && bytes,
              'REHEARSAL_STAGE_INVALID',
            );
            const spec = specs.find((s) => s.stage === stage) as ProviderCallSpec;
            const ref = stage === 'draft' ? draftRef : reviewRef;
            ensure(
              spec.provider === ref.provider &&
                spec.model === ref.model &&
                spec.bounds.unit === 'tokens' &&
                natural(spec.bounds.inputTokens) &&
                natural(spec.bounds.outputTokens),
              'REHEARSAL_STAGE_INVALID',
            );
            const call = this.reserve(
              claim,
              stage,
              ref,
              spec.bounds.outputTokens,
              hash,
              bytes,
              spec.bounds.inputTokens,
            );
            await this.dispatch(claim, call, signal);
            return {
              rejected: () => {},
              finish: async (observation) => {
                observations.set(stage, observation);
                if (
                  observation.outcome !== 'succeeded' &&
                  observation.usage.unit === 'tokens' &&
                  natural(observation.usage.inputTokens) &&
                  natural(observation.usage.outputTokens)
                )
                  // A complete response with usage that failed validation is a KNOWN, billed, final result of this model.
                  await this.settle(this.confirm(claim, stage, observation));
              },
            };
          },
          close: () => {},
        };
      },
    };
    const accept = async (stage: AcceptedV7StageOutput) => {
      const observation = observations.get(stage.stage);
      ensure(observation, 'REHEARSAL_STAGE_UNCONFIRMED');
      await this.settle(this.confirm(claim, stage.stage, observation, stage));
      ensure(!signal.aborted, 'REHEARSAL_INTERRUPTED');
      this.live(claim);
    };
    try {
      if (withKnownDraft)
        await this.generator.generateAcceptedReviewFromKnownDraft(
          request,
          signal,
          this.knownDraft(row, request),
          accept,
          meter,
          route,
        );
      else await this.generator.generateAcceptedStages(request, signal, accept, meter, route);
    } catch (error) {
      // A complete response whose usage was seen but not yet confirmed is still a known bill.
      for (const call of this.calls(claim.runId, claim.seq)) {
        const observation = observations.get(call.phase);
        if (
          observation &&
          call.state === 'sent' &&
          call.lease_token === claim.token &&
          observation.usage.unit === 'tokens' &&
          natural(observation.usage.inputTokens) &&
          natural(observation.usage.outputTokens)
        )
          try {
            await this.settle(this.confirm(claim, call.phase, observation));
          } catch {
            /* the durable hold remains */
          }
      }
      throw error;
    }
  }
  /** Both stages known and settled: the reply is stored on the unit. */
  private commit(claim: RehearsalClaim, request: TextGenerationRequest) {
    this.store.transaction(() => {
      const row = this.live(claim);
      const calls = this.calls(claim.runId, claim.seq);
      ensure(calls.length === 2 && calls.every((c) => c.shared_settled === 1), 'REHEARSAL_BILL_UNCONFIRMED');
      const draft = this.knownDraft(row, request);
      const review = calls.find((c) => c.phase === 'review');
      ensure(
        review?.state === 'known' && review.outcome === 'succeeded' && review.output_json,
        'REHEARSAL_OUTPUT_UNCONFIRMED',
      );
      const reply = applyTextReview(
        JSON.parse(review.output_json),
        parseTextDraft(draft.payload, request),
        request,
        DROP_INVALID_METADATA,
      );
      const required = request.requiredMessageIds[0]!;
      this.finish(claim.runId, claim.seq, 'done', null, {
        bubbles: reply.bubbles.map((b) => b.text),
        answered: reply.coveredMessageIds.includes(required) && reply.deferredMessageIds.length === 0,
      });
    });
  }

  // ---- judge calls ------------------------------------------------------------------------------------------------------

  /** One judge call on the house reviewer: reserved before it is sent, never retried, recorded and settled once. */
  private async judgeCall(
    claim: RehearsalClaim,
    prompt: { system: string; sha: string },
    user: string,
    signal: AbortSignal,
  ) {
    const row = this.live(claim);
    ensure(this.judge, 'REHEARSAL_JUDGE_UNAVAILABLE');
    ensure(this.calls(claim.runId, claim.seq).length === 0, 'REHEARSAL_ATTEMPT_UNRESOLVED');
    const ref = { provider: 'deepseek' as const, model: row.reviewer };
    const bytes = Buffer.byteLength(prompt.system, 'utf8') + Buffer.byteLength(user, 'utf8');
    const wireHash = previewDigest(JSON.stringify([ref.model, prompt.sha, user]));
    const call = this.reserve(claim, 'judge', ref, REHEARSAL_JUDGE_OUTPUT_TOKENS, wireHash, bytes, bytes);
    await this.dispatch(claim, call, signal);
    // Any failure from here on leaves the call unknown: kept, never sent again.
    const result = await this.judge.completeJson(
      {
        system: prompt.system,
        systemSha256: prompt.sha,
        user,
        maxTokens: REHEARSAL_JUDGE_OUTPUT_TOKENS,
        model: ref.model,
      },
      signal,
      () => {
        this.live(claim);
        ensure(
          this.store.get(
            "SELECT 1 FROM web_rehearsal_calls WHERE run_id=? AND seq=? AND phase='judge' AND state='sent'",
            claim.runId,
            claim.seq,
          ) !== undefined,
          'REHEARSAL_LEASE_STALE',
        );
      },
    );
    ensure(result.model === ref.model, 'WEB_PROVIDER_WIRE_MISMATCH');
    const observation: ProviderObservation = {
      outcome: 'succeeded',
      providerRequestId: null,
      reportedModel: result.model,
      usage: {
        unit: 'tokens',
        inputTokens: result.inputTokens,
        cacheHitInputTokens: null,
        cacheMissInputTokens: null,
        outputTokens: result.outputTokens,
      },
      errorCode: null,
    };
    await this.settle(this.confirm(claim, 'judge', observation, undefined, result.text));
    return result.text;
  }
  private async hint(claim: RehearsalClaim, signal: AbortSignal) {
    const row = this.live(claim);
    const item = this.store.get<{ spec_json: string }>(
      'SELECT spec_json FROM web_rehearsal_items WHERE run_id=? AND item_key=?',
      claim.runId,
      row.item_key,
    )!;
    const frozen = this.frozenOf(row);
    ensure(frozen.cast, 'REHEARSAL_REQUEST_INVALID');
    const text = await this.judgeCall(
      claim,
      { system: REHEARSAL_HINT_PROMPT, sha: REHEARSAL_HINT_PROMPT_SHA256 },
      item.spec_json,
      signal,
    );
    const written = parseHints(text, forbiddenWords(frozen.cast.view, row.item_key!));
    this.store.transaction(() => {
      this.live(claim);
      if (!written) {
        this.store.run(
          "UPDATE web_rehearsal_items SET state='dropped' WHERE run_id=? AND item_key=?",
          claim.runId,
          row.item_key,
        );
        return this.finish(claim.runId, claim.seq, 'failed', 'REHEARSAL_HINT_INVALID');
      }
      const turns = this.store.all<{ turn: number }>(
        'SELECT turn FROM web_rehearsal_turns WHERE run_id=? AND item_key=? ORDER BY turn',
        claim.runId,
        row.item_key,
      );
      const lines = [written.hints[0], written.negative, written.hints[1]];
      turns.forEach((t, i) =>
        this.store.run(
          'UPDATE web_rehearsal_turns SET text=? WHERE run_id=? AND turn=?',
          lines[i]!,
          claim.runId,
          t.turn,
        ),
      );
      this.store.run(
        "UPDATE web_rehearsal_items SET state='ready' WHERE run_id=? AND item_key=?",
        claim.runId,
        row.item_key,
      );
      this.finish(claim.runId, claim.seq, 'done', null, { ok: true });
    });
  }
  private async verdict(claim: RehearsalClaim, signal: AbortSignal) {
    const row = this.live(claim);
    const item = this.store.get<{ spec_json: string }>(
      'SELECT spec_json FROM web_rehearsal_items WHERE run_id=? AND item_key=?',
      claim.runId,
      row.item_key,
    )!;
    const turns = this.store
      .all<{ turn: number; text: string; role: 'hint' | 'negative' }>(
        'SELECT turn,text,role FROM web_rehearsal_turns WHERE run_id=? AND item_key=? ORDER BY turn',
        claim.runId,
        row.item_key,
      )
      .map((t) => {
        const unit = this.store.get<{ result_json: string }>(
          "SELECT result_json FROM web_rehearsal_units WHERE run_id=? AND kind='cell' AND model_key=? AND turn=?",
          claim.runId,
          row.model_key,
          t.turn,
        )!;
        return {
          role: t.role,
          player: t.text,
          reply: (JSON.parse(unit.result_json) as { bubbles: string[] }).bubbles.join('\n'),
        };
      });
    const user = JSON.stringify({ item: JSON.parse(item.spec_json), turns });
    const text = await this.judgeCall(
      claim,
      { system: REHEARSAL_VERDICT_PROMPT, sha: REHEARSAL_VERDICT_PROMPT_SHA256 },
      user,
      signal,
    );
    const verdict = parseVerdict(text);
    this.store.transaction(() => {
      this.live(claim);
      if (!verdict) return this.finish(claim.runId, claim.seq, 'failed', 'REHEARSAL_VERDICT_INVALID');
      this.finish(claim.runId, claim.seq, 'done', null, verdict);
    });
  }

  async run(claim: RehearsalClaim, signal: AbortSignal) {
    try {
      const row = this.live(claim);
      if (row.kind === 'cell') await this.cell(claim, signal);
      else if (row.kind === 'hint') await this.hint(claim, signal);
      else await this.verdict(claim, signal);
      ensure(!signal.aborted, 'REHEARSAL_INTERRUPTED');
    } catch (error) {
      this.store.transaction(() => {
        this.uncertain(claim.runId, claim.seq);
        const row = this.unit(claim.runId, claim.seq);
        if (row.lease_token !== claim.token || row.status !== 'generating') return;
        const calls = this.calls(claim.runId, claim.seq);
        // A call that may have been sent and has no bill: the unit is 未确认, and nothing sends it again.
        if (calls.some((c) => c.state === 'unknown'))
          return this.finish(claim.runId, claim.seq, 'unconfirmed', 'REHEARSAL_CALL_UNKNOWN');
        const draft = calls.find((c) => c.phase === 'draft');
        if (draft?.state === 'known' && draft.outcome === 'failed')
          return this.finish(claim.runId, claim.seq, 'failed', 'REHEARSAL_DRAFT_FAILED');
        const review = calls.find((c) => c.phase === 'review');
        if (review?.state === 'known' && review.outcome === 'failed')
          return this.finish(claim.runId, claim.seq, 'failed', 'REHEARSAL_REVIEW_FAILED');
        // Nothing unresolved and a known draft: requeue until the deadline (a transient refusal), never when aborted.
        if (!signal.aborted && calls.length > 0 && row.deadline_at > this.now()) {
          this.store.run(
            "UPDATE web_rehearsal_units SET status='queued',lease_until=NULL,retry_at=? WHERE run_id=? AND seq=?",
            this.now() + 10_000,
            claim.runId,
            claim.seq,
          );
          return;
        }
        this.finish(
          claim.runId,
          claim.seq,
          'failed',
          error instanceof DomainError ? error.code : 'REHEARSAL_GENERATION_FAILED',
        );
      });
    }
  }
}

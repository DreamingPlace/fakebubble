import { randomUUID } from 'node:crypto';
import type { AcceptedV7StageOutput, Clock, TextGenerationRequest } from '../../../packages/contracts/index.ts';
import type {
  ProviderCallSpec,
  ProviderMeter,
  ProviderObservation,
} from '../../../packages/contracts/provider-calls.ts';
import type { TextRoute } from '../../../packages/contracts/text-route.ts';
import { DomainError, ensure } from '../../../packages/domain/errors.ts';
import { hasCharacterPermission } from '../../../packages/contracts/web-admin-permissions.ts';
import { webConcurrency } from '../../../config/web-concurrency.ts';
import type { BusinessStore } from '../platform/store-contract.ts';
import type { DeepSeekTextGenerator } from '../generation/deepseek.ts';
import { applyTextReview, DROP_INVALID_METADATA, parseTextDraft } from '../generation/accepted-text-protocol.ts';
import { budgetHash } from '../budget/web-provider-budget-contract.ts';
import { DEFAULT_TEXT_MODELS } from '../platform/config.ts';
import { previewDigest } from './web-character-preview.ts';
import { webCharacterPreviewsRunning } from './web-character-preview-schema.ts';
import { reviewCompareInstalled } from './web-review-compare-schema.ts';
import type { WebPreviewBudget } from './web-character-preview-runner.ts';

/** The three provider calls of a case. Both review phases are the `review` stage of the protocol, for different models. */
export type ComparePhase = 'draft' | 'review_pro' | 'review_flash';
export const COMPARE_PHASE_MODEL: Readonly<Record<ComparePhase, string>> = Object.freeze({
  draft: DEFAULT_TEXT_MODELS.draft,
  review_pro: 'deepseek-v4-pro',
  review_flash: 'deepseek-flash',
});
const stageOf = (phase: ComparePhase): 'draft' | 'review' => (phase === 'draft' ? 'draft' : 'review');
export interface CompareAttempt {
  run_id: string;
  ordinal: number;
  phase: ComparePhase;
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
  rejected_json: string | null;
  latency_ms: number | null;
  shared_settled: number;
}
interface CaseRow {
  run_id: string;
  ordinal: number;
  case_key: string;
  request_json: string;
  request_digest: string;
  status: 'queued' | 'generating' | 'done' | 'failed';
  lease_token: string | null;
  lease_until: number | null;
  deadline_at: number;
  retry_at: number;
  error_code: string | null;
  member_id: string;
  session_id: string;
}
export interface CompareClaim {
  runId: string;
  ordinal: number;
  token: string;
}
type Generator = Pick<
  DeepSeekTextGenerator,
  'textProtocol' | 'policyHash' | 'generateAcceptedStages' | 'generateAcceptedReviewFromKnownDraft'
>;
const REJECTED_MAX_BYTES = 32768;
const natural = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0;
const routeFor = (phase: 'review_pro' | 'review_flash'): TextRoute => ({
  draft: [{ provider: 'deepseek', model: DEFAULT_TEXT_MODELS.draft }],
  review: [{ provider: 'deepseek', model: COMPARE_PHASE_MODEL[phase] }],
});

/**
 * Part 26b: runs the 审核对比 one case at a time inside the preview queue's single text slot. Same guarantees as a preview:
 * the budget is reserved (shared ledger AND capacity ticket) BEFORE every provider call, an UNKNOWN call is never retried and
 * keeps both its hold and its ticket, a known bill is settled exactly once. A case's draft is written ONCE; V4 Pro and V4.1
 * Flash then review that same draft with the same frozen request, in that order. A review that came back invalid is a result
 * (recorded, charged, not retried); it never stops the other reviewer.
 */
export class WebReviewCompareRunner {
  private readonly store: BusinessStore;
  private readonly clock: Clock;
  private readonly generator: Generator;
  private readonly budget: WebPreviewBudget;
  private readonly nextId: () => string;
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
  private get on() {
    return reviewCompareInstalled(this.store);
  }
  private now() {
    const now = this.clock.now();
    ensure(natural(now), 'INVALID_TIME');
    return now;
  }
  private attempts(runId: string, ordinal: number) {
    return this.store.all<CompareAttempt>(
      'SELECT * FROM web_review_compare_attempts WHERE run_id=? AND ordinal=? ORDER BY phase',
      runId,
      ordinal,
    );
  }
  private caseRow(runId: string, ordinal: number) {
    const row = this.store.get<CaseRow>(
      `SELECT c.*,r.member_id,r.session_id FROM web_review_compare_cases c JOIN web_review_compare_runs r ON r.id=c.run_id
      WHERE c.run_id=? AND c.ordinal=?`,
      runId,
      ordinal,
    );
    ensure(row, 'NOT_FOUND');
    return row;
  }
  private fail(runId: string, ordinal: number, code: string) {
    this.store.run(
      `UPDATE web_review_compare_cases SET status='failed',finished_at=?,error_code=?,lease_until=NULL
      WHERE run_id=? AND ordinal=? AND status IN ('queued','generating')`,
      this.now(),
      code,
      runId,
      ordinal,
    );
  }
  /** The administrator who started the run still holds a live session and may run comparisons (owner, or preview on every character). */
  private authorized(row: Pick<CaseRow, 'member_id' | 'session_id'>, now: number) {
    const member = this.store.get<{ role: string; permissions_json: string }>(
      `SELECT m.role,m.permissions_json FROM web_admin_members m
      JOIN web_admin_session_members a ON a.member_id=m.id JOIN admin_sessions s ON s.id=a.session_id
      WHERE m.id=? AND s.id=? AND s.revoked_at IS NULL AND s.expires_at>?`,
      row.member_id,
      row.session_id,
      now,
    );
    return (
      !!member &&
      (member.role === 'owner' || hasCharacterPermission(JSON.parse(member.permissions_json), 'preview', '*'))
    );
  }
  private live(runId: string, ordinal: number, token: string) {
    const row = this.caseRow(runId, ordinal);
    ensure(
      row.status === 'generating' && row.lease_token === token && row.lease_until! > this.now(),
      'COMPARE_LEASE_STALE',
    );
    ensure(row.deadline_at > this.now(), 'COMPARE_EXPIRED');
    ensure(this.authorized(row, this.now()), 'ADMIN_PERMISSION_REQUIRED');
    ensure(previewDigest(row.request_json) === row.request_digest, 'COMPARE_REQUEST_CHANGED');
    return { row, request: JSON.parse(row.request_json) as TextGenerationRequest };
  }
  /** Uncertain reservations/sends keep BOTH the money hold and the phase ticket; nothing resends them. */
  private uncertain(runId: string, ordinal: number) {
    this.store.run(
      "UPDATE web_review_compare_attempts SET state='unknown' WHERE run_id=? AND ordinal=? AND state IN ('intent','sent')",
      runId,
      ordinal,
    );
  }

  claim(): CompareClaim | null {
    if (!this.on) return null;
    return this.store.transaction(() => {
      const now = this.now();
      for (const c of this.store.all<{ run_id: string; ordinal: number; status: string }>(
        `SELECT run_id,ordinal,status FROM web_review_compare_cases
        WHERE status IN ('queued','generating') AND (deadline_at<=? OR status='generating' AND lease_until<=?)`,
        now,
        now,
      )) {
        const row = this.caseRow(c.run_id, c.ordinal);
        this.uncertain(c.run_id, c.ordinal);
        const attempts = this.attempts(c.run_id, c.ordinal);
        const unresolved = attempts.some((a) => a.state !== 'known');
        if (unresolved) this.fail(c.run_id, c.ordinal, 'COMPARE_CALL_UNKNOWN');
        else if (row.deadline_at <= now) this.fail(c.run_id, c.ordinal, 'COMPARE_EXPIRED');
        else
          this.store.run(
            "UPDATE web_review_compare_cases SET status='queued',lease_until=NULL WHERE run_id=? AND ordinal=?",
            c.run_id,
            c.ordinal,
          );
      }
      if (
        webCharacterPreviewsRunning(this.store) >= 1 ||
        this.store.get<{ n: number }>("SELECT count(*) n FROM web_operations WHERE status='text_running'")!.n >=
          webConcurrency(this.store).maxTextRunning
      )
        return null;
      const next = this.store.get<{ run_id: string; ordinal: number }>(
        `SELECT c.run_id,c.ordinal FROM web_review_compare_cases c JOIN web_review_compare_runs r ON r.id=c.run_id
        WHERE c.status='queued' AND c.retry_at<=? ORDER BY r.created_at,c.run_id,c.ordinal LIMIT 1`,
        now,
      );
      if (!next) return null;
      const row = this.caseRow(next.run_id, next.ordinal);
      if (!this.authorized(row, now)) {
        this.fail(row.run_id, row.ordinal, 'ADMIN_PERMISSION_REQUIRED');
        return null;
      }
      const token = this.nextId();
      this.store.run(
        "UPDATE web_review_compare_cases SET status='generating',lease_until=?,lease_token=? WHERE run_id=? AND ordinal=?",
        Math.min(now + 150_000, row.deadline_at),
        token,
        row.run_id,
        row.ordinal,
      );
      return { runId: row.run_id, ordinal: row.ordinal, token };
    });
  }
  nextDue() {
    if (!this.on) return null;
    const row = this.store.get<{ due: number | null }>(
      `SELECT min(min(deadline_at,CASE status WHEN 'queued' THEN max(retry_at,?) ELSE lease_until END)) due
      FROM web_review_compare_cases WHERE status IN ('queued','generating')`,
      this.now() + 1000,
    );
    const pending = this.store.get(
      "SELECT 1 FROM web_review_compare_attempts WHERE state='known' AND shared_settled=0 LIMIT 1",
    );
    const at = Math.min(row?.due ?? Infinity, pending ? this.now() + 10_000 : Infinity);
    return Number.isFinite(at) ? at : null;
  }

  private async settle(row: CompareAttempt) {
    if (row.shared_settled) return;
    ensure(
      row.state === 'known' && row.charged_micros !== null && row.receipt_json !== null,
      'COMPARE_BILL_UNCONFIRMED',
    );
    await this.budget.settle(row.budget_id, row.fingerprint, row.charged_micros, JSON.parse(row.receipt_json));
    this.store.run(
      "UPDATE web_review_compare_attempts SET shared_settled=1 WHERE run_id=? AND ordinal=? AND phase=? AND state='known'",
      row.run_id,
      row.ordinal,
      row.phase,
    );
  }
  async recoverBills() {
    if (!this.on) return 0;
    const rows = this.store.all<CompareAttempt>(
      "SELECT * FROM web_review_compare_attempts WHERE state='known' AND shared_settled=0 LIMIT 16",
    );
    for (const row of rows) await this.settle(row);
    return rows.length;
  }

  /** Budget BEFORE the call: price row, phase ticket and money hold in one transaction, then the shared reservation. */
  private reserve(claim: CompareClaim, phase: ComparePhase, spec: ProviderCallSpec, wireHash: string, bytes: number) {
    return this.store.transaction(() => {
      const { row } = this.live(claim.runId, claim.ordinal, claim.token),
        now = this.now(),
        stage = stageOf(phase);
      ensure(
        spec.provider === 'deepseek' &&
          spec.stage === stage &&
          spec.model === COMPARE_PHASE_MODEL[phase] &&
          spec.bounds.unit === 'tokens' &&
          natural(spec.bounds.inputTokens) &&
          natural(spec.bounds.outputTokens) &&
          /^[a-f0-9]{64}$/.test(wireHash) &&
          natural(bytes) &&
          bytes > 0,
        'COMPARE_STAGE_INVALID',
      );
      const existing = this.attempts(claim.runId, claim.ordinal);
      ensure(!existing.some((a) => a.phase === phase), 'COMPARE_ATTEMPT_UNRESOLVED');
      if (phase !== 'draft')
        ensure(
          existing.some(
            (a) => a.phase === 'draft' && a.state === 'known' && a.outcome === 'succeeded' && a.shared_settled === 1,
          ),
          'COMPARE_OUTPUT_UNCONFIRMED',
        );
      const price = this.store.get<{ id: string; upper_micros_per_unit: number }>(
        `SELECT * FROM web_provider_prices
        WHERE provider='deepseek' AND phase=? AND model=? AND currency='USD' AND unit='token' AND valid_from<=? AND valid_until>?
        ORDER BY version DESC LIMIT 1`,
        stage,
        spec.model,
        now,
        now,
      );
      ensure(price, 'WEB_PROVIDER_PRICE_REQUIRED');
      const max = Math.min(spec.bounds.inputTokens, bytes) + spec.bounds.outputTokens,
        held = max * price.upper_micros_per_unit;
      ensure(natural(max) && max > 0 && natural(held) && held > 0, 'COMPARE_STAGE_INVALID');
      ensure(
        this.store.run(
          `UPDATE web_external_budgets SET reserved=reserved+1
          WHERE provider='deepseek' AND stage='text' AND phase=? AND reserved<capacity`,
          stage,
        ).changes === 1,
        'WEB_DISPATCH_CAPACITY',
      );
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
      const instance = this.store.get<{ instance_id: string }>(
        'SELECT instance_id FROM web_instance WHERE singleton=1',
      );
      ensure(instance, 'WEB_LOCAL_INSTANCE_MISMATCH');
      const budgetId = JSON.stringify([instance.instance_id, 'admin-compare', claim.runId, claim.ordinal, phase]);
      const fingerprint = budgetHash([
        row.member_id,
        row.session_id,
        row.case_key,
        row.request_digest,
        wireHash,
        spec.model,
        price.id,
        max,
        held,
      ]);
      this.store.run(
        `INSERT INTO web_review_compare_attempts(run_id,ordinal,phase,budget_id,fingerprint,wire_hash,lease_token,model,price_id,
        max_units,held_micros,state,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,'intent',?)`,
        claim.runId,
        claim.ordinal,
        phase,
        budgetId,
        fingerprint,
        wireHash,
        claim.token,
        spec.model,
        price.id,
        max,
        held,
        now,
      );
      return this.attempts(claim.runId, claim.ordinal).find((a) => a.phase === phase)!;
    });
  }

  private confirm(
    claim: CompareClaim,
    phase: ComparePhase,
    observation: ProviderObservation,
    latencyMs: number,
    stage?: AcceptedV7StageOutput,
    rejected?: { raw: string; errorCode: string },
  ) {
    return this.store.transaction(() => {
      const attempt = this.attempts(claim.runId, claim.ordinal).find((a) => a.phase === phase),
        row = this.caseRow(claim.runId, claim.ordinal),
        usage = observation.usage;
      ensure(
        attempt &&
          ['sent', 'unknown'].includes(attempt.state) &&
          usage.unit === 'tokens' &&
          natural(usage.inputTokens) &&
          natural(usage.outputTokens),
        'COMPARE_BILL_UNCONFIRMED',
      );
      const units = usage.inputTokens + usage.outputTokens;
      ensure(natural(units) && units <= attempt.max_units, 'COMPARE_USAGE_INVALID');
      if (stage) {
        const meta = stage.metadata;
        ensure(
          observation.outcome === 'succeeded' &&
            stage.jobId === row.run_id + '-' + row.ordinal &&
            stage.stage === stageOf(phase) &&
            stage.requestDigest === requestDigest(row) &&
            meta.stage === stageOf(phase) &&
            meta.model === attempt.model &&
            stage.wireRequestHash === attempt.wire_hash &&
            meta.status === 'succeeded' &&
            meta.usage?.inputTokens === usage.inputTokens &&
            meta.usage.outputTokens === usage.outputTokens,
          'COMPARE_STAGE_UNCONFIRMED',
        );
        const request = JSON.parse(row.request_json) as TextGenerationRequest;
        if (phase === 'draft') parseTextDraft(stage.payload, request);
        else {
          const draft = this.knownDraft(claim.runId, claim.ordinal);
          applyTextReview(stage.payload, parseTextDraft(draft.payload, request), request, DROP_INVALID_METADATA);
        }
      }
      const price = this.store.get<{ upper_micros_per_unit: number }>(
        'SELECT upper_micros_per_unit FROM web_provider_prices WHERE id=?',
        attempt.price_id,
      )!;
      const charged = units * price.upper_micros_per_unit;
      ensure(natural(charged) && charged <= attempt.held_micros, 'COMPARE_USAGE_INVALID');
      const output = stage ? JSON.stringify(stage.payload) : null;
      const bytes = rejected ? Buffer.from(rejected.raw, 'utf8') : null;
      const cut = bytes && bytes.length > REJECTED_MAX_BYTES;
      const kept = rejected
        ? JSON.stringify({
            errorCode: rejected.errorCode.slice(0, 100) || 'UNKNOWN',
            raw: cut ? bytes!.subarray(0, REJECTED_MAX_BYTES).toString('utf8').replace(/�+$/u, '') : rejected.raw,
            truncated: !!cut,
          })
        : null;
      this.store.run(
        `UPDATE web_review_compare_attempts SET state='known',outcome=?,charged_micros=?,receipt_json=?,output_json=?,output_hash=?,
        metadata_json=?,rejected_json=?,latency_ms=?,settled_at=? WHERE run_id=? AND ordinal=? AND phase=?`,
        stage ? 'succeeded' : 'failed',
        charged,
        JSON.stringify(observation),
        output,
        output ? previewDigest(output) : null,
        stage ? JSON.stringify(stage.metadata) : null,
        kept,
        Math.max(0, Math.round(latencyMs)),
        this.now(),
        claim.runId,
        claim.ordinal,
        phase,
      );
      ensure(
        this.store.run(
          `UPDATE web_provider_spending SET held_micros=held_micros-?,spent_micros=spent_micros+?
          WHERE provider='deepseek' AND held_micros>=?`,
          attempt.held_micros,
          charged,
          attempt.held_micros,
        ).changes === 1,
        'COMPARE_BUDGET_CORRUPT',
      );
      ensure(
        this.store.run(
          `UPDATE web_external_budgets SET reserved=reserved-1
          WHERE provider='deepseek' AND stage='text' AND phase=? AND reserved>0`,
          stageOf(phase),
        ).changes === 1,
        'COMPARE_BUDGET_CORRUPT',
      );
      return this.attempts(claim.runId, claim.ordinal).find((a) => a.phase === phase)!;
    });
  }
  private knownDraft(runId: string, ordinal: number) {
    const row = this.attempts(runId, ordinal).find((a) => a.phase === 'draft'),
      job = this.caseRow(runId, ordinal);
    ensure(
      row?.state === 'known' &&
        row.outcome === 'succeeded' &&
        row.output_json &&
        row.metadata_json &&
        previewDigest(row.output_json) === row.output_hash,
      'COMPARE_OUTPUT_UNCONFIRMED',
    );
    return {
      payload: JSON.parse(row.output_json),
      metadata: JSON.parse(row.metadata_json) as AcceptedV7StageOutput['metadata'],
      requestDigest: requestDigest(job),
      policyHash: this.generator.policyHash!,
    };
  }

  /**
   * One generator pass for `phases`: [draft, review_x] with a fresh draft, or [review_x] on the known draft. The meter maps the
   * generator's stages onto the case's phases and reserves before every send.
   */
  private async pass(
    claim: CompareClaim,
    signal: AbortSignal,
    reviewPhase: 'review_pro' | 'review_flash',
    withDraft: boolean,
  ) {
    const { request } = this.live(claim.runId, claim.ordinal, claim.token);
    const observations = new Map<ComparePhase, { observation: ProviderObservation; ms: number }>();
    const rejected = new Map<ComparePhase, { raw: string; errorCode: string }>();
    const sentAt = new Map<ComparePhase, number>();
    const phaseOf = (stage: 'draft' | 'review'): ComparePhase => (stage === 'draft' ? 'draft' : reviewPhase);
    const meter: ProviderMeter = {
      reserve: (specs) => {
        const expected = withDraft ? ['draft', 'review'] : ['review'];
        ensure(
          specs.length === expected.length && specs.every((spec, i) => spec.stage === expected[i]),
          'COMPARE_STAGE_INVALID',
        );
        return {
          start: async (stage, hash, bytes) => {
            ensure(
              !signal.aborted && (stage === 'draft' || stage === 'review') && hash && bytes,
              'COMPARE_STAGE_INVALID',
            );
            const phase = phaseOf(stage);
            const spec = specs.find((s) => s.stage === stage)!;
            const attempt = this.reserve(claim, phase, spec, hash, bytes);
            await this.budget.reserve(attempt.budget_id, 'deepseek', attempt.fingerprint, attempt.held_micros);
            this.store.transaction(() => {
              ensure(!signal.aborted, 'COMPARE_INTERRUPTED');
              this.live(claim.runId, claim.ordinal, claim.token);
              ensure(
                this.store.run(
                  `UPDATE web_review_compare_attempts SET state='sent'
                  WHERE run_id=? AND ordinal=? AND phase=? AND lease_token=? AND state='intent'`,
                  claim.runId,
                  claim.ordinal,
                  phase,
                  claim.token,
                ).changes === 1,
                'COMPARE_LEASE_STALE',
              );
            });
            sentAt.set(phase, performance.now());
            return {
              rejected: (output) => {
                rejected.set(phase, output);
              },
              finish: async (observation) => {
                const ms = performance.now() - (sentAt.get(phase) ?? performance.now());
                observations.set(phase, { observation, ms });
                if (
                  observation.outcome !== 'succeeded' &&
                  observation.usage.unit === 'tokens' &&
                  natural(observation.usage.inputTokens) &&
                  natural(observation.usage.outputTokens)
                ) {
                  // A complete response with usage that failed validation is a KNOWN, billed, final result of this reviewer.
                  const done = this.confirm(claim, phase, observation, ms, undefined, rejected.get(phase));
                  await this.settle(done);
                }
              },
            };
          },
          close: () => {},
        };
      },
    };
    const accept = async (stage: AcceptedV7StageOutput) => {
      const phase = phaseOf(stage.stage);
      const got = observations.get(phase);
      ensure(got, 'COMPARE_STAGE_UNCONFIRMED');
      await this.settle(this.confirm(claim, phase, got.observation, got.ms, stage));
      ensure(!signal.aborted, 'COMPARE_INTERRUPTED');
      this.live(claim.runId, claim.ordinal, claim.token);
    };
    const route = routeFor(reviewPhase);
    try {
      if (withDraft) await this.generator.generateAcceptedStages(request, signal, accept, meter, route);
      else
        await this.generator.generateAcceptedReviewFromKnownDraft(
          request,
          signal,
          this.knownDraft(claim.runId, claim.ordinal),
          accept,
          meter,
          route,
        );
    } catch (error) {
      // A complete response whose usage was seen but not yet confirmed is still a known bill.
      for (const attempt of this.attempts(claim.runId, claim.ordinal)) {
        const got = observations.get(attempt.phase);
        const usage = got?.observation.usage;
        if (
          got &&
          attempt.state === 'sent' &&
          attempt.lease_token === claim.token &&
          usage?.unit === 'tokens' &&
          natural(usage.inputTokens) &&
          natural(usage.outputTokens)
        ) {
          try {
            await this.settle(
              this.confirm(claim, attempt.phase, got.observation, got.ms, undefined, rejected.get(attempt.phase)),
            );
          } catch {
            /* the durable hold remains */
          }
        }
      }
      throw error;
    }
  }

  async run(claim: CompareClaim, signal: AbortSignal) {
    let failure: unknown = null;
    try {
      this.live(claim.runId, claim.ordinal, claim.token);
      // Bills already known (a requeued case) are settled before anything new is sent.
      for (const attempt of this.attempts(claim.runId, claim.ordinal)) {
        ensure(attempt.state === 'known', 'COMPARE_ATTEMPT_UNRESOLVED');
        await this.settle(attempt);
      }
      const has = (phase: ComparePhase) => this.attempts(claim.runId, claim.ordinal).some((a) => a.phase === phase);
      const draftOk = () =>
        this.attempts(claim.runId, claim.ordinal).some((a) => a.phase === 'draft' && a.outcome === 'succeeded');
      // Pass 1: the draft (written once) and V4 Pro's review of it. Pass 2: V4.1 Flash reviews the SAME draft.
      if (!has('review_pro')) {
        try {
          await this.pass(claim, signal, 'review_pro', !has('draft'));
        } catch (error) {
          failure = error;
          // A known failed draft ends the case; a known failed Pro review is a RESULT and Flash still reviews the draft.
          if (!draftOk() || !has('review_pro') || signal.aborted || this.unresolved(claim)) throw error;
        }
      }
      if (draftOk() && !has('review_flash') && has('review_pro')) {
        try {
          await this.pass(claim, signal, 'review_flash', false);
        } catch (error) {
          failure ??= error;
          if (!has('review_flash') || signal.aborted || this.unresolved(claim)) throw error;
        }
      }
      ensure(!signal.aborted, 'COMPARE_INTERRUPTED');
      this.finish(claim, failure);
    } catch (error) {
      this.store.transaction(() => {
        this.uncertain(claim.runId, claim.ordinal);
        const row = this.caseRow(claim.runId, claim.ordinal);
        if (row.lease_token !== claim.token || row.status !== 'generating') return;
        const attempts = this.attempts(claim.runId, claim.ordinal);
        if (attempts.some((a) => a.state === 'unknown'))
          return this.fail(claim.runId, claim.ordinal, 'COMPARE_CALL_UNKNOWN');
        const draft = attempts.find((a) => a.phase === 'draft');
        if (draft?.state === 'known' && draft.outcome === 'failed')
          return this.fail(claim.runId, claim.ordinal, 'COMPARE_DRAFT_FAILED');
        // Nothing unresolved and the draft is known: requeue until the deadline (a transient refusal such as a full ticket),
        // never when aborted. A case that never got to send anything fails with the real reason instead of looping.
        if (!signal.aborted && attempts.length > 0 && row.deadline_at > this.now()) {
          this.store.run(
            "UPDATE web_review_compare_cases SET status='queued',lease_until=NULL,retry_at=? WHERE run_id=? AND ordinal=?",
            this.now() + 10_000,
            claim.runId,
            claim.ordinal,
          );
          return;
        }
        this.fail(claim.runId, claim.ordinal, error instanceof DomainError ? error.code : 'COMPARE_GENERATION_FAILED');
      });
    }
  }
  private unresolved(claim: CompareClaim) {
    return this.attempts(claim.runId, claim.ordinal).some((a) => a.state !== 'known');
  }
  /** Both reviews are known (valid or invalid): the case is done. */
  private finish(claim: CompareClaim, _failure: unknown) {
    this.store.transaction(() => {
      const attempts = this.attempts(claim.runId, claim.ordinal);
      const phases = new Set(attempts.filter((a) => a.state === 'known').map((a) => a.phase));
      const draft = attempts.find((a) => a.phase === 'draft');
      if (draft?.outcome === 'failed') return this.fail(claim.runId, claim.ordinal, 'COMPARE_DRAFT_FAILED');
      ensure(
        phases.has('draft') &&
          phases.has('review_pro') &&
          phases.has('review_flash') &&
          attempts.every((a) => a.shared_settled === 1),
        'COMPARE_BILL_UNCONFIRMED',
      );
      this.store.run(
        "UPDATE web_review_compare_cases SET status='done',finished_at=?,error_code=NULL,lease_until=NULL WHERE run_id=? AND ordinal=? AND lease_token=? AND status='generating'",
        this.now(),
        claim.runId,
        claim.ordinal,
        claim.token,
      );
    });
  }
}
const requestDigest = (row: Pick<CaseRow, 'request_digest'>) => row.request_digest;

import { randomUUID } from 'node:crypto';
import type {
  AcceptedV7StageOutput,
  Clock,
  TextGenerationResult,
  TextGenerationStage,
} from '../../../packages/contracts/index.ts';
import type {
  ProviderCallSpec,
  ProviderMeter,
  ProviderObservation,
} from '../../../packages/contracts/provider-calls.ts';
import { DomainError, ensure } from '../../../packages/domain/errors.ts';
import { WEB_LIMITS } from '../../../config/web-v1.ts';
import type { BusinessStore } from '../platform/store-contract.ts';
import type { DeepSeekTextGenerator } from '../generation/deepseek.ts';
import { applyTextReview, parseTextDraft } from '../generation/accepted-text-protocol.ts';
import { budgetHash } from '../budget/web-provider-budget-contract.ts';
import { currentWebPreview, previewDigest, previewPolicy, readWebPreview } from './web-character-preview.ts';
import { webCharacterPreviewsRunning } from './web-character-preview-schema.ts';

/** Same authority used by chat and material generation; no new allowance or budget reset. */
export interface WebPreviewBudget {
  reserve(id: string, provider: 'deepseek', fingerprint: string, micros: number): void | Promise<void>;
  settle(id: string, fingerprint: string, micros: number, receipt: unknown): void | Promise<void>;
}
type Generator = Pick<
  DeepSeekTextGenerator,
  'textProtocol' | 'policyHash' | 'generateAcceptedStages' | 'generateAcceptedReviewFromKnownDraft'
>;
type Phase = 'draft' | 'review';
interface Attempt {
  preview_id: string;
  phase: Phase;
  budget_id: string;
  fingerprint: string;
  wire_hash: string;
  lease_token: string;
  model: string;
  price_id: string;
  max_units: number;
  held_micros: number;
  state: string;
  outcome: string | null;
  charged_micros: number | null;
  receipt_json: string | null;
  output_json: string | null;
  output_hash: string | null;
  metadata_json: string | null;
  shared_settled: number;
}
const natural = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0;

/** One bounded isolated preview, sharing phase capacity and cumulative spend with player work. */
export class WebCharacterPreviewRunner {
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
    ensure(
      generator.textProtocol === 'accepted-v7' && generator.policyHash === previewPolicy,
      'PREVIEW_PROVIDER_CHANGED',
    );
    this.store = store;
    this.clock = clock;
    this.generator = generator;
    this.budget = budget;
    this.nextId = nextId;
  }
  private now() {
    const now = this.clock.now();
    ensure(natural(now), 'INVALID_TIME');
    return now;
  }
  private attempts(id: string) {
    return this.store.all<Attempt>(
      'SELECT * FROM web_character_preview_attempts WHERE preview_id=? ORDER BY phase',
      id,
    );
  }
  private fail(id: string, code: string) {
    this.store.run(
      `UPDATE admin_previews SET status='failed',finished_at=?,error_code=? WHERE id=? AND status IN ('queued','generating')`,
      this.now(),
      code,
      id,
    );
  }
  private live(id: string, token: string) {
    const row = readWebPreview(this.store, id);
    ensure(
      row.status === 'generating' && row.lease_token === token && row.lease_until! > this.now(),
      'PREVIEW_LEASE_STALE',
    );
    return { row, request: currentWebPreview(this.store, this.now(), row) };
  }
  /** Uncertain reservations/sends retain BOTH phase capacity and money; no automatic resend. */
  private uncertain(id: string, token: string | null) {
    this.store.run(
      "UPDATE web_character_preview_attempts SET state='unknown' WHERE preview_id=? AND lease_token=? AND state IN ('intent','sent')",
      id,
      token,
    );
  }
  claim() {
    return this.store.transaction(() => {
      const now = this.now();
      for (const { id } of this.store.all<{ id: string }>(
        `SELECT p.id FROM admin_previews p JOIN web_character_preview_jobs j ON j.preview_id=p.id
        WHERE p.status IN ('queued','generating') AND (j.deadline_at<=? OR p.status='generating' AND p.lease_until<=?)`,
        now,
        now,
      )) {
        const row = readWebPreview(this.store, id);
        this.uncertain(id, row.lease_token);
        const attempts = this.attempts(id);
        if (row.deadline_at <= now || attempts.some((a) => a.state !== 'known' || a.outcome !== 'succeeded'))
          this.fail(id, row.deadline_at <= now ? 'PREVIEW_EXPIRED' : 'PREVIEW_INTERRUPTED');
        else this.store.run("UPDATE admin_previews SET status='queued',lease_until=NULL WHERE id=?", id);
      }
      if (
        webCharacterPreviewsRunning(this.store) >= 1 ||
        this.store.get<{ n: number }>("SELECT count(*) n FROM web_operations WHERE status='text_running'")!.n >=
          WEB_LIMITS.maxTextRunning
      )
        return null;
      const next = this.store.get<{ id: string }>(
        `SELECT p.id FROM admin_previews p JOIN web_character_preview_jobs j ON j.preview_id=p.id
        WHERE p.status='queued' AND j.retry_at<=? ORDER BY p.created_at,p.id LIMIT 1`,
        now,
      );
      if (!next) return null;
      const row = readWebPreview(this.store, next.id);
      try {
        currentWebPreview(this.store, now, row);
      } catch (error) {
        this.fail(row.id, error instanceof DomainError ? error.code : 'PREVIEW_INVALID');
        return null;
      }
      const token = this.nextId();
      this.store.run(
        "UPDATE admin_previews SET status='generating',lease_until=? WHERE id=?",
        Math.min(now + 150_000, row.deadline_at),
        row.id,
      );
      this.store.run('UPDATE web_character_preview_jobs SET lease_token=? WHERE preview_id=?', token, row.id);
      return { id: row.id, token };
    });
  }
  nextDue() {
    const row = this.store.get<{ due: number | null }>(
      `SELECT min(min(j.deadline_at,
      CASE p.status WHEN 'queued' THEN max(j.retry_at,?) ELSE p.lease_until END)) due
      FROM web_character_preview_jobs j JOIN admin_previews p ON p.id=j.preview_id WHERE p.status IN ('queued','generating')`,
      this.now() + 1000,
    );
    // Known billing recovery is independent of permissions and may outlive the preview.
    const pending = this.store.get(
      "SELECT 1 FROM web_character_preview_attempts WHERE state='known' AND shared_settled=0 LIMIT 1",
    );
    const at = Math.min(row?.due ?? Infinity, pending ? this.now() + 10_000 : Infinity);
    return Number.isFinite(at) ? at : null;
  }
  private async settle(row: Attempt) {
    if (row.shared_settled) return;
    ensure(
      row.state === 'known' && row.charged_micros !== null && row.receipt_json !== null,
      'PREVIEW_BILL_UNCONFIRMED',
    );
    await this.budget.settle(row.budget_id, row.fingerprint, row.charged_micros, JSON.parse(row.receipt_json));
    this.store.run(
      "UPDATE web_character_preview_attempts SET shared_settled=1 WHERE preview_id=? AND phase=? AND state='known'",
      row.preview_id,
      row.phase,
    );
  }
  async recoverBills() {
    const rows = this.store.all<Attempt>(
      "SELECT * FROM web_character_preview_attempts WHERE state='known' AND shared_settled=0 LIMIT 16",
    );
    for (const row of rows) await this.settle(row);
    return rows.length;
  }
  private reserve(id: string, token: string, spec: ProviderCallSpec, wireHash: string, bytes: number) {
    return this.store.transaction(() => {
      const { row } = this.live(id, token),
        now = this.now();
      ensure(
        spec.provider === 'deepseek' &&
          (spec.stage === 'draft' || spec.stage === 'review') &&
          spec.bounds.unit === 'tokens' &&
          natural(spec.bounds.inputTokens) &&
          natural(spec.bounds.outputTokens) &&
          /^[a-f0-9]{64}$/.test(wireHash) &&
          natural(bytes) &&
          bytes > 0,
        'PREVIEW_STAGE_INVALID',
      );
      ensure(!this.attempts(id).some((a) => a.phase === spec.stage), 'PREVIEW_ATTEMPT_UNRESOLVED');
      if (spec.stage === 'review')
        ensure(
          this.attempts(id).some(
            (a) => a.phase === 'draft' && a.state === 'known' && a.outcome === 'succeeded' && a.shared_settled === 1,
          ),
          'PREVIEW_OUTPUT_UNCONFIRMED',
        );
      const price = this.store.get<{ id: string; upper_micros_per_unit: number }>(
        `SELECT * FROM web_provider_prices
        WHERE provider='deepseek' AND phase=? AND model=? AND currency='USD' AND unit='token' AND valid_from<=? AND valid_until>?`,
        spec.stage,
        spec.model,
        now,
        now,
      );
      ensure(price, 'WEB_PROVIDER_PRICE_REQUIRED');
      const max = Math.min(spec.bounds.inputTokens, bytes) + spec.bounds.outputTokens,
        held = max * price.upper_micros_per_unit;
      ensure(natural(max) && max > 0 && natural(held) && held > 0, 'PREVIEW_STAGE_INVALID');
      ensure(
        this.store.run(
          `UPDATE web_external_budgets SET reserved=reserved+1
        WHERE provider='deepseek' AND stage='text' AND phase=? AND reserved<capacity`,
          spec.stage,
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
      const budgetId = JSON.stringify([instance.instance_id, 'admin-preview', id, spec.stage]);
      const fingerprint = budgetHash([
        row.memberId,
        row.sessionId,
        row.character_id,
        row.revision,
        row.profile_hash,
        row.request_digest,
        row.prompt_hash,
        wireHash,
        spec.model,
        price.id,
        max,
        held,
      ]);
      this.store.run(
        `INSERT INTO web_character_preview_attempts(preview_id,phase,budget_id,fingerprint,wire_hash,lease_token,model,price_id,
        max_units,held_micros,state,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,'intent',?)`,
        id,
        spec.stage,
        budgetId,
        fingerprint,
        wireHash,
        token,
        spec.model,
        price.id,
        max,
        held,
        now,
      );
      return this.attempts(id).find((a) => a.phase === spec.stage)!;
    });
  }
  private confirm(id: string, phase: Phase, observation: ProviderObservation, stage?: AcceptedV7StageOutput) {
    return this.store.transaction(() => {
      const attempt = this.attempts(id).find((a) => a.phase === phase),
        job = readWebPreview(this.store, id),
        usage = observation.usage;
      ensure(
        attempt &&
          ['sent', 'unknown'].includes(attempt.state) &&
          usage.unit === 'tokens' &&
          natural(usage.inputTokens) &&
          natural(usage.outputTokens),
        'PREVIEW_BILL_UNCONFIRMED',
      );
      const units = usage.inputTokens + usage.outputTokens;
      ensure(natural(units) && units <= attempt.max_units, 'PREVIEW_USAGE_INVALID');
      if (stage) {
        const meta = stage.metadata;
        ensure(
          observation.outcome === 'succeeded' &&
            stage.jobId === id &&
            stage.stage === phase &&
            stage.requestDigest === job.request_digest &&
            stage.policyHash === job.prompt_hash &&
            stage.wireRequestHash === attempt.wire_hash &&
            meta.stage === phase &&
            meta.model === attempt.model &&
            meta.status === 'succeeded' &&
            meta.usage?.inputTokens === usage.inputTokens &&
            meta.usage.outputTokens === usage.outputTokens &&
            meta.usage.totalTokens === units,
          'PREVIEW_STAGE_UNCONFIRMED',
        );
        const request = JSON.parse(job.request_json);
        if (phase === 'draft') parseTextDraft(stage.payload, request);
        else {
          const draft = this.known(id, 'draft');
          applyTextReview(stage.payload, parseTextDraft(draft.payload, request), request);
        }
      }
      const price = this.store.get<{ upper_micros_per_unit: number }>(
        'SELECT upper_micros_per_unit FROM web_provider_prices WHERE id=?',
        attempt.price_id,
      )!;
      const charged = units * price.upper_micros_per_unit,
        now = this.now();
      ensure(natural(charged) && charged <= attempt.held_micros, 'PREVIEW_USAGE_INVALID');
      const output = stage ? JSON.stringify(stage.payload) : null;
      this.store.run(
        `UPDATE web_character_preview_attempts SET state='known',outcome=?,charged_micros=?,receipt_json=?,
        output_json=?,output_hash=?,metadata_json=?,settled_at=? WHERE preview_id=? AND phase=?`,
        stage ? 'succeeded' : 'failed',
        charged,
        JSON.stringify(observation),
        output,
        output ? previewDigest(output) : null,
        stage ? JSON.stringify(stage.metadata) : null,
        now,
        id,
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
        'PREVIEW_BUDGET_CORRUPT',
      );
      ensure(
        this.store.run(
          `UPDATE web_external_budgets SET reserved=reserved-1
        WHERE provider='deepseek' AND stage='text' AND phase=? AND reserved>0`,
          phase,
        ).changes === 1,
        'PREVIEW_BUDGET_CORRUPT',
      );
      return this.attempts(id).find((a) => a.phase === phase)!;
    });
  }
  private known(id: string, phase: Phase) {
    const row = this.attempts(id).find((a) => a.phase === phase),
      job = readWebPreview(this.store, id);
    ensure(
      row?.state === 'known' &&
        row.outcome === 'succeeded' &&
        row.output_json &&
        row.metadata_json &&
        previewDigest(row.output_json) === row.output_hash,
      'PREVIEW_OUTPUT_UNCONFIRMED',
    );
    return {
      payload: JSON.parse(row.output_json),
      metadata: JSON.parse(row.metadata_json) as TextGenerationStage,
      requestDigest: job.request_digest,
      policyHash: job.prompt_hash,
    };
  }
  private commit(id: string, token: string) {
    return this.store.transaction(() => {
      const { request } = this.live(id, token),
        draft = this.known(id, 'draft'),
        review = this.known(id, 'review');
      ensure(
        this.attempts(id).every((a) => a.shared_settled === 1),
        'PREVIEW_BILL_UNCONFIRMED',
      );
      const reply = applyTextReview(review.payload, parseTextDraft(draft.payload, request), request);
      const stages = [draft.metadata, review.metadata];
      const usage = stages.reduce(
        (sum, stage) => ({
          inputTokens: sum.inputTokens + stage.usage!.inputTokens,
          outputTokens: sum.outputTokens + stage.usage!.outputTokens,
          totalTokens: sum.totalTokens + stage.usage!.totalTokens,
        }),
        { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      );
      const result: TextGenerationResult = {
        reply,
        provider: 'deepseek',
        model: draft.metadata.model!,
        requestId: review.metadata.requestId,
        elapsedMs: stages.reduce((sum, stage) => sum + stage.elapsedMs, 0),
        usage,
        stages,
      };
      this.store.run(
        "UPDATE admin_previews SET status='succeeded',finished_at=?,result_json=?,error_code=NULL WHERE id=?",
        this.now(),
        JSON.stringify(result),
        id,
      );
    });
  }
  async run(claim: { id: string; token: string }, signal: AbortSignal) {
    const { id, token } = claim,
      observations = new Map<Phase, ProviderObservation>();
    try {
      const { request } = this.live(id, token);
      for (const attempt of this.attempts(id)) {
        ensure(attempt.state === 'known' && attempt.outcome === 'succeeded', 'PREVIEW_ATTEMPT_UNRESOLVED');
        await this.settle(attempt);
        this.live(id, token);
      }
      if (this.attempts(id).some((a) => a.phase === 'review')) {
        this.commit(id, token);
        return;
      }
      const known = this.attempts(id).some((a) => a.phase === 'draft') ? this.known(id, 'draft') : null;
      const meter: ProviderMeter = {
        reserve: (specs) => {
          const expected = known ? ['review'] : ['draft', 'review'];
          ensure(
            specs.length === expected.length && specs.every((spec, i) => spec.stage === expected[i]),
            'PREVIEW_STAGE_INVALID',
          );
          return {
            start: async (phase, hash, bytes) => {
              ensure(
                !signal.aborted && (phase === 'draft' || phase === 'review') && hash && bytes,
                'PREVIEW_STAGE_INVALID',
              );
              const spec = specs.find((s) => s.stage === phase)!;
              const attempt = this.reserve(id, token, spec, hash, bytes);
              await this.budget.reserve(attempt.budget_id, 'deepseek', attempt.fingerprint, attempt.held_micros);
              this.store.transaction(() => {
                ensure(!signal.aborted, 'PREVIEW_INTERRUPTED');
                this.live(id, token);
                ensure(
                  this.store.run(
                    `UPDATE web_character_preview_attempts SET state='sent'
              WHERE preview_id=? AND phase=? AND lease_token=? AND state='intent'`,
                    id,
                    phase,
                    token,
                  ).changes === 1,
                  'PREVIEW_LEASE_STALE',
                );
              });
              return {
                finish: async (observation) => {
                  observations.set(phase, observation);
                  if (
                    observation.outcome !== 'succeeded' &&
                    observation.usage.unit === 'tokens' &&
                    natural(observation.usage.inputTokens) &&
                    natural(observation.usage.outputTokens)
                  )
                    await this.settle(this.confirm(id, phase, observation));
                },
              };
            },
            close: () => {},
          };
        },
      };
      const accept = async (stage: AcceptedV7StageOutput) => {
        const observation = observations.get(stage.stage);
        ensure(observation, 'PREVIEW_STAGE_UNCONFIRMED');
        // Known bills survive revocation/expiry. Authority is rechecked before any next send or success publication.
        await this.settle(this.confirm(id, stage.stage, observation, stage));
        ensure(!signal.aborted, 'PREVIEW_INTERRUPTED');
        this.live(id, token);
      };
      if (known) await this.generator.generateAcceptedReviewFromKnownDraft(request, signal, known, accept, meter);
      else await this.generator.generateAcceptedStages(request, signal, accept, meter);
      ensure(!signal.aborted, 'PREVIEW_INTERRUPTED');
      this.commit(id, token);
    } catch (error) {
      // A complete response with usage but no accepted payload is still a known failed bill.
      for (const attempt of this.attempts(id)) {
        const observation = observations.get(attempt.phase);
        if (
          attempt.lease_token === token &&
          attempt.state === 'sent' &&
          observation?.usage.unit === 'tokens' &&
          natural(observation.usage.inputTokens) &&
          natural(observation.usage.outputTokens)
        ) {
          try {
            await this.settle(this.confirm(id, attempt.phase, observation));
          } catch {
            /* Durable receipt/hold remains. */
          }
        }
      }
      this.store.transaction(() => {
        this.uncertain(id, token);
        const row = readWebPreview(this.store, id);
        if (row.lease_token !== token || row.status !== 'generating') return;
        const attempts = this.attempts(id);
        let retry =
          !signal.aborted &&
          attempts.length > 0 &&
          attempts.every((a) => a.state === 'known' && a.outcome === 'succeeded');
        try {
          currentWebPreview(this.store, this.now(), row);
        } catch {
          retry = false;
        }
        if (retry) {
          this.store.run("UPDATE admin_previews SET status='queued',lease_until=NULL WHERE id=?", id);
          this.store.run(
            'UPDATE web_character_preview_jobs SET retry_at=? WHERE preview_id=?',
            this.now() + 10_000,
            id,
          );
        } else
          this.fail(
            id,
            attempts.some((a) => a.state === 'unknown')
              ? 'PREVIEW_CALL_UNKNOWN'
              : error instanceof DomainError
                ? error.code
                : 'PREVIEW_GENERATION_FAILED',
          );
      });
    }
  }
}

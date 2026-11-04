import { createHash, randomUUID } from 'node:crypto';
import type { Clock, DialogueCandidate, TextGenerationRequest } from '../../../packages/contracts/index.ts';
import {
  COMPARE_MARKS,
  COMPARE_SIDE_LABELS,
  type CompareCaseResult,
  type CompareEstimate,
  type CompareMark,
  type CompareRunDetail,
  type CompareRunInfo,
  type CompareSide,
  type CompareSideResult,
  type CompareSummary,
  type CompareSummarySide,
} from '../../../packages/contracts/review-compare.ts';
import { hasCharacterPermission } from '../../../packages/contracts/web-admin-permissions.ts';
import { ensure } from '../../../packages/domain/errors.ts';
import type { BusinessStore } from '../platform/store-contract.ts';
import {
  applyTextReview,
  DROP_INVALID_METADATA,
  parseTextDraft,
  type TextDraft,
} from '../generation/accepted-text-protocol.ts';
import { promptMessages } from '../generation/accepted-text-prompt.ts';
import { DEEPSEEK_INPUT_RESERVATION } from '../generation/deepseek-usage.ts';
import { listPriceMicros } from '../generation/model-list-prices.ts';
import { outputBound } from '../generation/text-wire.ts';
import { previewDigest } from './web-character-preview.ts';
import { installReviewCompare } from './web-review-compare-schema.ts';
import {
  COMPARE_CASES,
  checkExpectations,
  compareRequest,
  quoteReport,
  type CompareCase,
} from './web-review-compare-cases.ts';
import { COMPARE_PHASE_MODEL, type CompareAttempt } from './web-review-compare-runner.ts';

/** Who may use it: the owner, or an administrator holding `preview` on every character (the 预演 permission). */
export interface CompareActor {
  memberId: string;
  sessionId: string;
}
const SIDE_PHASE = { pro: 'review_pro', flash: 'review_flash' } as const;
/** A fresh run may not start while another one still has cases queued or running. Same queue ceiling as 预演 runs (64). */
const QUEUE_CEILING = 64;
const REQUEST_ID = /^[A-Za-z0-9_.-]{8,64}$/;

/** About what one case costs: tokens estimated from the frozen request's size, at list price. A guide, not a promise. */
export function estimateCompare(): CompareEstimate {
  let typical = 0,
    hold = 0;
  COMPARE_CASES.forEach((c, i) => {
    const request = compareRequest(c, 'estimate', i + 1);
    const bytes = Buffer.byteLength(JSON.stringify(promptMessages(request)), 'utf8') + 3000;
    const inTokens = Math.ceil(bytes / 2);
    const draft = { inputTokens: inTokens, cachedInputTokens: 0, outputTokens: 250 };
    const review = { inputTokens: inTokens + 300, cachedInputTokens: 0, outputTokens: 600 };
    typical +=
      listPriceMicros('deepseek', COMPARE_PHASE_MODEL.draft, draft) +
      listPriceMicros('deepseek', COMPARE_PHASE_MODEL.review_pro, review) +
      listPriceMicros('deepseek', COMPARE_PHASE_MODEL.review_flash, review);
    // The ledger holds one call at a time; the dearest is the Pro review (4 micro-USD per token bound).
    hold = Math.max(hold, (Math.min(DEEPSEEK_INPUT_RESERVATION, bytes) + outputBound('deepseek', 4096)) * 4);
  });
  return { cases: COMPARE_CASES.length, calls: COMPARE_CASES.length * 3, typicalMicros: typical, holdMicros: hold };
}

const percentile = (values: number[], p: number) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;
};
const mean = (values: number[]) =>
  values.length === 0 ? null : Math.round(values.reduce((a, b) => a + b, 0) / values.length);

type MarkRow = { ordinal: number; side: CompareSide; mark: CompareMark };

/** Everything a side shows, computed from the stored stage outputs and nothing else. */
export function sideResult(
  def: CompareCase,
  request: TextGenerationRequest,
  draft: TextDraft | null,
  attempt: CompareAttempt | undefined,
  mark: CompareMark | null,
): CompareSideResult {
  const empty = (state: CompareSideResult['state'], errorCode: string | null): CompareSideResult => ({
    state,
    errorCode,
    bubbles: null,
    changed: null,
    needlessRewrite: false,
    quotes: { checked: 0, failed: 0 },
    expectations: [],
    latencyMs: null,
    tokens: null,
    costMicros: null,
    mark,
  });
  if (!attempt) return empty('pending', null);
  if (attempt.state !== 'known') return empty('unknown', 'CALL_UNKNOWN');
  const receipt = JSON.parse(attempt.receipt_json!) as {
    errorCode: string | null;
    usage: {
      unit: string;
      inputTokens: number | null;
      outputTokens: number | null;
      cacheHitInputTokens: number | null;
      cacheMissInputTokens: number | null;
    };
  };
  const usage = receipt.usage.unit === 'tokens' ? receipt.usage : null;
  const input = usage?.inputTokens ?? 0,
    out = usage?.outputTokens ?? 0,
    hit = usage?.cacheHitInputTokens ?? 0;
  const common = {
    latencyMs: attempt.latency_ms,
    tokens: usage ? { hit, miss: usage.cacheMissInputTokens ?? Math.max(0, input - hit), out } : null,
    costMicros: usage
      ? listPriceMicros('deepseek', attempt.model, { inputTokens: input, cachedInputTokens: hit, outputTokens: out })
      : null,
    mark,
  };
  const draftBubbles = draft?.bubbles ?? [];
  let final: DialogueCandidate | null = null;
  let raw: unknown = null;
  if (attempt.outcome === 'succeeded' && draft) {
    raw = JSON.parse(attempt.output_json!);
    final = applyTextReview(raw, draft, request, DROP_INVALID_METADATA);
  } else if (attempt.rejected_json) {
    try {
      raw = JSON.parse((JSON.parse(attempt.rejected_json) as { raw: string }).raw);
    } catch {
      raw = null;
    }
  }
  const checked = checkExpectations({ c: def, request, draft: draftBubbles, final, changed: !!final?.reviewChanged });
  return {
    state: final ? 'ok' : 'invalid',
    errorCode: final
      ? null
      : (receipt.errorCode ??
        (attempt.rejected_json
          ? (JSON.parse(attempt.rejected_json) as { errorCode: string }).errorCode
          : 'INVALID_OUTPUT')),
    bubbles: final ? final.bubbles.map((b) => b.text) : null,
    changed: final ? !!final.reviewChanged : null,
    needlessRewrite: checked.needlessRewrite,
    quotes: quoteReport(request, final, raw),
    expectations: checked.results,
    ...common,
  };
}

export function summarizeSide(cases: readonly CompareCaseResult[], side: CompareSide): CompareSummarySide {
  const results = cases.map((c) => c[side]);
  const known = results.filter((r) => r.state === 'ok' || r.state === 'invalid');
  const latencies = known.flatMap((r) => (r.latencyMs === null ? [] : [r.latencyMs]));
  const costs = known.flatMap((r) => (r.costMicros === null ? [] : [r.costMicros]));
  return {
    reviews: known.length,
    invalid: known.filter((r) => r.state === 'invalid').length,
    unknown: results.filter((r) => r.state === 'unknown').length,
    passed: known.reduce((n, r) => n + r.expectations.filter((e) => e.pass).length, 0),
    total: known.reduce((n, r) => n + r.expectations.length, 0),
    quoteChecked: known.reduce((n, r) => n + r.quotes.checked, 0),
    quoteFailures: known.reduce((n, r) => n + r.quotes.failed, 0),
    needlessRewrites: known.filter((r) => r.needlessRewrite).length,
    changed: known.filter((r) => r.changed).length,
    avgLatencyMs: mean(latencies),
    p90LatencyMs: percentile(latencies, 0.9),
    avgCostMicros: mean(costs),
  };
}
export const summarize = (cases: readonly CompareCaseResult[]): CompareSummary => ({
  pro: summarizeSide(cases, 'pro'),
  flash: summarizeSide(cases, 'flash'),
});

const dollars = (micros: number | null) => (micros === null ? '—' : `$${(micros / 1_000_000).toFixed(6)}`);
const percent = (n: number, d: number) => (d === 0 ? '—' : `${Math.round((n / d) * 1000) / 10}%`);
const ms = (v: number | null) => (v === null ? '—' : `${v} ms`);
/** The summary as plain text for pasting somewhere: no ids, no names, no model words. */
export function exportCompareText(detail: CompareRunDetail): string {
  const { summary, run } = detail;
  const row = (label: string, a: string | number, b: string | number) => `${label}\t${a}\t${b}`;
  const lines = [
    '审核模型对比：V4 Pro 与 V4.1 Flash',
    `日期：${new Date(run.createdAt).toISOString().slice(0, 10)}`,
    `用例：${run.cases} 个，已完成 ${run.done} 个，失败 ${run.failed} 个`,
    `本次花费：${dollars(run.chargedMicros)}（预算账本口径）`,
    '',
    ['指标', COMPARE_SIDE_LABELS.pro, COMPARE_SIDE_LABELS.flash].join('\t'),
    row(
      '通过率（期望结果）',
      percent(summary.pro.passed, summary.pro.total),
      percent(summary.flash.passed, summary.flash.total),
    ),
    row('无效输出', summary.pro.invalid, summary.flash.invalid),
    row(
      '引文不准确',
      `${summary.pro.quoteFailures}/${summary.pro.quoteChecked}`,
      `${summary.flash.quoteFailures}/${summary.flash.quoteChecked}`,
    ),
    row('多余改写', summary.pro.needlessRewrites, summary.flash.needlessRewrites),
    row('改写了草稿', summary.pro.changed, summary.flash.changed),
    row('平均耗时', ms(summary.pro.avgLatencyMs), ms(summary.flash.avgLatencyMs)),
    row('P90 耗时', ms(summary.pro.p90LatencyMs), ms(summary.flash.p90LatencyMs)),
    row('每次审核花费（官方标价）', dollars(summary.pro.avgCostMicros), dollars(summary.flash.avgCostMicros)),
    row('结果未知', summary.pro.unknown, summary.flash.unknown),
  ];
  const tally = (side: CompareSide) => {
    const marks = detail.cases.flatMap((c) => (c[side].mark ? [c[side].mark!] : []));
    return COMPARE_MARKS.map(
      (m) => `${m === 'better' ? '更好' : m === 'same' ? '一样' : '更差'} ${marks.filter((x) => x === m).length}`,
    ).join(' / ');
  };
  lines.push(row('人工标记', tally('pro'), tally('flash')));
  return lines.join('\n') + '\n';
}

export class WebReviewCompare {
  private readonly store: BusinessStore;
  private readonly clock: Clock;
  private readonly id: () => string;
  constructor(store: BusinessStore, clock: Clock, nextId: () => string = randomUUID) {
    this.store = store;
    this.clock = clock;
    this.id = nextId;
    installReviewCompare(store);
  }
  private now() {
    const now = this.clock.now();
    ensure(Number.isSafeInteger(now) && now >= 0, 'INVALID_TIME');
    return now;
  }
  /** Owner, or `preview` on every character; the session must be live. */
  private requireActor(actor: CompareActor, now: number) {
    const row = this.store.get<{ role: string; permissions_json: string }>(
      `SELECT m.role,m.permissions_json FROM web_admin_members m
      JOIN web_admin_session_members a ON a.member_id=m.id JOIN admin_sessions s ON s.id=a.session_id
      WHERE m.id=? AND s.id=? AND s.revoked_at IS NULL AND s.expires_at>?`,
      actor.memberId,
      actor.sessionId,
      now,
    );
    ensure(row, 'ADMIN_UNAUTHORIZED');
    ensure(
      row.role === 'owner' || hasCharacterPermission(JSON.parse(row.permissions_json), 'preview', '*'),
      'ADMIN_PERMISSION_REQUIRED',
    );
  }
  estimate() {
    return estimateCompare();
  }
  /**
   * Queues one run: every built-in case, in one transaction (a lost reply replays by requestId and cannot leave half a run). Paid
   * calls need the explicit confirmation of the number of calls shown to the administrator.
   */
  start(actor: CompareActor, input: unknown) {
    ensure(
      input &&
        typeof input === 'object' &&
        !Array.isArray(input) &&
        Object.keys(input).sort().join(',') === 'confirmPaidCalls,requestId',
      'INVALID_REQUEST',
    );
    const { requestId, confirmPaidCalls } = input as { requestId: unknown; confirmPaidCalls: unknown };
    ensure(typeof requestId === 'string' && REQUEST_ID.test(requestId), 'INVALID_REQUEST');
    const estimate = estimateCompare();
    const hash = createHash('sha256')
      .update(JSON.stringify([actor.memberId, 'review-compare', requestId]))
      .digest('hex');
    return this.store.transaction(() => {
      const now = this.now();
      this.requireActor(actor, now);
      const prior = this.store.get<{ id: string; request_hash: string }>(
        'SELECT id,request_hash FROM web_review_compare_runs WHERE request_id=?',
        requestId,
      );
      if (prior) {
        ensure(prior.request_hash === hash, 'IDEMPOTENCY_CONFLICT');
        return { runId: prior.id, replayed: true };
      }
      ensure(confirmPaidCalls === estimate.calls, 'PAID_CONFIRMATION_REQUIRED');
      ensure(
        !this.store.get("SELECT 1 FROM web_review_compare_cases WHERE status IN ('queued','generating') LIMIT 1"),
        'COMPARE_RUN_ACTIVE',
      );
      const queued = this.store.get<{ n: number }>(
        `SELECT count(*) n FROM admin_previews p JOIN web_character_preview_jobs j ON j.preview_id=p.id
        WHERE p.status IN ('queued','generating')`,
      );
      ensure((queued?.n ?? 0) + COMPARE_CASES.length <= QUEUE_CEILING, 'PREVIEW_QUEUE_FULL');
      const runId = this.id();
      ensure(/^[A-Za-z0-9_-]{1,128}$/.test(runId), 'INVALID_REQUEST');
      this.store.run(
        `INSERT INTO web_review_compare_runs(id,request_id,request_hash,member_id,session_id,case_count,estimated_micros,created_at)
        VALUES (?,?,?,?,?,?,?,?)`,
        runId,
        requestId,
        hash,
        actor.memberId,
        actor.sessionId,
        estimate.cases,
        estimate.typicalMicros,
        now,
      );
      COMPARE_CASES.forEach((c, index) => {
        const request = JSON.stringify(compareRequest(c, runId, index + 1));
        this.store.run(
          `INSERT INTO web_review_compare_cases(run_id,ordinal,case_key,request_json,request_digest,status,deadline_at,retry_at)
          VALUES (?,?,?,?,?,'queued',?,?)`,
          runId,
          index + 1,
          c.key,
          request,
          previewDigest(request),
          now + 1_200_000 + index * 180_000,
          now,
        );
      });
      this.store.run(
        'INSERT INTO web_admin_audit(actor_id,action,target_id,created_at) VALUES (?,?,?,?)',
        actor.memberId,
        'review-compare-queued',
        runId,
        now,
      );
      return { runId, replayed: false };
    });
  }

  list(): CompareRunInfo[] {
    return this.store
      .all<{ id: string; created_at: number }>(
        'SELECT id,created_at FROM web_review_compare_runs ORDER BY created_at DESC,id DESC LIMIT 20',
      )
      .map((run) => this.info(run.id)!);
  }
  private info(runId: string): CompareRunInfo | null {
    const run = this.store.get<{ id: string; created_at: number; case_count: number; estimated_micros: number }>(
      'SELECT * FROM web_review_compare_runs WHERE id=?',
      runId,
    );
    if (!run) return null;
    const count = (status: string) =>
      this.store.get<{ n: number }>(
        'SELECT count(*) n FROM web_review_compare_cases WHERE run_id=? AND status=?',
        runId,
        status,
      )!.n;
    const charged = this.store.get<{ n: number | null }>(
      "SELECT sum(charged_micros) n FROM web_review_compare_attempts WHERE run_id=? AND state='known'",
      runId,
    )!.n;
    return {
      runId,
      createdAt: run.created_at,
      cases: run.case_count,
      done: count('done'),
      failed: count('failed'),
      running: count('queued') + count('generating') > 0,
      estimatedMicros: run.estimated_micros,
      chargedMicros: charged ?? 0,
    };
  }

  /** The whole run, computed from the stored stage outputs. */
  detail(runId: unknown): CompareRunDetail {
    ensure(typeof runId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(runId), 'INVALID_REQUEST');
    const run = this.info(runId);
    ensure(run, 'NOT_FOUND');
    const rows = this.store.all<{
      ordinal: number;
      case_key: string;
      request_json: string;
      status: CompareCaseResult['status'];
      error_code: string | null;
    }>(
      'SELECT ordinal,case_key,request_json,status,error_code FROM web_review_compare_cases WHERE run_id=? ORDER BY ordinal',
      runId,
    );
    const attempts = this.store.all<CompareAttempt>('SELECT * FROM web_review_compare_attempts WHERE run_id=?', runId);
    const marks = this.store.all<MarkRow>(
      'SELECT ordinal,side,mark FROM web_review_compare_marks WHERE run_id=?',
      runId,
    );
    const cases = rows.map((row): CompareCaseResult => {
      const def = COMPARE_CASES.find((c) => c.key === row.case_key)!;
      const request = JSON.parse(row.request_json) as TextGenerationRequest;
      const mine = attempts.filter((a) => a.ordinal === row.ordinal);
      const draftAttempt = mine.find((a) => a.phase === 'draft');
      const draft =
        draftAttempt?.state === 'known' && draftAttempt.outcome === 'succeeded'
          ? parseTextDraft(JSON.parse(draftAttempt.output_json!), request)
          : null;
      const side = (s: CompareSide) =>
        sideResult(
          def,
          request,
          draft,
          mine.find((a) => a.phase === SIDE_PHASE[s]),
          marks.find((m) => m.ordinal === row.ordinal && m.side === s)?.mark ?? null,
        );
      return {
        ordinal: row.ordinal,
        group: def.group,
        title: def.title,
        input: def.messages,
        status: row.status,
        errorCode: row.error_code,
        draft: draft ? draft.bubbles.map((b) => b.text) : null,
        expected: def.expect.map((e) => e.label),
        pro: side('pro'),
        flash: side('flash'),
      };
    });
    return { run, summary: summarize(cases), cases };
  }

  /** Marks one side of one case 更好 / 一样 / 更差 (or clears it); saved with the run. Owner, or preview on every character. */
  mark(actor: CompareActor, input: unknown) {
    ensure(
      input &&
        typeof input === 'object' &&
        !Array.isArray(input) &&
        Object.keys(input).sort().join(',') === 'mark,ordinal,runId,side',
      'INVALID_REQUEST',
    );
    const { runId, ordinal, side, mark } = input as Record<string, unknown>;
    ensure(
      typeof runId === 'string' &&
        /^[A-Za-z0-9_-]{1,128}$/.test(runId) &&
        Number.isSafeInteger(ordinal) &&
        (side === 'pro' || side === 'flash') &&
        (mark === null || COMPARE_MARKS.includes(mark as CompareMark)),
      'INVALID_REQUEST',
    );
    return this.store.transaction(() => {
      const now = this.now();
      this.requireActor(actor, now);
      ensure(
        this.store.get('SELECT 1 FROM web_review_compare_cases WHERE run_id=? AND ordinal=?', runId, ordinal as number),
        'NOT_FOUND',
      );
      if (mark === null)
        this.store.run(
          'DELETE FROM web_review_compare_marks WHERE run_id=? AND ordinal=? AND side=?',
          runId,
          ordinal as number,
          side,
        );
      else
        this.store.run(
          `INSERT INTO web_review_compare_marks(run_id,ordinal,side,mark,member_id,updated_at) VALUES (?,?,?,?,?,?)
          ON CONFLICT(run_id,ordinal,side) DO UPDATE SET mark=excluded.mark,member_id=excluded.member_id,updated_at=excluded.updated_at`,
          runId,
          ordinal as number,
          side,
          mark as string,
          actor.memberId,
          now,
        );
      return { ordinal: ordinal as number, side, mark };
    });
  }

  exportText(runId: unknown) {
    return { text: exportCompareText(this.detail(runId)) };
  }
}

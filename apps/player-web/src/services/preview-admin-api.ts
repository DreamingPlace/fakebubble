import { speechAudio, speechClips, speechEstimate } from './speech-admin-api.ts';
import {
  COMPARE_MARKS,
  type CompareCaseResult,
  type CompareEstimate,
  type CompareMark,
  type CompareRunDetail,
  type CompareRunInfo,
  type CompareSide,
  type CompareSideResult,
  type CompareStartInput,
  type CompareSummarySide,
} from '../../../../packages/contracts/review-compare.ts';
/**
 * Client for the 预演测试 workbench (Part 13b): runs, per-preview detail, the batched status call and eval sets.
 * Strict about shape: anything the server did not promise is a protocol error, never rendered.
 */
export type Settlement = 'settled_known' | 'held_unknown' | 'released_unsent';
export type PreviewStatus = 'queued' | 'generating' | 'succeeded' | 'failed';
export type Bubble = { text: string; expression: string | null };
export type StageCost = {
  state: string;
  outcome: string | null;
  model: string;
  reservedMicros: number;
  chargedMicros: number | null;
  heldMicros: number;
  wallMs: number | null;
};
export type PreviewRow = {
  previewId: string;
  characterId: string;
  draftRevision: number;
  profileHash: string;
  status: PreviewStatus;
  errorCode: string | null;
  input: string | null;
  createdAt: number;
  finishedAt: number | null;
  runId: string | null;
  ordinal: number | null;
  note: string | null;
  simulatedTime: { time: string; timeZone: string } | null;
  settlement: Settlement | null;
  cost: { draft: StageCost | null; review: StageCost | null; chargedMicros: number; heldMicros: number };
  latency: { draftMs: number | null; reviewMs: number | null };
  final: {
    bubbles: Bubble[];
    mode: string | null;
    endsSession: boolean;
    reviewChanged: boolean;
    /** The reviewer said reject but gave publishable bubbles; they were published as an accept. */
    reviewDecisionNormalized?: boolean;
    coverage: { messageId: string; status: 'answered' | 'later' | 'needs_player' }[];
    topics: unknown[];
    factOps: unknown[];
  } | null;
};
export type PreviewDetail = PreviewRow & {
  draft: { mode: string | null; bubbles: Bubble[] | null } | null;
  review: {
    decision: string | null;
    replacementBubbles: Bubble[];
    coverage: Record<string, { status: string; supportQuote: string; missingInformation: string }> | null;
    topics: unknown[];
    factOps: unknown[];
  } | null;
  rejected: { phase: 'draft' | 'review'; errorCode: string; rawOutput: string; rawBytes: number; truncated: boolean }[];
  ids: {
    previewId: string;
    runId: string | null;
    budgetIds: { phase: string; budgetId: string }[];
    providerRequestIds: { phase: string; requestId: string }[];
  };
};
export type RunSummary = {
  runId: string;
  characterId: string;
  label: string | null;
  draftRevision: number;
  profileHash: string;
  relationship: string;
  simulatedTime: { time: string; timeZone: string } | null;
  timeZone: string;
  evalSet: { id: string; version: number } | null;
  itemCount: number;
  createdBy: string;
  createdAt: number;
  counts: Record<PreviewStatus, number>;
};
export type RunDetail = { run: RunSummary; previews: PreviewRow[] };
export type StatusEntry = {
  previewId: string;
  status: PreviewStatus;
  errorCode: string | null;
  runId: string | null;
  ordinal: number | null;
  finishedAt: number | null;
  settlement: Settlement | null;
};
export type EvalItem = { text: string; note: string | null };
export type EvalSet = {
  id: string;
  name: string;
  version: number;
  items: EvalItem[];
  updatedBy: string;
  updatedAt: number;
};
/** Which cast a 预演 reads (Part 24a): none, the published one, or the draft. Absent = the server's default. */
export type PreviewCastSource = 'none' | 'published' | 'draft';
export type RunInput = {
  requestId: string;
  draftRevision: number;
  profileHash: string;
  relationship: string;
  label?: string;
  simulatedTime?: string;
  castSource?: PreviewCastSource;
} & ({ inputs: EvalItem[] } | { evalSetId: string });

const invalid = () => new Error('ADMIN_PREVIEW_PROTOCOL_INVALID');
const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw invalid();
  return v as Record<string, unknown>;
};
const string = (v: unknown) => {
  if (typeof v !== 'string') throw invalid();
  return v;
};
const nstring = (v: unknown) => (v === null ? null : string(v));
const int = (v: unknown) => {
  if (!Number.isSafeInteger(v) || (v as number) < 0) throw invalid();
  return v as number;
};
const nint = (v: unknown) => (v === null ? null : int(v));
const rows = (v: unknown) => {
  if (!Array.isArray(v)) throw invalid();
  return v as unknown[];
};
const STATUSES: PreviewStatus[] = ['queued', 'generating', 'succeeded', 'failed'];
const status = (v: unknown) => {
  if (!STATUSES.includes(v as PreviewStatus)) throw invalid();
  return v as PreviewStatus;
};
const settlement = (v: unknown): Settlement | null => {
  if (v === null) return null;
  if (v !== 'settled_known' && v !== 'held_unknown' && v !== 'released_unsent') throw invalid();
  return v;
};
const bubbles = (v: unknown): Bubble[] =>
  rows(v).map((b) => {
    const r = object(b);
    return { text: string(r.text), expression: nstring(r.expression) };
  });
const sim = (v: unknown) => {
  if (v === null) return null;
  const r = object(v);
  return { time: string(r.time), timeZone: string(r.timeZone) };
};
const stage = (v: unknown): StageCost | null => {
  if (v === null) return null;
  const r = object(v);
  return {
    state: string(r.state),
    outcome: nstring(r.outcome),
    model: string(r.model),
    reservedMicros: int(r.reservedMicros),
    chargedMicros: nint(r.chargedMicros),
    heldMicros: int(r.heldMicros),
    wallMs: nint(r.wallMs),
  };
};
/** The short answer of review-start: what a just-queued single preview is, with the rest of the row empty until it is read again. */
export function previewStartRow(v: unknown): PreviewRow {
  const r = object(v);
  return {
    previewId: string(r.previewId),
    characterId: string(r.characterId),
    draftRevision: int(r.draftRevision),
    profileHash: string(r.profileHash),
    status: status(r.status),
    errorCode: nstring(r.errorCode),
    input: nstring(r.input),
    createdAt: int(r.createdAt),
    finishedAt: null,
    runId: null,
    ordinal: null,
    note: null,
    simulatedTime: null,
    settlement: null,
    cost: { draft: null, review: null, chargedMicros: 0, heldMicros: 0 },
    latency: { draftMs: null, reviewMs: null },
    final: null,
  };
}
export function previewRow(v: unknown): PreviewRow {
  const r = object(v),
    cost = object(r.cost),
    latency = object(r.latency);
  const f = r.final === null ? null : object(r.final);
  return {
    previewId: string(r.previewId),
    characterId: string(r.characterId),
    draftRevision: int(r.draftRevision),
    profileHash: string(r.profileHash),
    status: status(r.status),
    errorCode: nstring(r.errorCode),
    input: nstring(r.input),
    createdAt: int(r.createdAt),
    finishedAt: nint(r.finishedAt),
    runId: nstring(r.runId),
    ordinal: nint(r.ordinal),
    note: nstring(r.note),
    simulatedTime: sim(r.simulatedTime),
    settlement: settlement(r.settlement),
    cost: {
      draft: stage(cost.draft),
      review: stage(cost.review),
      chargedMicros: int(cost.chargedMicros),
      heldMicros: int(cost.heldMicros),
    },
    latency: { draftMs: nint(latency.draftMs), reviewMs: nint(latency.reviewMs) },
    final: f && {
      bubbles: bubbles(f.bubbles),
      mode: nstring(f.mode),
      endsSession: f.endsSession === true,
      reviewChanged: f.reviewChanged === true,
      reviewDecisionNormalized: f.reviewDecisionNormalized === true,
      coverage: rows(f.coverage).map((c) => {
        const x = object(c);
        const s = string(x.status);
        if (s !== 'answered' && s !== 'later' && s !== 'needs_player') throw invalid();
        return { messageId: string(x.messageId), status: s };
      }),
      topics: rows(f.topics),
      factOps: rows(f.factOps),
    },
  };
}
function previewDetail(v: unknown): PreviewDetail {
  const r = object(v);
  const draft = r.draft === null ? null : object(r.draft);
  const review = r.review === null ? null : object(r.review);
  const ids = object(r.ids);
  return {
    ...previewRow(v),
    draft: draft && { mode: nstring(draft.mode), bubbles: draft.bubbles === null ? null : bubbles(draft.bubbles) },
    review: review && {
      decision: nstring(review.decision),
      replacementBubbles: bubbles(review.replacementBubbles),
      coverage: review.coverage === null ? null : (object(review.coverage) as never),
      topics: rows(review.topics),
      factOps: rows(review.factOps),
    },
    rejected: rows(r.rejected).map((x) => {
      const o = object(x);
      const phase = string(o.phase);
      if (phase !== 'draft' && phase !== 'review') throw invalid();
      return {
        phase,
        errorCode: string(o.errorCode),
        rawOutput: string(o.rawOutput),
        rawBytes: int(o.rawBytes),
        truncated: o.truncated === true,
      };
    }),
    ids: {
      previewId: string(ids.previewId),
      runId: nstring(ids.runId),
      budgetIds: rows(ids.budgetIds).map((x) => ({
        phase: string(object(x).phase),
        budgetId: string(object(x).budgetId),
      })),
      providerRequestIds: rows(ids.providerRequestIds).map((x) => ({
        phase: string(object(x).phase),
        requestId: string(object(x).requestId),
      })),
    },
  };
}
function runSummary(v: unknown): RunSummary {
  const r = object(v),
    counts = object(r.counts),
    set = r.evalSet === null ? null : object(r.evalSet);
  return {
    runId: string(r.runId),
    characterId: string(r.characterId),
    label: nstring(r.label),
    draftRevision: int(r.draftRevision),
    profileHash: string(r.profileHash),
    relationship: string(r.relationship),
    simulatedTime: sim(r.simulatedTime),
    timeZone: string(r.timeZone),
    evalSet: set && { id: string(set.id), version: int(set.version) },
    itemCount: int(r.itemCount),
    createdBy: string(r.createdBy),
    createdAt: int(r.createdAt),
    counts: {
      queued: int(counts.queued),
      generating: int(counts.generating),
      succeeded: int(counts.succeeded),
      failed: int(counts.failed),
    },
  };
}
function evalSet(v: unknown): EvalSet {
  const r = object(v);
  return {
    id: string(r.id),
    name: string(r.name),
    version: int(r.version),
    items: rows(r.items).map((x) => ({ text: string(object(x).text), note: nstring(object(x).note) })),
    updatedBy: string(r.updatedBy),
    updatedAt: int(r.updatedAt),
  };
}

type Request = (path: string, body: Record<string, unknown>) => Promise<unknown>;
export class PreviewAdminClient {
  private readonly characters: Request;
  private readonly sets: Request;
  private readonly compare: Request | undefined;
  /** Part 26b: `compare` is the 审核对比 endpoint; without it the page simply has no such section. */
  constructor(characters: Request, sets: Request, compare?: Request) {
    this.characters = characters;
    this.sets = sets;
    this.compare = compare;
  }
  get reviewCompare() {
    return this.compare ? new ReviewCompareClient(this.compare) : null;
  }
  private call(id: string, action: string, body: Record<string, unknown> = {}) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw invalid();
    return this.characters(`${id}/${action}`, body);
  }
  /** Part 24k-1: what 试听 of a succeeded 预演 would cost (one call per final bubble), or why it is not offered. */
  async speechEstimate(id: string, previewId: string) {
    return speechEstimate(await this.call(id, 'speech-estimate', { kind: 'preview', previewId }));
  }
  /** 试听: speak the final bubbles (one confirmed cost, idempotent by requestId). */
  async listen(id: string, input: { requestId: string; previewId: string; acknowledgeMicros: number }) {
    return speechClips(await this.call(id, 'preview-listen', input));
  }
  /** The clips already spoken for a 预演 (playing them again costs nothing). */
  async clips(id: string, previewId: string) {
    return speechClips(await this.call(id, 'speech-clips', { previewId }));
  }
  async clipAudio(id: string, callId: string) {
    return speechAudio(await this.call(id, 'speech-audio', { callId }));
  }
  async startRun(id: string, input: RunInput) {
    const r = object(await this.call(id, 'run-start', input));
    return { runId: string(r.runId), replayed: r.replayed === true };
  }
  async startSingle(
    id: string,
    input: {
      requestId: string;
      draftRevision: number;
      profileHash: string;
      relationship: string;
      message: string;
      simulatedTime?: string;
      castSource?: PreviewCastSource;
    },
  ) {
    const r = object(await this.call(id, 'review-start', input));
    // The server answers a started single preview with the short start shape (no cost, latency or result rows yet); the full
    // row arrives with the next status read. Both shapes are accepted, so the row can be shown at once as 排队中.
    return 'cost' in r ? previewRow(r) : previewStartRow(r);
  }
  async list(id: string) {
    const r = object(await this.call(id, 'run-list'));
    return { runs: rows(r.runs).map(runSummary), singles: rows(r.singles).map(previewRow) };
  }
  async run(id: string, runId: string): Promise<RunDetail> {
    const r = object(await this.call(id, 'run-detail', { runId }));
    return { run: runSummary(r.run), previews: rows(r.previews).map(previewRow) };
  }
  async detail(id: string, previewId: string) {
    return previewDetail(await this.call(id, 'preview-detail', { previewId }));
  }
  /** The one polling call: statuses of a run's previews (runId given) or of the character's recent ones (null). */
  async status(id: string, runId: string | null) {
    const r = object(await this.call(id, 'previews-status', { runId }));
    return {
      previews: rows(r.previews).map((x): StatusEntry => {
        const o = object(x);
        return {
          previewId: string(o.previewId),
          status: status(o.status),
          errorCode: nstring(o.errorCode),
          runId: nstring(o.runId),
          ordinal: nint(o.ordinal),
          finishedAt: nint(o.finishedAt),
          settlement: settlement(o.settlement),
        };
      }),
      active: int(r.active),
    };
  }
  async evalSets() {
    return rows(object(await this.sets('list', {})).sets).map(evalSet);
  }
  async saveEvalSet(input: { id: string | null; expectedVersion: number | null; name: string; items: EvalItem[] }) {
    return evalSet(await this.sets('save', input));
  }
  async deleteEvalSet(id: string, expectedVersion: number) {
    await this.sets('delete', { id, expectedVersion });
  }
}

const COMPARE_STATES = ['ok', 'invalid', 'unknown', 'pending'];
const COMPARE_CASE_STATUSES = ['queued', 'generating', 'done', 'failed'];
const numberOrNull = (v: unknown) => (v === null ? null : int(v));
const strings = (v: unknown) => rows(v).map(string);
const compareSide = (v: unknown): CompareSideResult => {
  const o = object(v);
  if (!COMPARE_STATES.includes(o.state as string)) throw invalid();
  const quotes = object(o.quotes);
  const tokens = o.tokens === null ? null : object(o.tokens);
  const mark =
    o.mark === null
      ? null
      : COMPARE_MARKS.includes(o.mark as CompareMark)
        ? (o.mark as CompareMark)
        : (() => {
            throw invalid();
          })();
  return {
    state: o.state as CompareSideResult['state'],
    errorCode: nstring(o.errorCode),
    bubbles: o.bubbles === null ? null : strings(o.bubbles),
    changed: o.changed === null ? null : o.changed === true,
    needlessRewrite: o.needlessRewrite === true,
    quotes: { checked: int(quotes.checked), failed: int(quotes.failed) },
    expectations: rows(o.expectations).map((e) => {
      const x = object(e);
      return { label: string(x.label), pass: x.pass === true, detail: string(x.detail) };
    }),
    latencyMs: numberOrNull(o.latencyMs),
    tokens: tokens ? { hit: int(tokens.hit), miss: int(tokens.miss), out: int(tokens.out) } : null,
    costMicros: numberOrNull(o.costMicros),
    mark,
  };
};
const compareSummarySide = (v: unknown): CompareSummarySide => {
  const o = object(v);
  return {
    reviews: int(o.reviews),
    invalid: int(o.invalid),
    unknown: int(o.unknown),
    passed: int(o.passed),
    total: int(o.total),
    quoteChecked: int(o.quoteChecked),
    quoteFailures: int(o.quoteFailures),
    needlessRewrites: int(o.needlessRewrites),
    changed: int(o.changed),
    avgLatencyMs: numberOrNull(o.avgLatencyMs),
    p90LatencyMs: numberOrNull(o.p90LatencyMs),
    avgCostMicros: numberOrNull(o.avgCostMicros),
  };
};
const compareInfo = (v: unknown): CompareRunInfo => {
  const o = object(v);
  return {
    runId: string(o.runId),
    createdAt: int(o.createdAt),
    cases: int(o.cases),
    done: int(o.done),
    failed: int(o.failed),
    running: o.running === true,
    estimatedMicros: int(o.estimatedMicros),
    chargedMicros: int(o.chargedMicros),
  };
};
/** Part 26b: 审核对比. Strict parsing like the rest of this file: a shape that is not the documented one is rejected. */
export class ReviewCompareClient {
  private readonly call: Request;
  constructor(call: Request) {
    this.call = call;
  }
  async estimate(): Promise<CompareEstimate> {
    const o = object(await this.call('estimate', {}));
    return {
      cases: int(o.cases),
      calls: int(o.calls),
      typicalMicros: int(o.typicalMicros),
      holdMicros: int(o.holdMicros),
    };
  }
  async start(input: CompareStartInput) {
    const o = object(await this.call('start', input as unknown as Record<string, unknown>));
    return { runId: string(o.runId), replayed: o.replayed === true };
  }
  async list() {
    return rows(object(await this.call('list', {})).runs).map(compareInfo);
  }
  async detail(runId: string): Promise<CompareRunDetail> {
    const o = object(await this.call('detail', { runId }));
    const summary = object(o.summary);
    return {
      run: compareInfo(o.run),
      summary: { pro: compareSummarySide(summary.pro), flash: compareSummarySide(summary.flash) },
      cases: rows(o.cases).map((c): CompareCaseResult => {
        const x = object(c);
        if (!COMPARE_CASE_STATUSES.includes(x.status as string)) throw invalid();
        return {
          ordinal: int(x.ordinal),
          group: string(x.group),
          title: string(x.title),
          input: strings(x.input),
          status: x.status as CompareCaseResult['status'],
          errorCode: nstring(x.errorCode),
          draft: x.draft === null ? null : strings(x.draft),
          expected: strings(x.expected),
          pro: compareSide(x.pro),
          flash: compareSide(x.flash),
        };
      }),
    };
  }
  async mark(input: { runId: string; ordinal: number; side: CompareSide; mark: CompareMark | null }) {
    await this.call('mark', input as unknown as Record<string, unknown>);
  }
  async exportText(runId: string) {
    return string(object(await this.call('export', { runId })).text);
  }
}

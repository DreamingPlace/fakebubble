/**
 * Part 26b: the 审核对比 (reviewer comparison). Read models shared by the server and the 预演 page. Nothing here holds an id of
 * a player, an email, a nickname or an IP hash: the cases are synthetic, and a run is shown by its creation time only.
 */
export type CompareMark = 'better' | 'same' | 'worse';
export const COMPARE_MARKS: readonly CompareMark[] = ['better', 'same', 'worse'];
export const COMPARE_MARK_LABELS: Readonly<Record<CompareMark, string>> = Object.freeze({
  better: '更好',
  same: '一样',
  worse: '更差',
});
export type CompareSide = 'pro' | 'flash';
export const COMPARE_SIDES: readonly CompareSide[] = ['pro', 'flash'];
export const COMPARE_SIDE_LABELS: Readonly<Record<CompareSide, string>> = Object.freeze({
  pro: 'V4 Pro',
  flash: 'V4.1 Flash',
});

export interface CompareEstimate {
  cases: number;
  /** One draft and two reviews per case. */
  calls: number;
  /** About what the run will cost at list price, in micro-USD. */
  typicalMicros: number;
  /** The most the budget ledger can hold for the run at once (one case at a time), in micro-USD. */
  holdMicros: number;
}

export type CompareSideState = 'ok' | 'invalid' | 'unknown' | 'pending';
export interface CompareExpectation {
  label: string;
  pass: boolean;
  detail: string;
}
export interface CompareSideResult {
  state: CompareSideState;
  errorCode: string | null;
  /** The final bubbles after this reviewer, or null when it produced no valid output. */
  bubbles: string[] | null;
  changed: boolean | null;
  needlessRewrite: boolean;
  quotes: { checked: number; failed: number };
  expectations: CompareExpectation[];
  latencyMs: number | null;
  tokens: { hit: number; miss: number; out: number } | null;
  costMicros: number | null;
  mark: CompareMark | null;
}
export type CompareCaseStatus = 'queued' | 'generating' | 'done' | 'failed';
export interface CompareCaseResult {
  ordinal: number;
  group: string;
  title: string;
  input: string[];
  status: CompareCaseStatus;
  errorCode: string | null;
  draft: string[] | null;
  /** The expected outcomes, in words. */
  expected: string[];
  pro: CompareSideResult;
  flash: CompareSideResult;
}
export interface CompareSummarySide {
  /** Reviews that came back with a known result (valid or invalid). */
  reviews: number;
  invalid: number;
  unknown: number;
  passed: number;
  total: number;
  quoteChecked: number;
  quoteFailures: number;
  needlessRewrites: number;
  changed: number;
  avgLatencyMs: number | null;
  p90LatencyMs: number | null;
  avgCostMicros: number | null;
}
export interface CompareSummary {
  pro: CompareSummarySide;
  flash: CompareSummarySide;
}
export interface CompareRunInfo {
  runId: string;
  createdAt: number;
  cases: number;
  done: number;
  failed: number;
  running: boolean;
  estimatedMicros: number;
  /** What the run has been charged so far (budget ledger rate), in micro-USD. */
  chargedMicros: number;
}
export interface CompareRunDetail {
  run: CompareRunInfo;
  summary: CompareSummary;
  cases: CompareCaseResult[];
}
export interface CompareStartInput {
  requestId: string;
  /** The explicit paid-call confirmation: the number of paid calls the administrator was shown. */
  confirmPaidCalls: number;
}

export const compareRate = (side: CompareSummarySide) => (side.total === 0 ? null : side.passed / side.total);

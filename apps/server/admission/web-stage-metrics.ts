import type { BusinessStore } from '../platform/store-contract.ts';

/** Per-operation stage metrics. Written only by the business object; schema 114 (114_stage_metrics.sql). */
type Db = Pick<BusinessStore, 'get' | 'run'>;
export type FallbackReason = 'audio_wait' | 'rate_limited';

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const gap = (from: number | null, now: number) => (from === null ? 0 : Math.max(0, now - from));

/** The metrics tables exist (114_stage_metrics.sql applied); a database without them behaves exactly as before. */
const known = new WeakMap<object, boolean>();
export function metricsEnabled(store: Db): boolean {
  if (known.get(store)) return true;
  const present = !!store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_operation_metrics'");
  if (present) known.set(store, true);
  return present;
}
/**
 * The operation has sent (or completed) at least one audio segment to the provider: those segments are paid, so the
 * wait-time fallback no longer applies and the operation continues as voice. A segment returned to pending after an
 * HTTP 429 was never executed and does not count.
 */
export const audioStartedSql = (alias: string) =>
  `EXISTS (SELECT 1 FROM web_provider_voice_segments seg WHERE seg.operation_id=${alias}.id AND seg.state IN ('running','complete'))`;

/**
 * SQL fragment, empty before the metrics schema: true for an operation that has started audio. Such an operation is paid
 * for and is never expired by the summed queue wait (WEB_LIMITS.queueWaitMs); only its operation deadline ends it.
 */
export const audioStartedExpr = (store: Db, alias: string) => (metricsEnabled(store) ? audioStartedSql(alias) : '0');

function ensureRow(store: Db, operationId: string, now: number) {
  store.run('INSERT OR IGNORE INTO web_operation_metrics(operation_id,day) VALUES (?,?)', operationId, dayOf(now));
}

/** First text claim only; a retry after HTTP 429 keeps the original queue wait. */
export function recordTextClaim(store: Db, operationId: string, queuedAt: number, now: number) {
  if (!metricsEnabled(store)) return;
  ensureRow(store, operationId, now);
  store.run(
    `UPDATE web_operation_metrics SET text_started_at=coalesce(text_started_at,?),
      text_queue_wait_ms=coalesce(text_queue_wait_ms,?) WHERE operation_id=?`,
    now,
    gap(queuedAt, now),
    operationId,
  );
}
/** Text stage duration runs from the first claim to the committed reviewed candidate (backoff included). */
export function recordTextDone(store: Db, operationId: string, now: number) {
  if (!metricsEnabled(store)) return;
  ensureRow(store, operationId, now);
  store.run(
    `UPDATE web_operation_metrics SET text_stage_ms=max(0,?-text_started_at)
    WHERE operation_id=? AND text_started_at IS NOT NULL`,
    now,
    operationId,
  );
}
/** audio_queue_wait_ms is the cumulative time spent waiting for an audio slot (the operation's own accounting). */
export function recordAudioClaim(store: Db, operationId: string, now: number, waitUsedMs: number) {
  if (!metricsEnabled(store)) return;
  ensureRow(store, operationId, now);
  store.run(
    `UPDATE web_operation_metrics SET audio_started_at=coalesce(audio_started_at,?),audio_queue_wait_ms=?
    WHERE operation_id=?`,
    now,
    waitUsedMs,
    operationId,
  );
}
/** Audio stage duration: first audio claim to the latest finished segment (or the fallback decision). */
export function recordAudioProgress(store: Db, operationId: string, now: number) {
  if (!metricsEnabled(store)) return;
  ensureRow(store, operationId, now);
  store.run(
    `UPDATE web_operation_metrics SET audio_stage_ms=max(0,?-audio_started_at)
    WHERE operation_id=? AND audio_started_at IS NOT NULL`,
    now,
    operationId,
  );
}
export function recordRateLimitRetry(store: Db, operationId: string, stage: 'text' | 'audio', now: number) {
  if (!metricsEnabled(store)) return;
  ensureRow(store, operationId, now);
  store.run(
    `UPDATE web_operation_metrics SET ${stage}_rate_limit_retries=${stage}_rate_limit_retries+1 WHERE operation_id=?`,
    operationId,
  );
}
/** Durable decision: publish the reviewed text as text. The publication itself marks fallback_used. */
export function requestFallback(
  store: Db,
  operationId: string,
  reason: FallbackReason,
  now: number,
  waitMs?: number,
  discardedAudioSegments = 0,
) {
  ensureRow(store, operationId, now);
  store.run(
    `UPDATE web_operation_metrics SET fallback_reason=coalesce(fallback_reason,?),
      audio_queue_wait_ms=coalesce(?,audio_queue_wait_ms),
      discarded_audio_segments=CASE WHEN fallback_reason IS NULL THEN ? ELSE discarded_audio_segments END
      WHERE operation_id=?`,
    reason,
    waitMs ?? null,
    discardedAudioSegments,
    operationId,
  );
}
export function recordFallbackPublished(store: Db, operationId: string) {
  store.run(
    'UPDATE web_operation_metrics SET fallback_used=1 WHERE operation_id=? AND fallback_reason IS NOT NULL',
    operationId,
  );
}
export function fallbackRequested(store: Db, operationId: string): boolean {
  if (!metricsEnabled(store)) return false;
  return !!store.get(
    'SELECT 1 FROM web_operation_metrics WHERE operation_id=? AND fallback_reason IS NOT NULL AND fallback_used=0',
    operationId,
  );
}

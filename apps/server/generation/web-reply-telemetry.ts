import type { BusinessStore } from '../platform/store-contract.ts';

type Reader = Pick<BusinessStore, 'get' | 'all'>;
type ModelRef = { provider: string; model: string } | null;

/**
 * One structured line per finished reply (published, failed or UNKNOWN) for the staging model test. Enums, model names,
 * error codes, durations and a points count only: no id of any kind, no content, no principal, no IP. Read-only.
 */
export interface WebReplyLine {
  event: 'web_reply';
  outcome: 'published' | 'failed' | 'unknown';
  chosen: string | null;
  draft: ModelRef;
  review: ModelRef;
  backup: boolean;
  abandoned: string[];
  textMs: number | null;
  audioMs: number | null;
  voice: boolean;
  /**
   * Points taken at admission, 0 when no reply was published (the whole charge is refunded). For a published reply this is
   * before the backup-cheaper / no-voice adjustments, which are settled lazily at the player's next points check.
   */
  pointsCharged: number;
}

const has = (store: Reader, table: string) =>
  !!store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", table);

export function webReplyLine(store: Reader, operationId: string): WebReplyLine | null {
  const op = store.get<{ status: string }>('SELECT status FROM web_operations WHERE id=?', operationId);
  if (!op || !['published', 'failed', 'unknown'].includes(op.status)) return null;
  const outcome = op.status as WebReplyLine['outcome'];
  const model = has(store, 'web_operation_models')
    ? store.get<{
        chosen: string;
        voice: number;
        points_charged: number;
        draft_provider: string | null;
        draft_model: string | null;
        review_provider: string | null;
        review_model: string | null;
        backup: number;
      }>('SELECT * FROM web_operation_models WHERE operation_id=?', operationId)
    : undefined;
  const abandoned = has(store, 'web_provider_backups')
    ? store
        .all<{ code: string }>(
          'SELECT code FROM web_provider_backups WHERE operation_id=? ORDER BY phase,generation',
          operationId,
        )
        .map((row) => row.code)
    : [];
  const metrics = has(store, 'web_operation_metrics')
    ? store.get<{ text_stage_ms: number | null; audio_stage_ms: number | null }>(
        'SELECT text_stage_ms,audio_stage_ms FROM web_operation_metrics WHERE operation_id=?',
        operationId,
      )
    : undefined;
  const voiced =
    outcome === 'published' &&
    has(store, 'web_publication_items') &&
    !!store.get(
      "SELECT 1 FROM web_publication_items WHERE operation_id=? AND origin='narrative' AND media_id IS NOT NULL LIMIT 1",
      operationId,
    );
  const ref = (provider: string | null | undefined, name: string | null | undefined): ModelRef =>
    provider && name ? { provider, model: name } : null;
  return {
    event: 'web_reply',
    outcome,
    chosen: model?.chosen ?? null,
    draft: ref(model?.draft_provider, model?.draft_model),
    review: ref(model?.review_provider, model?.review_model),
    backup: (model?.backup ?? 0) === 1 || abandoned.length > 0,
    abandoned,
    textMs: metrics?.text_stage_ms ?? null,
    audioMs: metrics?.audio_stage_ms ?? null,
    voice: voiced,
    pointsCharged: outcome === 'published' ? (model?.points_charged ?? 0) : 0,
  };
}

/** Never throws: telemetry must not affect a reply. */
export function logWebReply(store: Reader, operationId: string): boolean {
  try {
    const line = webReplyLine(store, operationId);
    if (!line) return false;
    console.log(JSON.stringify(line));
    return true;
  } catch {
    return false;
  }
}

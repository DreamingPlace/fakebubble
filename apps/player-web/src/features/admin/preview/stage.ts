import type { PreviewRow } from '../../../services/preview-admin-api.ts';

/**
 * Part 24b-6c: where a preview line is, in the words the administrator watches: 排队中 → 生成草稿 → 审核中 → 完成 / 失败.
 * The status API only says queued / generating / succeeded / failed; the two halves of "generating" come from the row itself:
 * once the draft stage has a wall time (latency.draftMs) the draft is finished and the reviewer is working. Nothing here
 * calls the server; a row that has not been re-read yet simply keeps the coarser state.
 */
export type Stage = 'queued' | 'draft' | 'review' | 'done' | 'failed';
export const STAGE_LABEL: Record<Stage, string> = {
  queued: '排队中',
  draft: '生成草稿',
  review: '审核中',
  done: '完成',
  failed: '失败',
};
export const stageOf = (p: Pick<PreviewRow, 'status' | 'latency'>): Stage =>
  p.status === 'queued'
    ? 'queued'
    : p.status === 'succeeded'
      ? 'done'
      : p.status === 'failed'
        ? 'failed'
        : p.latency.draftMs !== null
          ? 'review'
          : 'draft';
export const isFinished = (p: Pick<PreviewRow, 'status'>) => p.status === 'succeeded' || p.status === 'failed';
/** "3 / 8 完成" (a finished line is done or failed), with the failures named. */
export const progressText = (finished: number, total: number, failed: number) =>
  `${finished} / ${total} 完成${failed ? ` · ${failed} 失败` : ''}`;

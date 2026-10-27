import { dateTimeText } from '../system-format.ts';
import type { PreviewRow, Settlement } from '../../../services/preview-admin-api.ts';
import type { BadgeTone } from '../ui/status-badge.ts';

export const STATUS_LABEL: Record<PreviewRow['status'], string> = {
  queued: '排队中',
  generating: '运行中',
  succeeded: '已通过',
  failed: '失败',
};
export const STATUS_TONE: Record<PreviewRow['status'], BadgeTone> = {
  queued: 'neutral',
  generating: 'info',
  succeeded: 'ok',
  failed: 'danger',
};
export const COVERAGE_LABEL = { answered: '已回答', later: '稍后续答', needs_player: '待玩家补充' } as const;
export const SETTLEMENT_LABEL: Record<Settlement, string> = {
  settled_known: '已按实际用量结算',
  held_unknown: '结果未知，额度保留',
  released_unsent: '未发送，无费用',
};
export const SETTLEMENT_TONE: Record<Settlement, BadgeTone> = {
  settled_known: 'ok',
  held_unknown: 'danger',
  released_unsent: 'neutral',
};
/**
 * What happened to the money, in words. This follows the settlement label the server derives from the ledger and
 * never the error code: a failure is usually a known bill settled at actual usage, and only an unknown call keeps its
 * reservation and may not be resent.
 */
export function settlementCopy(row: Pick<PreviewRow, 'status' | 'settlement' | 'cost'>): string {
  switch (row.settlement) {
    case 'settled_known':
      return `这次调用已按实际用量结算（${micros(row.cost.chargedMicros)}），是已知账单。修改后可直接重新预演；本页不会自动重发。`;
    case 'held_unknown':
      return '未知调用不能重发或释放：这次调用的结果未确认，预留额度会一直保留，本页不会重发。';
    case 'released_unsent':
      return '没有发出任何调用，没有产生费用，也没有预留额度。';
    default:
      return row.status === 'queued' ? '尚未发送。' : row.status === 'generating' ? '正在调用，结算后显示。' : '';
  }
}
/** micro-USD as a short string; 1 000 000 micro-USD = 1 USD. */
export function micros(value: number | null): string {
  if (value === null) return '—';
  if (value === 0) return '$0';
  return value >= 10_000 ? `$${(value / 1_000_000).toFixed(4)}` : `${value} µ$`;
}
export function seconds(ms: number | null): string {
  return ms === null ? '—' : `${(ms / 1000).toFixed(1)}s`;
}
const ERRORS: Record<string, string> = {
  INVALID_TOPICS: '审核返回的话题不合法（数量、键名、重要度或来源不符合要求）',
  INVALID_REVIEW_COVERAGE: '审核返回的覆盖判断不合法（引用的原句不在最终气泡中，或状态与字段不一致）',
  INVALID_REVIEW_SCHEMA: '审核返回的结构不符合要求',
  INVALID_DRAFT_SCHEMA: '草稿返回的结构不符合要求',
  INVALID_BUBBLES: '气泡数量或长度不符合要求',
  TEXT_REVIEW_REJECTED: '审核器拒绝了这条草稿',
  PREVIEW_CALL_UNKNOWN: '调用结果未知',
  PREVIEW_EXPIRED: '排队超时，未发送',
  PREVIEW_INTERRUPTED: '被中断',
  DRAFT_CONFLICT: '草稿在预演期间已变化，未发送',
};
export const errorText = (code: string | null) => (code ? `${ERRORS[code] ?? '失败'}（${code}）` : '');
/**
 * The zone a simulated time is read in is always the character's own schedule zone. A UTC+8 zone (every character
 * today) reads as “北京时间”; any other is shown by its IANA name and offset. The id is shown beside it in the form.
 */
export function zoneLabel(timeZone: string, at = Date.now()): string {
  try {
    const part = new Intl.DateTimeFormat('en', { timeZone, timeZoneName: 'shortOffset' })
      .formatToParts(at)
      .find((p) => p.type === 'timeZoneName')?.value;
    return part === 'GMT+8' ? '北京时间' : `${timeZone} ${part ?? ''}`.trim();
  } catch {
    return timeZone;
  }
}
/** The console's one time format: YYYY-MM-DD HH:mm UTC, whatever the browser's locale. */
export const when = (ms: number) => dateTimeText(ms);

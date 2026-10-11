import type { PreviewRow, RunDetail } from '../../../services/preview-admin-api.ts';
import { COVERAGE_LABEL, STATUS_LABEL } from './copy.ts';

export function runToJson(detail: RunDetail): string {
  return JSON.stringify(
    {
      run: detail.run,
      previews: detail.previews.map((p) => ({
        ordinal: p.ordinal,
        previewId: p.previewId,
        input: p.input,
        note: p.note,
        status: p.status,
        errorCode: p.errorCode,
        settlement: p.settlement,
        simulatedTime: p.simulatedTime,
        final: p.final,
        cost: p.cost,
        latency: p.latency,
      })),
    },
    null,
    2,
  );
}
/** A cell that a spreadsheet would read as a formula is prefixed so it stays text. */
const safe = (value: string) => (/^[=+\-@\t\r]/.test(value) ? `'${value}` : value);
const cell = (value: string | number | null) => {
  const text = safe(value === null ? '' : String(value));
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};
export const CSV_HEADER = [
  '#',
  '输入',
  '备注',
  '最终气泡',
  '表情',
  '状态',
  '错误码',
  '结算',
  '审核改动',
  '覆盖',
  '花费(微美元)',
  '草稿耗时(ms)',
  '审核耗时(ms)',
  '模拟时间',
];
export function previewCsvRow(p: PreviewRow): (string | number | null)[] {
  return [
    p.ordinal,
    p.input,
    p.note,
    p.final?.bubbles.map((b) => b.text).join('\n') ?? '',
    p.final?.bubbles.map((b) => b.expression ?? '').join('\n') ?? '',
    STATUS_LABEL[p.status],
    p.errorCode,
    p.settlement,
    p.final ? (p.final.reviewChanged ? '是' : '否') : '',
    p.final?.coverage.map((c) => COVERAGE_LABEL[c.status]).join('、') ?? '',
    p.cost.chargedMicros,
    p.latency.draftMs,
    p.latency.reviewMs,
    p.simulatedTime ? `${p.simulatedTime.time} ${p.simulatedTime.timeZone}` : '',
  ];
}
/** UTF-8 with a byte-order mark, CRLF rows: Excel opens Chinese text correctly. */
export function runToCsv(detail: RunDetail): string {
  const lines = [CSV_HEADER, ...detail.previews.map(previewCsvRow)].map((row) => row.map(cell).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}
export const exportName = (run: RunDetail['run'], ext: 'json' | 'csv') =>
  `preview-run-${run.runId.slice(0, 8)}-${new Date(run.createdAt).toISOString().slice(0, 10)}.${ext}`;
/** Hands text to the browser as a file. Nothing is uploaded and nothing is stored. */
export function downloadText(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', name);
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

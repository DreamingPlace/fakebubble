import type { BatchCodeView } from './web-invite-tiers.ts';

/** What a viewer who may not see a code reads in its place. Masking happens on the server; the browser never sees the code. */
export const MASKED_CODE = '********';
/** The text of a code created before Part 22a2: only its digest exists, so it can never be shown again. */
export const LEGACY_CODE_TEXT = '旧邀请码无法再次查看';

/** 状态 as the page and the CSV name it: 未使用 / 已兑换 / 已撤销 (an ended entitlement is a revoked code; an expired one was redeemed). */
export const stateLabel = (state: BatchCodeView['state']) =>
  state === 'unused' ? '未使用' : state === 'revoked' || state === 'ended' ? '已撤销' : '已兑换';

const two = (n: number) => String(n).padStart(2, '0');
/** 'YYYY-MM-DD HH:MM:SS' in UTC - the same wall clock for every administrator. */
export const utcDateTime = (at: number) => {
  const d = new Date(at);
  return `${d.toISOString().slice(0, 10)} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`;
};

/** The words of one code cell: the code, the mask, or the legacy notice. */
export const codeCellText = (row: Pick<BatchCodeView, 'code' | 'codeView'>) =>
  row.codeView === 'plain' ? row.code! : row.codeView === 'masked' ? MASKED_CODE : LEGACY_CODE_TEXT;

/**
 * One CSV cell (RFC 4180 quoting). A cell a spreadsheet could read as a formula (it starts with = + - @, or a tab / CR) gets a
 * leading TAB: Excel then keeps it as text, the cell still reads as the code, and the redeem box trims the tab when the code is
 * pasted back. (A code is base64url, so one in 64 begins with '-'.)
 */
export function csvCell(value: string) {
  const safe = /^[=+\-@\t\r]/.test(value) ? `\t${value}` : value;
  return /[",\r\n\t]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export const CSV_HEADER = ['序号', '邀请码', '状态', '兑换时间 (UTC)', '玩家编号', '额度到期'] as const;

/**
 * 导出表格: the batch's codes under the same masking rule as the page, with a UTF-8 BOM so Excel opens the Chinese correctly.
 * Columns: 序号, 邀请码, 状态, 兑换时间(UTC), 玩家编号, 额度到期(UTC). A redeemed code with no end date reads 无期限.
 */
export function inviteCodesCsv(rows: readonly BatchCodeView[]) {
  const lines = [
    [...CSV_HEADER],
    ...rows.map((row) => [
      String(row.serial),
      codeCellText(row),
      stateLabel(row.state),
      row.redeemedAt === null ? '' : utcDateTime(row.redeemedAt),
      row.playerNumber ?? (row.redeemedAt === null ? '' : '旧邀请'),
      row.redeemedAt === null ? '' : row.expiresAt === null ? '无期限' : utcDateTime(row.expiresAt),
    ]),
  ];
  return csvDocument(lines);
}

/** Lines of cells as one CSV document: a UTF-8 BOM first (Excel reads the Chinese correctly), CRLF line ends, every cell guarded by csvCell. */
export function csvDocument(lines: readonly (readonly string[])[]) {
  return `\uFEFF${lines.map((line) => line.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

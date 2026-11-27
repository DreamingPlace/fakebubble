/**
 * Part 57: 导出. One file of an export, built by the business object under the page's own permission and audited there. Nothing is
 * stored on the server; a table over 50,000 rows comes as several parts (`parts`), one file each.
 */
export const EXPORT_KINDS = [
  'conversations',
  'calls',
  'failures',
  'stats',
  'cocreation',
  'memes',
  'invites',
  'broadcast',
  'shares',
  'rehearsal',
  'feedback',
] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];
export type ExportFormat = 'csv' | 'xlsx';
export type ExportRequest = {
  kind: ExportKind;
  format: ExportFormat;
  /** From 1. */
  part: number;
  /** A CSV carries one table: which one (from 0). A workbook carries all of them. */
  sheet: number;
  filters: Record<string, unknown>;
};
export type ExportFile = {
  filename: string;
  mime: string;
  /** 'utf8': `content` is the text of the file (a CSV, BOM first). 'base64': the bytes of a .xlsx. */
  encoding: 'utf8' | 'base64';
  content: string;
  rows: number;
  part: number;
  parts: number;
};

const invalid = () => new Error('ADMIN_EXPORT_PROTOCOL_INVALID');
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
};
const count = (value: unknown) => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw invalid();
  return value as number;
};

export class ExportAdminClient {
  private readonly call: (path: string, body: Record<string, unknown>) => Promise<unknown>;
  constructor(call: (path: string, body: Record<string, unknown>) => Promise<unknown>) {
    this.call = call;
  }
  async allowed(): Promise<ExportKind[]> {
    const row = object(await this.call('allowed', {}));
    if (!Array.isArray(row.kinds)) throw invalid();
    return row.kinds.filter((kind): kind is ExportKind => EXPORT_KINDS.includes(kind as ExportKind));
  }
  async file(request: ExportRequest): Promise<ExportFile> {
    const row = object(await this.call('file', { ...request }));
    if (
      typeof row.filename !== 'string' ||
      typeof row.mime !== 'string' ||
      (row.encoding !== 'utf8' && row.encoding !== 'base64') ||
      typeof row.content !== 'string'
    )
      throw invalid();
    return {
      filename: row.filename,
      mime: row.mime,
      encoding: row.encoding,
      content: row.content,
      rows: count(row.rows),
      part: count(row.part),
      parts: count(row.parts),
    };
  }
}

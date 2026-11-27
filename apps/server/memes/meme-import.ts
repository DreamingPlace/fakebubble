import { inflateRawSync } from 'node:zlib';
import { DomainError, ensure } from '../../../packages/domain/errors.ts';
import {
  MEME_IMPORT_ROWS_MAX,
  type MemeImportPreview,
  type MemeImportRow,
  isKeptCategory,
  type MemeRowProblem,
} from '../../../packages/contracts/web-memes.ts';
import { memeProblem, memeText, queuedTerms, termStates } from './web-meme-library.ts';
import type { BusinessStore } from '../platform/store-contract.ts';

/**
 * Part 37c-1b: reading an upload. A CSV, a .xlsx or pasted rows (tab- or comma-separated) become rows of three columns - term, meaning,
 * category (any other column is ignored; the header row names them, in English or Chinese). Every row is then CHECKED, and every row
 * comes back with its status or its problem: nothing is dropped without being shown. Nothing here writes; the caller queues the rows
 * that passed (source 上传). Nothing goes straight into the library.
 *
 * Refusals of the whole file (no row is read): MEME_IMPORT_EMPTY, MEME_IMPORT_COLUMNS, MEME_IMPORT_TOO_MANY (more than 2,000 rows),
 * MEME_IMPORT_FILE (a .xlsx that cannot be read).
 */
export type MemeUpload = { kind: 'text'; text: string } | { kind: 'xlsx'; base64: string };

const HEADERS: Record<'term' | 'meaning' | 'category', readonly string[]> = {
  term: ['term', '词', '词条', '梗'],
  meaning: ['meaning', '释义', '含义', '解释'],
  category: ['category', '分类', '类别'],
};
const clean = (cell: string) => cell.replace(/^﻿/u, '').replace(/^\t+/u, '').trim();

/** CSV / TSV text into rows of cells (RFC 4180 quotes; a BOM and CRLF are fine). A tab in the first line means tab-separated. */
export function parseDelimited(text: string): string[][] {
  const body = text.replace(/^﻿/u, '');
  const first = body.split(/\r\n|\n|\r/u, 1)[0] ?? '';
  const sep = first.includes('\t') ? '\t' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (quoted) {
      if (ch === '"') {
        if (body[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === sep) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && body[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

// ---- .xlsx (a zip of XML; the first worksheet) ---------------------------------------------------------------------------------------
const XLSX_MAX_BYTES = 24 * 1024 * 1024;
function zipEntries(zip: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65_535); i--)
    if (zip.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  ensure(end >= 0, 'MEME_IMPORT_FILE');
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  for (let n = 0; n < count; n++) {
    ensure(zip.readUInt32LE(at) === 0x02014b50, 'MEME_IMPORT_FILE');
    const method = zip.readUInt16LE(at + 10);
    const packed = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    at += 46 + nameLength + extraLength + commentLength;
    if (!/^xl\/(?:worksheets\/sheet\d+\.xml|sharedStrings\.xml)$/u.test(name)) continue;
    ensure(zip.readUInt32LE(local) === 0x04034b50, 'MEME_IMPORT_FILE');
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(start, start + packed);
    ensure(method === 0 || method === 8, 'MEME_IMPORT_FILE');
    out.set(name, method === 0 ? data : inflateRawSync(data, { maxOutputLength: XLSX_MAX_BYTES }));
  }
  return out;
}
const unxml = (text: string) =>
  text
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&#(\d+);/gu, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/giu, (_, n: string) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&amp;/gu, '&');
const textRuns = (xml: string) =>
  [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/gu)].map((m) => unxml(m[1]!)).join('');
const columnIndex = (ref: string) => {
  let n = 0;
  for (const ch of ref.replace(/[0-9]/gu, '')) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};
export function parseXlsx(base64: string): string[][] {
  const zip = Buffer.from(base64, 'base64');
  ensure(zip.length > 0 && zip.length <= XLSX_MAX_BYTES, 'MEME_IMPORT_FILE');
  let files: Map<string, Buffer>;
  try {
    files = zipEntries(zip);
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError('MEME_IMPORT_FILE');
  }
  const sheetName = [...files.keys()]
    .filter((name) => name.startsWith('xl/worksheets/'))
    .sort((a, b) => Number(/(\d+)\.xml$/u.exec(a)![1]) - Number(/(\d+)\.xml$/u.exec(b)![1]))[0];
  ensure(sheetName, 'MEME_IMPORT_FILE');
  const shared = files.has('xl/sharedStrings.xml')
    ? [
        ...files
          .get('xl/sharedStrings.xml')!
          .toString('utf8')
          .matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/gu),
      ].map((m) => textRuns(m[1]!))
    : [];
  const rows: string[][] = [];
  const sheet = files.get(sheetName)!.toString('utf8');
  for (const rowMatch of sheet.matchAll(/<row(?:\s[^>]*)?>([\s\S]*?)<\/row>/gu)) {
    const cells: string[] = [];
    for (const cell of rowMatch[1]!.matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/gu)) {
      const attrs = cell[1]!;
      const ref = /\br="([A-Z]+)\d+"/u.exec(attrs)?.[1];
      const type = /\bt="([^"]*)"/u.exec(attrs)?.[1];
      const inner = cell[2] ?? '';
      const value = /<v>([\s\S]*?)<\/v>/u.exec(inner)?.[1];
      const text =
        type === 's'
          ? (shared[Number(value)] ?? '')
          : type === 'inlineStr'
            ? textRuns(inner)
            : value !== undefined
              ? unxml(value)
              : textRuns(inner);
      cells[ref ? columnIndex(ref) : cells.length] = text;
    }
    rows.push(Array.from(cells, (cell) => cell ?? ''));
  }
  return rows;
}

// ---- reading the rows ---------------------------------------------------------------------------------------------------------------
export interface RawRow {
  row: number;
  term: string;
  meaning: string;
  category: string;
}
/** The data rows of an upload (the header is row 1; trailing blank lines are not rows). */
export function readUpload(upload: MemeUpload): RawRow[] {
  const table = upload.kind === 'xlsx' ? parseXlsx(upload.base64) : parseDelimited(upload.text);
  while (table.length && table.at(-1)!.every((cell) => clean(cell) === '')) table.pop();
  ensure(table.length > 0, 'MEME_IMPORT_EMPTY');
  const header = table[0]!.map((cell) => clean(cell).toLowerCase());
  const at = (name: keyof typeof HEADERS) => header.findIndex((cell) => HEADERS[name].includes(cell));
  const [term, meaning, category] = [at('term'), at('meaning'), at('category')];
  ensure(term >= 0 && meaning >= 0 && category >= 0, 'MEME_IMPORT_COLUMNS');
  ensure(table.length - 1 > 0, 'MEME_IMPORT_EMPTY');
  ensure(table.length - 1 <= MEME_IMPORT_ROWS_MAX, 'MEME_IMPORT_TOO_MANY');
  return table.slice(1).map((cells, i) => ({
    row: i + 2,
    term: memeText(clean(cells[term] ?? '')),
    meaning: memeText(clean(cells[meaning] ?? '')),
    category: memeText(clean(cells[category] ?? '')),
  }));
}

/** Every row of an upload with its status against the library as it is now (a read: nothing is written). */
export function previewUpload(store: Pick<BusinessStore, 'get' | 'all'>, upload: MemeUpload): MemeImportPreview {
  const raw = readUpload(upload);
  const stateOf = termStates(store);
  const waiting = queuedTerms(store);
  const seen = new Set<string>();
  const rows: MemeImportRow[] = raw.map((row): MemeImportRow => {
    const fold = row.term.normalize('NFKC').toLowerCase();
    const state = stateOf(row.term);
    const existing = state.kind === 'live' || state.kind === 'deleted-shipped' ? state.entry : null;
    // A row for a term that exists may keep the category the entry has now (an export carries drop reasons); a different one must
    // be one of the five like any new row.
    const keepsCategory = existing !== null && row.category === existing.category;
    const problem: MemeRowProblem | null =
      memeProblem(row, keepsCategory || (existing !== null && isKeptCategory(row.category))) ??
      (seen.has(fold) ? 'DUPLICATE_IN_FILE' : null);
    const shown = existing ? { meaning: existing.meaning, category: existing.category } : null;
    const base = { row: row.row, term: row.term, meaning: row.meaning, category: row.category, existing: shown };
    if (problem) return { ...base, status: 'invalid', problem };
    seen.add(fold);
    if (state.kind === 'live' && state.entry.meaning === row.meaning && state.entry.category === row.category)
      return { ...base, status: 'unchanged', problem: null };
    if (waiting.has(fold)) return { ...base, status: 'queued', problem: null };
    if (state.kind === 'deleted-shipped' || state.kind === 'deleted-own')
      return { ...base, status: 'revive', problem: null };
    return { ...base, status: state.kind === 'live' ? 'update' : 'ok', problem: null };
  });
  const counts = { ok: 0, update: 0, revive: 0, unchanged: 0, queued: 0, invalid: 0 };
  for (const row of rows) counts[row.status]++;
  return { rows, counts };
}

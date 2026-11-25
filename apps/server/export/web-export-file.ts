import { deflateRawSync } from 'node:zlib';
import { csvDocument } from '../invites/web-invite-export.ts';

/**
 * Part 57: the file side of every export. A table is a header and rows of text / numbers; this module turns it into a CSV (UTF-8 with a
 * BOM, the invite export's formula guard) or a .xlsx workbook (hand-written OOXML in a zip: no library, no file on the server).
 * Nothing here knows what a row means, so nothing here can leak a column: the builders choose the columns.
 */
export type Cell = string | number | null;
/** `file` is the ASCII word a CSV's file name carries for this table (a browser may drop a name with Chinese in it). */
export type Sheet = { name: string; file?: string; header: readonly string[]; rows: readonly (readonly Cell[])[] };
export type ExportFormat = 'csv' | 'xlsx';
/** Rows per file. A bigger table is split into parts (the page asks for part 1, 2, 3 ... one file each). */
export const ROWS_PER_PART = 50_000;
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const CSV_MIME = 'text/csv';

export type RenderedExport = {
  filename: string;
  mime: string;
  /** 'utf8' = `content` is the file's text (a CSV, BOM first); 'base64' = the bytes of a .xlsx. */
  encoding: 'utf8' | 'base64';
  content: string;
  /** Data rows in THIS file, and the number of files the whole export takes. */
  rows: number;
  part: number;
  parts: number;
};

const text = (cell: Cell) => (cell === null ? '' : String(cell));

// ---- CSV ------------------------------------------------------------------------------------------------------------------
export const csvOf = (sheet: Pick<Sheet, 'header' | 'rows'>) =>
  csvDocument([[...sheet.header], ...sheet.rows.map((row) => row.map(text))]);

// ---- xlsx -----------------------------------------------------------------------------------------------------------------
/** Characters XML 1.0 cannot carry are dropped (a control character in a cell would make Excel refuse the whole file). */
const xmlText = (value: string) =>
  value
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to remove them
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
const columnName = (index: number) => {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
};
const sheetName = (name: string, index: number) => {
  const clean = name
    .replace(/[[\]:*?/\\]/g, ' ')
    .trim()
    .slice(0, 31);
  return clean === '' ? `表${index + 1}` : clean;
};
/** One worksheet: strings are inline strings (never a formula), numbers are numbers, the header row is bold (style 1). */
function sheetXml(sheet: Pick<Sheet, 'header' | 'rows'>) {
  const cell = (value: Cell, column: number, row: number, style: boolean) => {
    const at = `${columnName(column)}${row}`;
    if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${at}"><v>${value}</v></c>`;
    if (value === null || value === '') return '';
    return `<c r="${at}" t="inlineStr"${style ? ' s="1"' : ''}><is><t xml:space="preserve">${xmlText(String(value))}</t></is></c>`;
  };
  const out: string[] = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>',
    '<sheetData>',
    `<row r="1">${sheet.header.map((value, column) => cell(value, column, 1, true)).join('')}</row>`,
  ];
  sheet.rows.forEach((row, at) => {
    out.push(`<row r="${at + 2}">${row.map((value, column) => cell(value, column, at + 2, false)).join('')}</row>`);
  });
  out.push('</sheetData></worksheet>');
  return out.join('');
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
export function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A zip of deflated files (a fixed 1980-01-01 time stamp: the same table always gives the same bytes). */
export function zipFiles(files: readonly { name: string; data: Uint8Array }[]) {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const packed = deflateRawSync(file.data);
    const crc = crc32(file.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x0021, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, packed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(0, 12);
    entry.writeUInt16LE(0x0021, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(file.data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += local.length + name.length + packed.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBytes, end]);
}

export function xlsxOf(sheets: readonly Pick<Sheet, 'name' | 'header' | 'rows'>[]) {
  const names = sheets.map((sheet, index) => sheetName(sheet.name, index));
  const utf8 = (value: string) => Buffer.from(value, 'utf8');
  const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  return zipFiles([
    {
      name: '[Content_Types].xml',
      data: utf8(
        `${head}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets
          .map(
            (_, i) =>
              `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
          )
          .join('')}</Types>`,
      ),
    },
    {
      name: '_rels/.rels',
      data: utf8(
        `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
      ),
    },
    {
      name: 'xl/workbook.xml',
      data: utf8(
        `${head}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names
          .map((name, i) => `<sheet name="${xmlText(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
          .join('')}</sheets></workbook>`,
      ),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: utf8(
        `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
          .map(
            (_, i) =>
              `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
          )
          .join(
            '',
          )}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
      ),
    },
    {
      name: 'xl/styles.xml',
      data: utf8(
        `${head}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>`,
      ),
    },
    ...sheets.map((sheet, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: utf8(sheetXml(sheet)) })),
  ]);
}

// ---- parts ----------------------------------------------------------------------------------------------------------------
/** The number of files an export takes: a CSV is one sheet, a workbook carries every sheet, so it takes as many as its longest. */
export function partCount(format: ExportFormat, sheets: readonly Sheet[], sheet: number) {
  const longest =
    format === 'csv' ? (sheets[sheet]?.rows.length ?? 0) : Math.max(0, ...sheets.map((s) => s.rows.length));
  return Math.max(1, Math.ceil(longest / ROWS_PER_PART));
}

/** The file for one part (1-based): rows (part-1)*50,000 ... of each sheet. `base` is the file name without extension. */
export function renderExport(
  format: ExportFormat,
  base: string,
  sheets: readonly Sheet[],
  input: { part: number; sheet: number },
): RenderedExport {
  const parts = partCount(format, sheets, input.sheet);
  const part = Math.min(Math.max(1, input.part), parts);
  const from = (part - 1) * ROWS_PER_PART;
  const slice = (sheet: Sheet): Sheet => ({ ...sheet, rows: sheet.rows.slice(from, from + ROWS_PER_PART) });
  const suffix = parts > 1 ? `-${part}of${parts}` : '';
  if (format === 'csv') {
    const chosen = slice(sheets[input.sheet] ?? sheets[0]!);
    const label =
      sheets.length > 1 ? `-${chosen.file ?? `table${sheets.indexOf(sheets[input.sheet] ?? sheets[0]!) + 1}`}` : '';
    return {
      filename: `${base}${label}${suffix}.csv`,
      mime: CSV_MIME,
      encoding: 'utf8',
      content: csvOf(chosen),
      rows: chosen.rows.length,
      part,
      parts,
    };
  }
  const slices = sheets.map(slice);
  return {
    filename: `${base}${suffix}.xlsx`,
    mime: XLSX_MIME,
    encoding: 'base64',
    content: xlsxOf(slices).toString('base64'),
    rows: slices.reduce((n, s) => n + s.rows.length, 0),
    part,
    parts,
  };
}

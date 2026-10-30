export type Piece = { kind: 'same' | 'del' | 'add'; text: string };
/** Code-point LCS diff of two short strings; adjacent pieces of one kind are merged. */
export function diffText(before: string, after: string): Piece[] {
  const a = [...before],
    b = [...after];
  const m = a.length,
    n = b.length;
  const table: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
  const out: Piece[] = [];
  const push = (kind: Piece['kind'], text: string) => {
    const last = out.at(-1);
    if (last?.kind === kind) last.text += text;
    else out.push({ kind, text });
  };
  let i = 0,
    j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      push('same', a[i]!);
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) push('del', a[i++]!);
    else push('add', b[j++]!);
  }
  while (i < m) push('del', a[i++]!);
  while (j < n) push('add', b[j++]!);
  return out;
}
/**
 * Draft bubbles against final bubbles, by position. A bubble only in the draft was removed by the review, a bubble
 * only in the final was added; a changed one carries a character diff.
 */
export function diffBubbles(draft: readonly string[], final: readonly string[]) {
  const rows: Array<{ index: number; before: string | null; after: string | null; pieces: Piece[] }> = [];
  for (let i = 0; i < Math.max(draft.length, final.length); i++) {
    const before = draft[i] ?? null,
      after = final[i] ?? null;
    rows.push({
      index: i,
      before,
      after,
      pieces:
        before !== null && after !== null
          ? diffText(before, after)
          : before !== null
            ? [{ kind: 'del', text: before }]
            : [{ kind: 'add', text: after ?? '' }],
    });
  }
  return rows;
}

/** One row of a side-by-side diff: what the left column shows and what the right one does (null = nothing on that side). */
export type SideRow = { left: Piece[] | null; right: Piece[] | null; changed: boolean };
const SMALL_LINE = 400;
/**
 * Two texts line by line, side by side. Equal lines are on both sides; a removed line is only on the left, an added line only on
 * the right, and a removed line that sits right before an added one is its pair (shown on one row, with the characters that changed
 * marked inside both). `context` lines of equal text are kept around each change, the rest folds into one "…" row.
 */
export function diffSideBySide(before: string, after: string, context = 2): SideRow[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const m = a.length;
  const n = b.length;
  const table: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
  const rows: SideRow[] = [];
  let i = 0;
  let j = 0;
  const gone: string[] = [];
  const came: string[] = [];
  const flush = () => {
    const pairs = Math.max(gone.length, came.length);
    for (let k = 0; k < pairs; k++) {
      const x = gone[k];
      const y = came[k];
      if (x !== undefined && y !== undefined && x.length <= SMALL_LINE && y.length <= SMALL_LINE) {
        const pieces = diffText(x, y);
        rows.push({
          left: pieces.filter((p) => p.kind !== 'add'),
          right: pieces.filter((p) => p.kind !== 'del'),
          changed: true,
        });
      } else
        rows.push({
          left: x === undefined ? null : [{ kind: 'del', text: x }],
          right: y === undefined ? null : [{ kind: 'add', text: y }],
          changed: true,
        });
    }
    gone.length = 0;
    came.length = 0;
  };
  while (i < m || j < n) {
    if (i < m && j < n && a[i] === b[j]) {
      flush();
      rows.push({ left: [{ kind: 'same', text: a[i]! }], right: [{ kind: 'same', text: b[j]! }], changed: false });
      i++;
      j++;
    } else if (j >= n || (i < m && table[i + 1]![j]! >= table[i]![j + 1]!)) gone.push(a[i++]!);
    else came.push(b[j++]!);
  }
  flush();
  const keep = rows.map(
    (row, at) => row.changed || rows.slice(Math.max(0, at - context), at + context + 1).some((r) => r.changed),
  );
  const out: SideRow[] = [];
  rows.forEach((row, at) => {
    if (keep[at]) out.push(row);
    else if (out.at(-1)?.left?.[0]?.text !== '…')
      out.push({ left: [{ kind: 'same', text: '…' }], right: [{ kind: 'same', text: '…' }], changed: false });
  });
  return out;
}

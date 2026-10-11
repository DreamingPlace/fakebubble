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

import type { PreviewRow } from '../../../services/preview-admin-api.ts';

export type CompareRow = { input: string; a: PreviewRow | null; b: PreviewRow | null };
const key = (p: PreviewRow) => (p.input ?? '').trim();
/**
 * Two runs side by side, matched by input text. A text that appears twice in one run is matched in order; a text only
 * one run has shows an empty side. Order: run A's order first, then the inputs only B has.
 */
export function compareRuns(a: readonly PreviewRow[], b: readonly PreviewRow[]): CompareRow[] {
  const pool = new Map<string, PreviewRow[]>();
  for (const row of b) pool.set(key(row), [...(pool.get(key(row)) ?? []), row]);
  const out: CompareRow[] = [];
  for (const row of a) out.push({ input: key(row), a: row, b: pool.get(key(row))?.shift() ?? null });
  for (const rest of pool.values()) for (const row of rest) out.push({ input: key(row), a: null, b: row });
  return out;
}

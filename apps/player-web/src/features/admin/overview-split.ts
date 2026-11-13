import type { ChartMetric, ChartView } from '../../../../../packages/contracts/web-stats.ts';
import { colourOfName } from './ui/character-colour.ts';

/**
 * Part 24b-7e: the 总览 split. One series per character (in its 主色) or per chosen text model, over the same buckets as the 全部 chart.
 * The 6 largest over the range are kept; the rest are summed bucket by bucket into 其他 (neutral grey). Nothing is invented: a series
 * is exactly a row of the chart read (`ChartView.characters` / `.models`), a bucket the counters did not run for stays null.
 */
export type Split = 'all' | 'character' | 'model';
export const SPLITS: ReadonlyArray<{ id: Split; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'character', label: '按角色' },
  { id: 'model', label: '按模型' },
];
export const SHOWN_SERIES = 6;
export const OTHER_NAME = '其他';
export const OTHER_COLOUR = '#C9C2B8';
export const NO_MODEL_NAME = '未选择模型';
/** Roster colours dealt to a character the roster does not know (a stub, a deleted character), in order. */
const FALLBACK_CHARACTER = ['#1D4ED8', '#B45309', '#BE185D', '#0E7490', '#4D7C0F', '#6D28D9'];
/** One neutral categorical palette for models: desaturated, so it never reads as a character's colour. */
export const MODEL_COLOURS = ['#3F4E5E', '#7A6F5A', '#5B7C74', '#8A6E8F', '#6B7F9A', '#9A7B5B'] as const;

export type SplitSeries = {
  /** Unique within the split (the name; models use their id). */
  id: string;
  name: string;
  color: string;
  values: (number | null)[];
  /** The other series summed (其他). */
  other?: boolean;
};
export type SplitData = { series: SplitSeries[]; buckets: string[]; total: (number | null)[]; hourly: boolean };

const sumOf = (values: readonly (number | null)[]) => values.reduce<number>((a, b) => a + (b ?? 0), 0);
export const modelName = (model: string) => (model === '' ? NO_MODEL_NAME : model);

/** The split of a chart read; null when this read carries no such series (the caller says why). */
export function buildSplit(view: ChartView, split: Exclude<Split, 'all'>): SplitData | null {
  const rows = split === 'character' ? view.characters : view.models;
  if (!rows) return null;
  const ranked = rows
    .map((row) => ({ id: row.name, name: split === 'model' ? modelName(row.name) : row.name, values: [...row.values] }))
    .sort((a, b) => sumOf(b.values) - sumOf(a.values));
  const shown = ranked.slice(0, SHOWN_SERIES).map(
    (row, index): SplitSeries => ({
      ...row,
      color:
        split === 'character'
          ? (colourOfName(row.name) ?? FALLBACK_CHARACTER[index % FALLBACK_CHARACTER.length]!)
          : MODEL_COLOURS[index % MODEL_COLOURS.length]!,
    }),
  );
  const rest = ranked.slice(SHOWN_SERIES);
  if (rest.length)
    shown.push({
      id: OTHER_NAME,
      name: OTHER_NAME,
      color: OTHER_COLOUR,
      other: true,
      values: view.buckets.map((_, i) =>
        rest.every((row) => row.values[i] === null || row.values[i] === undefined)
          ? null
          : rest.reduce((a, row) => a + (row.values[i] ?? 0), 0),
      ),
    });
  return { series: shown, buckets: view.buckets, total: [...view.total], hourly: view.bucket === 'hour' };
}

/** What a legend or pie shows for one series: replies add up over the range; players do not (a player is in several buckets). */
export function figureOf(metric: ChartMetric, values: readonly (number | null)[]): number | null {
  if (metric === 'replies') return values.every((v) => v === null) ? null : sumOf(values);
  for (let i = values.length - 1; i >= 0; i--) if (values[i] !== null && values[i] !== undefined) return values[i]!;
  return null;
}

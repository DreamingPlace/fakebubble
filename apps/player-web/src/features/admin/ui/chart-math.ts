/**
 * Chart arithmetic with no DOM: the axis ceiling, its gridlines and the number formats. Kept apart so the scale rules can be
 * tested with plain numbers.
 */

/** A "nice" number at or above `value`: 1, 2, 2.5, 5 or 10 times a power of ten. */
export function niceUp(value: number): number {
  if (!(value > 0)) return 1;
  const exponent = 10 ** Math.floor(Math.log10(value));
  const fraction = value / exponent;
  const step = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
  return step * exponent;
}

/** Headroom above the tallest value, so the top of a line or bar never touches the frame. */
export const HEADROOM = 1.12;

/** The axis ceiling for a tallest value: rounded up to a nice number after the headroom. An empty chart is 1 high. */
export const niceCeiling = (peak: number): number => niceUp(peak * HEADROOM);

/**
 * The gridline values from 0 to `top`, evenly spaced and round: four spans normally, five when the ceiling starts with a 2.5 or
 * a 5 (so the labels read 0.5, 1, 1.5 … and never 1.25 or 0.625).
 */
export function axisTicks(top: number): number[] {
  const exponent = 10 ** Math.floor(Math.log10(top));
  const lead = Math.round((top / exponent) * 10) / 10;
  const spans = lead === 2.5 || lead === 5 ? 5 : 4;
  return Array.from({ length: spans + 1 }, (_, i) => (top / spans) * i);
}

/**
 * Dollar axis labels. With the gridline values at hand every label gets the same number of decimals (none when every gridline is a whole
 * dollar: $0 $5 $10; otherwise cents: $0.00 $0.50 $1.00); alone, a value gets cents under $1 and whole dollars above.
 */
export const dollarLabel = (value: number, ticks?: readonly number[]): string => {
  if (!ticks)
    return `$${value < 1 ? value.toFixed(2) : value < 10 ? value.toFixed(1).replace(/\.0$/, '') : Math.round(value)}`;
  const decimals = ticks.every((t) => Math.abs(t - Math.round(t)) < 1e-9) ? 0 : 2;
  return `$${value.toFixed(decimals)}`;
};
/** Count axis labels: whole numbers, or a decimal for the rare ceiling below 5. */
export const countLabel = (value: number, _ticks?: readonly number[]): string =>
  Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, '');

/** A line drawn in a viewBox of `width` × `height`: an SVG path, with a gap (a new "M") wherever a value is missing. */
export function linePath(values: readonly (number | null)[], top: number, width: number, height: number): string {
  const last = Math.max(1, values.length - 1);
  let pen = false;
  const parts: string[] = [];
  values.forEach((value, index) => {
    if (value === null) {
      pen = false;
      return;
    }
    const x = ((index / last) * width).toFixed(1);
    const y = (height - (Math.min(value, top) / top) * height).toFixed(1);
    parts.push(`${pen ? 'L' : 'M'}${x},${y}`);
    pen = true;
  });
  return parts.join(' ');
}

/** The tallest value a chart has to show: stacked bars add the visible series up, lines look at the single highest one. */
export function peakOf(series: ReadonlyArray<readonly (number | null)[]>, stacked: boolean): number {
  const length = Math.max(0, ...series.map((values) => values.length));
  let peak = 0;
  for (let i = 0; i < length; i++) {
    const column = series.map((values) => values[i] ?? 0);
    const height = stacked ? column.reduce((sum, value) => sum + value, 0) : Math.max(0, ...column);
    if (height > peak) peak = height;
  }
  return peak;
}

/** A conic-gradient for shares of a whole (CSS custom property value). */
export function conicGradient(parts: ReadonlyArray<{ color: string; value: number }>): string {
  const total = parts.reduce((sum, part) => sum + part.value, 0);
  if (total <= 0) return 'conic-gradient(#efebe6 0 360deg)';
  let from = 0;
  const stops = parts
    .filter((part) => part.value > 0)
    .map((part) => {
      const to = from + (part.value / total) * 360;
      const stop = `${part.color} ${from.toFixed(2)}deg ${to.toFixed(2)}deg`;
      from = to;
      return stop;
    });
  return `conic-gradient(${stops.join(', ')})`;
}

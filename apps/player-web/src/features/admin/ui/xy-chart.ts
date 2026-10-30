import { axisTicks, linePath, niceCeiling, peakOf } from './chart-math.ts';
import { bindTip } from './tooltip.ts';

/**
 * The console's one chart: stacked bars or lines over the same buckets, with an axis that scales itself. The DOM is built once and
 * then only its custom properties change, so a new scale slides the gridlines and the bars (CSS transitions) instead of jumping.
 * Colours and sizes travel as custom properties (the CSP has no inline styles). Counts and money only.
 */
export type XySeries = {
  id: string;
  name: string;
  color: string;
  values: readonly (number | null)[];
  /** Hidden series stay in the DOM (so they can come back with a transition) but draw nothing and take no part in the scale. */
  on: boolean;
  /** A thinner dashed line, for a total drawn over the parts. */
  total?: boolean;
};
export type XyMarker = { index: number; label: string };
export type XyState = {
  mode: 'bar' | 'line';
  series: readonly XySeries[];
  /** One label per bucket (hover text); `ticks` are the ones printed under the axis. */
  buckets: readonly string[];
  ticks: ReadonlyArray<{ index: number; label: string }>;
  /** The y-axis label of a gridline, and the text of a value in a hover. */
  axisLabel: (value: number, ticks: readonly number[]) => string;
  valueLabel: (value: number) => string;
  /** A reference line (in the same unit as the values); drawn only when it lies inside the current scale. */
  alert?: number | null;
  markers?: readonly XyMarker[];
  ariaLabel: string;
  /**
   * Part 24b-6: the lines of the hover bubble of one bucket (its label first, then every value at full precision). Default: the
   * bucket label and each visible series with `valueLabel`.
   */
  tipLines?: (index: number) => readonly string[];
};
export type XyScale = { top: number; ticks: number[]; alertShown: boolean };

export const GRID_SLOTS = 6;
const NS = 'http://www.w3.org/2000/svg';
const VIEW = { width: 640, height: 230 };
const percent = (value: number) => `${Math.max(0, Math.min(100, value)).toFixed(3)}%`;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) => {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

export function xyChart() {
  const root = el('div', 'xy ad-tip-bounds');
  const plot = el('div', 'xy-plot');
  const grid = Array.from({ length: GRID_SLOTS }, () => {
    const line = el('div', 'xy-grid is-off');
    const label = el('span', 'xy-grid-label');
    line.append(label);
    plot.append(line);
    return { line, label };
  });
  const alertLine = el('div', 'xy-alert is-off');
  alertLine.append(el('span', 'xy-alert-label'));
  plot.append(alertLine);
  const layer = el('div', 'xy-layer');
  const markerHost = el('div', 'xy-markers');
  const hits = el('div', 'xy-hits');
  const guide = el('div', 'xy-guide');
  const tip = el('span', 'ad-tip xy-tip');
  plot.append(layer, markerHost, guide, hits, tip);
  bindTip(plot, tip);
  const axis = el('div', 'xy-x');
  root.append(plot, axis);

  let built = '';
  let bars: HTMLElement[][] = [];
  let paths: SVGPathElement[] = [];
  let dots: HTMLElement[][] = [];
  let last: XyState | null = null;

  const identity = (state: XyState) =>
    `${state.mode}|${state.buckets.length}|${state.series.map((s) => s.id).join(',')}`;

  function build(state: XyState) {
    built = identity(state);
    bars = [];
    paths = [];
    if (state.mode === 'bar') {
      const row = el('div', 'xy-bars');
      for (let i = 0; i < state.buckets.length; i++) {
        const bar = el('div', 'xy-bar');
        bar.style.setProperty('--i', String(i));
        const stack = el('div', 'xy-stack');
        const segments = state.series.map((series) => {
          const seg = el('div', 'xy-seg');
          seg.style.setProperty('--c', series.color);
          seg.style.setProperty('--h', '0%');
          stack.append(seg);
          return seg;
        });
        bars.push(segments);
        bar.append(stack);
        row.append(bar);
      }
      layer.replaceChildren(row);
    } else {
      const svg = document.createElementNS(NS, 'svg') as unknown as SVGSVGElement;
      svg.setAttribute('class', 'xy-lines');
      svg.setAttribute('viewBox', `0 0 ${VIEW.width} ${VIEW.height}`);
      svg.setAttribute('preserveAspectRatio', 'none');
      svg.setAttribute('aria-hidden', 'true');
      for (const series of state.series) {
        const path = document.createElementNS(NS, 'path') as unknown as SVGPathElement;
        path.setAttribute('class', `xy-path${series.total ? ' is-total' : ''}`);
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', series.color);
        path.setAttribute('stroke-linejoin', 'round');
        path.setAttribute('stroke-linecap', 'round');
        path.setAttribute('vector-effect', 'non-scaling-stroke');
        svg.append(path);
        paths.push(path);
      }
      layer.replaceChildren(svg);
    }
    dots = [];
    hits.replaceChildren(
      ...state.buckets.map((_, i) => {
        // Every bucket is one hover (and keyboard) target: a column through the points of all its series.
        const hit = el('div', 'xy-hit');
        hit.style.setProperty('--i', String(i));
        hit.setAttribute('tabindex', '0');
        hit.setAttribute('role', 'img');
        hit.addEventListener('pointerenter', () => activate(i));
        hit.addEventListener('focus', () => {
          activate(i);
          const box = plot.getBoundingClientRect?.();
          const at = hit.getBoundingClientRect?.();
          if (box && at) {
            tip.style.setProperty('--tip-x', `${Math.max(0, Math.round(at.left - box.left + at.width / 2 + 10))}px`);
            tip.style.setProperty('--tip-y', '24px');
          }
        });
        dots.push(
          state.mode === 'line'
            ? state.series.map((series) => {
                const dot = el('i', 'xy-dot');
                dot.style.setProperty('--c', series.color);
                hit.append(dot);
                return dot;
              })
            : [],
        );
        return hit;
      }),
    );
  }

  /** The bubble and the guide line follow the bucket under the pointer (or focus). */
  function activate(index: number) {
    const state = last;
    if (!state) return;
    const count = state.buckets.length;
    const at = state.mode === 'bar' ? (index + 0.5) / count : index / Math.max(1, count - 1);
    guide.style.setProperty('--gx', percent(at * 100));
    const lines = state.tipLines?.(index) ?? [
      state.buckets[index]!,
      ...state.series
        .filter((series) => series.on)
        .map(
          (series) => `${series.name} ${series.values[index] == null ? '—' : state.valueLabel(series.values[index]!)}`,
        ),
    ];
    tip.replaceChildren(
      ...lines.map((line, k) => {
        const row = el('span', k === 0 ? 'xy-tip-head' : 'xy-tip-row', line);
        return row;
      }),
    );
  }

  /** Paints a state: builds the DOM when the shape changed, otherwise only moves the custom properties. */
  function update(state: XyState, replay = false): XyScale {
    if (identity(state) !== built) build(state);
    // A fresh dataset (another metric or range) draws itself in again: two identical animations take turns, so the browser restarts it.
    if (replay) layer.setAttribute('data-draw', layer.getAttribute('data-draw') === 'a' ? 'b' : 'a');
    last = state;
    const visible = state.series.filter((series) => series.on);
    const peak = peakOf(
      visible.map((series) => series.values),
      state.mode === 'bar',
    );
    const top = niceCeiling(peak);
    const ticks = axisTicks(top);
    grid.forEach((slot, i) => {
      const tick = ticks[i];
      slot.line.classList.toggle('is-off', tick === undefined);
      if (tick === undefined) return;
      slot.line.style.setProperty('--y', percent((tick / top) * 100));
      slot.label.textContent = state.axisLabel(tick, ticks);
    });
    const alertShown = state.alert != null && state.alert > 0 && state.alert <= top;
    alertLine.classList.toggle('is-off', !alertShown);
    if (alertShown) {
      alertLine.style.setProperty('--y', percent((state.alert! / top) * 100));
      alertLine.querySelector('.xy-alert-label')!.textContent = state.axisLabel(state.alert!, ticks);
    }
    const count = state.buckets.length;
    if (state.mode === 'bar') {
      bars.forEach((segments, i) => {
        segments.forEach((seg, k) => {
          const series = state.series[k]!;
          const value = series.on ? (series.values[i] ?? 0) : 0;
          seg.style.setProperty('--h', percent((value / top) * 100));
        });
      });
    } else {
      state.series.forEach((series, k) => {
        const path = paths[k]!;
        path.setAttribute('d', series.on ? linePath(series.values, top, VIEW.width, VIEW.height) : '');
        path.classList.toggle('is-off', !series.on);
      });
    }
    markerHost.replaceChildren(
      ...(state.markers ?? [])
        .filter((marker) => marker.index >= 0 && marker.index < count)
        .map((marker) => {
          const node = el('div', 'xy-marker');
          const at = state.mode === 'bar' ? (marker.index + 0.5) / count : marker.index / Math.max(1, count - 1);
          node.style.setProperty('--x', percent(at * 100));
          node.append(el('span', 'xy-marker-label', marker.label));
          return node;
        }),
    );
    axis.replaceChildren(
      ...state.ticks.map((tick) => {
        const label = el('span', 'xy-x-label', tick.label);
        const at = state.mode === 'bar' ? (tick.index + 0.5) / count : tick.index / Math.max(1, count - 1);
        label.style.setProperty('--x', percent(at * 100));
        return label;
      }),
    );
    // Hover text per bucket: the bubble is built when a bucket is entered; the column also carries it as its accessible name.
    const columns = hits.querySelectorAll<HTMLElement>('.xy-hit');
    columns.forEach((hit, i) => {
      const lines = state.tipLines?.(i) ?? [
        state.buckets[i]!,
        ...visible.map(
          (series) => `${series.name} ${series.values[i] == null ? '—' : state.valueLabel(series.values[i]!)}`,
        ),
      ];
      hit.setAttribute('aria-label', lines.join(' · '));
      if (state.mode === 'line') {
        // A column through the point, kept inside the plot at both ends.
        const at = (i / Math.max(1, count - 1)) * 100;
        const half = 50 / Math.max(1, count - 1);
        const left = Math.max(0, at - half);
        hit.style.setProperty('--px', percent(left));
        hit.style.setProperty('--w', percent(Math.min(100, at + half) - left));
        hit.style.setProperty('--dot', percent(((at - left) / Math.max(0.001, Math.min(100, at + half) - left)) * 100));
        state.series.forEach((series, k) => {
          const value = series.on ? series.values[i] : null;
          const dot = dots[i]?.[k];
          if (!dot) return;
          dot.classList.toggle('is-off', value == null);
          if (value != null) dot.style.setProperty('--y', percent((Math.min(value, top) / top) * 100));
        });
      }
    });
    root.dataset.dense = String(count > 31);
    root.setAttribute('role', 'img');
    root.setAttribute('aria-label', state.ariaLabel);
    root.dataset.mode = state.mode;
    return { top, ticks, alertShown };
  }

  return {
    root,
    update,
    /** The last state painted, for the hover text and the tests. */
    get state() {
      return last;
    },
  };
}

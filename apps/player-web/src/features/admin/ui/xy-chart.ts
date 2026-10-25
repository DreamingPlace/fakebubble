import { axisTicks, linePath, niceCeiling, peakOf } from './chart-math.ts';

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
  axisLabel: (value: number) => string;
  valueLabel: (value: number) => string;
  /** A reference line (in the same unit as the values); drawn only when it lies inside the current scale. */
  alert?: number | null;
  markers?: readonly XyMarker[];
  ariaLabel: string;
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
  const root = el('div', 'xy');
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
  plot.append(layer, markerHost, hits);
  const axis = el('div', 'xy-x');
  root.append(plot, axis);

  let built = '';
  let bars: HTMLElement[][] = [];
  let paths: SVGPathElement[] = [];
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
    hits.replaceChildren(
      ...state.buckets.map((_, i) => {
        const hit = el('div', 'xy-hit');
        hit.style.setProperty('--i', String(i));
        return hit;
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
      slot.label.textContent = state.axisLabel(tick);
    });
    const alertShown = state.alert != null && state.alert > 0 && state.alert <= top;
    alertLine.classList.toggle('is-off', !alertShown);
    if (alertShown) {
      alertLine.style.setProperty('--y', percent((state.alert! / top) * 100));
      alertLine.querySelector('.xy-alert-label')!.textContent = state.axisLabel(state.alert!);
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
    // Hover text per bucket: its label and every visible series' value.
    const columns = hits.querySelectorAll<HTMLElement>('.xy-hit');
    columns.forEach((hit, i) => {
      const values = visible
        .map((series) => `${series.name} ${series.values[i] == null ? '—' : state.valueLabel(series.values[i]!)}`)
        .join(' · ');
      hit.setAttribute('title', `${state.buckets[i]}${values ? ` · ${values}` : ''}`);
    });
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

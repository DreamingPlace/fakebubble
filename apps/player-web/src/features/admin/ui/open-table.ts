import { h } from '../../cocreation/h.ts';
import { hoverValue } from './hover-value.ts';

/**
 * Part 24b-6: the "click a row → its detail opens directly BELOW that row, full table width" layout (Framework3, B).
 * A grid table: one header row, one row per record, and under a clicked row a panel that grows by height and fades in (240 ms;
 * the chevron turns). A second click closes it; one row is open at a time per table. Cells may carry a hover value.
 */
export type OpenColumn<T> = {
  key: string;
  label: string;
  /** CSS grid track, default 1fr. */
  width?: string;
  align?: 'end';
  cell: (row: T) => string | Node;
  /** The exact value shown in the light bubble on hover / focus. */
  tip?: (row: T) => string | null | undefined;
  /** Column header hover (what the column means). */
  headTip?: string;
  mono?: boolean;
};
export type OpenTableOptions<T> = {
  label: string;
  /** Extra classes of the table (a page's own sizing). */
  className?: string;
  columns: readonly OpenColumn<T>[];
  rowKey: (row: T) => string;
  /** Builds the detail. Without it a row is plain (no chevron, not clickable). */
  detail?: (row: T, close: () => void) => Node | Promise<Node>;
  emptyText: string;
  /** A checkbox column (compare, bulk). Its changes are reported with the chosen keys. */
  tick?: { label: string; max?: number; onChange: (keys: string[]) => void };
  rowClass?: (row: T) => string;
  /** The pointer (or keyboard focus) enters a row / leaves it again: the group under the pointer lights its members elsewhere. */
  hover?: (row: T | null) => void;
  /** Reports the open row's key (or null when closed). */
  onToggle?: (key: string | null) => void;
};

export function openTable<T>(options: OpenTableOptions<T>) {
  const hasDetail = !!options.detail;
  const tracks = [
    ...(options.tick ? ['28px'] : []),
    ...(hasDetail ? ['20px'] : []),
    ...options.columns.map((c) => c.width ?? 'minmax(0, 1fr)'),
  ].join(' ');
  const root = h('div', {
    class: `ot${options.className ? ` ${options.className}` : ''}`,
    attrs: { role: 'table', 'aria-label': options.label },
  });
  root.style?.setProperty('--cols', tracks);
  const head = h('div', { class: 'ot-head', attrs: { role: 'row' } });
  if (options.tick) head.append(h('span', { attrs: { role: 'columnheader', 'aria-label': options.tick.label } }));
  if (hasDetail) head.append(h('span', { attrs: { role: 'columnheader', 'aria-hidden': 'true' } }));
  for (const column of options.columns) {
    const cell = h('span', {
      class: column.align === 'end' ? 'ot-cell is-end' : 'ot-cell',
      text: column.label,
      attrs: { role: 'columnheader' },
    });
    if (column.headTip) hoverValue(cell, column.headTip);
    head.append(cell);
  }
  const body = h('div', { class: 'ot-body', attrs: { role: 'rowgroup' } });
  const empty = h('p', { class: 'ot-empty', text: options.emptyText, hidden: true });
  root.append(head, body, empty);

  let rows: T[] = [];
  let openKey: string | null = null;
  const ticked = new Set<string>();
  const items = new Map<string, { item: HTMLElement; row: HTMLElement; panel: HTMLElement; inner: HTMLElement }>();

  const settle = (panel: HTMLElement) => {
    // Once opened the panel stops clipping, so a hover bubble inside it can reach past its edge.
    setTimeout(() => {
      if (panel.dataset.state === 'open') panel.dataset.settled = 'true';
    }, 280);
  };
  const close = (key: string) => {
    const entry = items.get(key);
    if (!entry) return;
    entry.item.dataset.open = 'false';
    entry.row.setAttribute('aria-expanded', 'false');
    entry.panel.dataset.settled = 'false';
    entry.panel.dataset.state = 'closed';
    // The content leaves after the collapse so it can fade with it.
    setTimeout(() => {
      if (entry.panel.dataset.state === 'closed') entry.inner.replaceChildren();
    }, 280);
  };
  const open = async (key: string, row: T) => {
    if (openKey && openKey !== key) close(openKey);
    openKey = key;
    options.onToggle?.(key);
    const entry = items.get(key);
    if (!entry || !options.detail) return;
    entry.item.dataset.open = 'true';
    entry.row.setAttribute('aria-expanded', 'true');
    const content = await options.detail(row, () => toggle(key, row, false));
    if (openKey !== key) return;
    entry.inner.replaceChildren(content);
    entry.panel.dataset.state = 'open';
    settle(entry.panel);
  };
  const toggle = (key: string, row: T, want?: boolean) => {
    const isOpen = openKey === key;
    if (want === true && isOpen) return;
    if (isOpen) {
      close(key);
      openKey = null;
      options.onToggle?.(null);
    } else void open(key, row);
  };

  const paint = () => {
    body.replaceChildren();
    items.clear();
    empty.hidden = rows.length > 0;
    head.hidden = rows.length === 0;
    for (const row of rows) {
      const key = options.rowKey(row);
      const item = h('div', { class: 'ot-item', attrs: { role: 'rowgroup', 'data-key': key, 'data-open': 'false' } });
      const line = h('div', {
        class: `ot-row${hasDetail ? ' is-pickable' : ''} ${options.rowClass?.(row) ?? ''}`.trim(),
        attrs: { role: 'row', ...(hasDetail ? { 'aria-expanded': 'false', tabindex: '0' } : {}) },
      });
      if (options.tick) {
        const box = h('input', { attrs: { type: 'checkbox', 'aria-label': options.tick.label } });
        box.checked = ticked.has(key);
        box.addEventListener('click', (event) => event.stopPropagation());
        box.addEventListener('change', () => {
          if (box.checked) {
            if (options.tick!.max && ticked.size >= options.tick!.max) {
              box.checked = false;
              return;
            }
            ticked.add(key);
          } else ticked.delete(key);
          options.tick!.onChange([...ticked]);
        });
        line.append(h('span', { class: 'ot-tick', attrs: { role: 'cell' } }, box));
      }
      if (hasDetail)
        line.append(h('span', { class: 'ot-chev', attrs: { role: 'cell', 'aria-hidden': 'true' } }, chevron()));
      for (const column of options.columns) {
        const value = column.cell(row);
        const cell = h('span', {
          class: `ot-cell${column.align === 'end' ? ' is-end' : ''}${column.mono ? ' is-mono' : ''}`,
          attrs: { role: 'cell' },
        });
        if (typeof value === 'string') cell.textContent = value;
        else cell.append(value);
        const tip = column.tip?.(row);
        if (tip) hoverValue(cell, tip);
        line.append(cell);
      }
      const inner = h('div', { class: 'ot-inner' });
      const panel = h('div', { class: 'ot-panel', attrs: { 'data-state': 'closed' } }, inner);
      if (options.hover) {
        line.addEventListener('mouseenter', () => options.hover!(row));
        line.addEventListener('mouseleave', () => options.hover!(null));
        line.addEventListener('focus', () => options.hover!(row));
        line.addEventListener('blur', () => options.hover!(null));
      }
      if (hasDetail) {
        const go = (event: Event) => {
          const target = event.target as HTMLElement | null;
          if (target?.closest?.('button, a, input, select, textarea, .ad-tip')) return;
          toggle(key, row);
        };
        line.addEventListener('click', go);
        line.addEventListener('keydown', (event) => {
          const key2 = (event as KeyboardEvent).key;
          if ((key2 === 'Enter' || key2 === ' ') && event.target === line) {
            event.preventDefault();
            toggle(key, row);
          }
        });
      }
      item.append(line, panel);
      items.set(key, { item, row: line, panel, inner });
      body.append(item);
    }
    // A reload keeps the open row open.
    if (openKey && items.has(openKey)) {
      const row = rows.find((r) => options.rowKey(r) === openKey)!;
      const key = openKey;
      openKey = null;
      void open(key, row);
    } else openKey = null;
  };
  const api = {
    root,
    setRows(next: readonly T[]) {
      rows = [...next];
      for (const key of [...ticked]) if (!rows.some((r) => options.rowKey(r) === key)) ticked.delete(key);
      paint();
    },
    get openKey() {
      return openKey;
    },
    /** Opens a row by key (used by deep links and the "only one" case). */
    open(key: string) {
      const row = rows.find((r) => options.rowKey(r) === key);
      if (row && openKey !== key) toggle(key, row, true);
    },
    closeAll() {
      if (openKey) {
        close(openKey);
        openKey = null;
      }
    },
    ticked: () => [...ticked],
    clearTicks() {
      ticked.clear();
      for (const box of root.querySelectorAll?.<HTMLInputElement>('.ot-tick input') ?? []) box.checked = false;
      options.tick?.onChange([]);
    },
  };
  paint();
  return api;
}

const NS = 'http://www.w3.org/2000/svg';
/** The chevron of an open-below row: turns 90° when the row opens (240 ms, CSS). */
export function chevron(): SVGElement {
  const svg = (typeof document.createElementNS === 'function'
    ? document.createElementNS(NS, 'svg')
    : document.createElement('svg')) as unknown as SVGElement;
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '12');
  svg.setAttribute('height', '12');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2.5');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'ot-chevron');
  const path = (typeof document.createElementNS === 'function'
    ? document.createElementNS(NS, 'path')
    : document.createElement('path')) as unknown as SVGElement;
  path.setAttribute('d', 'm9 6 6 6-6 6');
  svg.append(path);
  return svg;
}

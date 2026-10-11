import { h } from '../../cocreation/h.ts';

export type Column<T> = {
  key: string;
  label: string;
  /** Text or a node for the cell. Default: the row's field with this key. */
  render?: (row: T) => string | Node;
  /** Sortable columns compare this value (default: the cell text). */
  sortValue?: (row: T) => string | number | null;
  sortable?: boolean;
  align?: 'end';
};
export type BulkAction<T> = { label: string; danger?: boolean; run: (rows: T[]) => void | Promise<void> };
export type DataTableOptions<T> = {
  columns: readonly Column<T>[];
  rowKey: (row: T) => string;
  /** Adds a checkbox column and the bulk-action bar. */
  bulkActions?: readonly BulkAction<T>[];
  emptyText: string;
  caption?: string;
  onRowOpen?: (row: T) => void;
  /** Which gesture opens a row: a double click (default) or a single click, which ignores clicks on controls inside the row. */
  openOn?: 'dblclick' | 'click';
};

/**
 * Sortable table with sticky header, row selection and a bulk-action bar. The wrapper is the only scroll region;
 * the header stays visible while it scrolls. Selection survives re-sorting and is pruned when rows change.
 */
export function dataTable<T>(options: DataTableOptions<T>) {
  let rows: T[] = [];
  let sort: { key: string; dir: 'asc' | 'desc' } | null = null;
  const selected = new Set<string>();
  const selectable = !!options.bulkActions?.length;
  const all = h('input', { attrs: { type: 'checkbox', 'aria-label': '选择全部' } });
  const head = h('tr');
  const body = h('tbody');
  const empty = h('p', { class: 'admin-empty', text: options.emptyText, hidden: true });
  const count = h('span', { class: 'admin-bulk-count' });
  const bar = h(
    'div',
    { class: 'admin-bulk-bar', hidden: true, attrs: { role: 'toolbar', 'aria-label': '批量操作' } },
    count,
  );
  const table = h(
    'table',
    { class: 'admin-table' },
    options.caption ? h('caption', { text: options.caption }) : null,
    h('thead', {}, head),
    body,
  );
  const wrap = h('div', { class: 'admin-table-wrap' }, table, empty);
  const root = h('div', { class: 'admin-table-region' }, bar, wrap);

  const cellValue = (column: Column<T>, row: T) => {
    const value = column.render ? column.render(row) : String((row as Record<string, unknown>)[column.key] ?? '');
    return value;
  };
  const textOf = (column: Column<T>, row: T) => {
    const value = cellValue(column, row);
    return typeof value === 'string' ? value : (value.textContent ?? '');
  };
  const ordered = () => {
    if (!sort) return rows;
    const column = options.columns.find((c) => c.key === sort!.key);
    if (!column) return rows;
    const key = (row: T) => (column.sortValue ? column.sortValue(row) : textOf(column, row));
    const direction = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const x = key(a),
        y = key(b);
      if (x === y) return 0;
      if (x === null) return 1;
      if (y === null) return -1;
      return (
        (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'zh-CN')) *
        direction
      );
    });
  };
  const chosen = () => rows.filter((row) => selected.has(options.rowKey(row)));
  const paintBar = () => {
    const n = selected.size;
    bar.hidden = !selectable || n === 0;
    count.textContent = `已选 ${n} 项`;
    all.checked = rows.length > 0 && n === rows.length;
    (all as unknown as { indeterminate: boolean }).indeterminate = n > 0 && n < rows.length;
  };
  const paintHead = () => {
    const cells: Node[] = [];
    if (selectable) cells.push(h('th', { class: 'admin-select-col' }, all));
    for (const column of options.columns) {
      const active = sort?.key === column.key;
      const th = h('th', {
        class: column.align === 'end' ? 'is-end' : '',
        attrs: {
          scope: 'col',
          ...(column.sortable
            ? { 'aria-sort': active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : 'none' }
            : {}),
        },
      });
      if (column.sortable) {
        const button = h('button', { class: 'admin-sort', text: column.label, attrs: { type: 'button' } });
        button.addEventListener('click', () => {
          sort =
            sort?.key === column.key && sort.dir === 'asc'
              ? { key: column.key, dir: 'desc' }
              : { key: column.key, dir: 'asc' };
          paintHead();
          paintRows();
        });
        th.append(button);
      } else th.textContent = column.label;
      cells.push(th);
    }
    head.replaceChildren(...(cells as HTMLElement[]));
  };
  const paintRows = () => {
    const shown = ordered();
    body.replaceChildren();
    empty.hidden = rows.length > 0;
    table.hidden = rows.length === 0;
    for (const row of shown) {
      const key = options.rowKey(row);
      const tr = h('tr', { attrs: { 'data-row': key } });
      if (selectable) {
        const box = h('input', { attrs: { type: 'checkbox', 'aria-label': '选择此行' } });
        box.checked = selected.has(key);
        box.addEventListener('change', () => {
          if (box.checked) selected.add(key);
          else selected.delete(key);
          paintBar();
        });
        tr.append(h('td', { class: 'admin-select-col' }, box));
      }
      for (const column of options.columns) {
        const value = cellValue(column, row);
        const td = h('td', { class: column.align === 'end' ? 'is-end' : '' });
        if (typeof value === 'string') td.textContent = value;
        else td.append(value);
        tr.append(td);
      }
      if (options.onRowOpen) {
        const gesture = options.openOn ?? 'dblclick';
        tr.addEventListener(gesture, (event) => {
          const tag = (event.target as { tagName?: string } | null)?.tagName;
          if (gesture === 'click' && (tag === 'INPUT' || tag === 'BUTTON' || tag === 'A' || tag === 'SELECT')) return;
          options.onRowOpen!(row);
        });
        if (gesture === 'click') {
          tr.setAttribute('tabindex', '0');
          tr.addEventListener('keydown', (event) => {
            if ((event as KeyboardEvent).key === 'Enter') options.onRowOpen!(row);
          });
        }
      }
      body.append(tr);
    }
    paintBar();
  };
  all.addEventListener('change', () => {
    selected.clear();
    if (all.checked) for (const row of rows) selected.add(options.rowKey(row));
    paintRows();
  });
  for (const action of options.bulkActions ?? []) {
    const button = h('button', {
      class: action.danger ? 'admin-danger' : 'admin-secondary',
      text: action.label,
      attrs: { type: 'button' },
    });
    button.addEventListener('click', () => void action.run(chosen()));
    bar.append(button);
  }
  const clear = h('button', { class: 'admin-secondary', text: '清除选择', attrs: { type: 'button' } });
  clear.addEventListener('click', () => api.clearSelection());
  if (selectable) bar.append(clear);
  const api = {
    root,
    setRows(next: readonly T[]) {
      rows = [...next];
      const keys = new Set(rows.map(options.rowKey));
      for (const key of [...selected]) if (!keys.has(key)) selected.delete(key);
      paintRows();
    },
    selected: chosen,
    clearSelection() {
      selected.clear();
      paintRows();
    },
    sortBy(key: string, dir: 'asc' | 'desc' = 'asc') {
      sort = { key, dir };
      paintHead();
      paintRows();
    },
  };
  paintHead();
  paintRows();
  return api;
}

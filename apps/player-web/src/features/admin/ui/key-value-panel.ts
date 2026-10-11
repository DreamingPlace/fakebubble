import { h } from '../../cocreation/h.ts';

/** Read-only facts as a definition list: label on the left, value (text or a node) on the right. */
export function keyValuePanel(rows: ReadonlyArray<readonly [label: string, value: string | Node | null]>) {
  const list = h('dl', { class: 'admin-kv' });
  for (const [label, value] of rows) {
    const detail = h('dd');
    if (value === null) detail.textContent = '—';
    else if (typeof value === 'string') detail.textContent = value;
    else detail.append(value);
    list.append(h('dt', { text: label }), detail);
  }
  return list;
}

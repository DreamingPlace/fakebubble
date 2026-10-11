import { h } from '../../cocreation/h.ts';

export type ToolbarFilter =
  | { kind: 'search'; id: string; label: string; placeholder?: string }
  | { kind: 'select'; id: string; label: string; options: ReadonlyArray<readonly [value: string, label: string]> };
/**
 * Sticky toolbar: a title, filters (search box, selects) and action buttons. `onChange` receives every filter's
 * current value keyed by id, after any change.
 */
export function toolbar(options: {
  title?: string;
  filters?: readonly ToolbarFilter[];
  actions?: ReadonlyArray<{ label: string; run: () => void; secondary?: boolean }>;
  onChange?: (values: Record<string, string>) => void;
}) {
  const root = h('div', { class: 'admin-bar', attrs: { role: 'toolbar' } });
  if (options.title) root.append(h('strong', { class: 'admin-bar-title', text: options.title }));
  const inputs = new Map<string, HTMLInputElement | HTMLSelectElement>();
  const values = () => Object.fromEntries([...inputs].map(([id, input]) => [id, input.value]));
  for (const filter of options.filters ?? []) {
    const label = h('label', { class: 'admin-filter' }, h('span', { text: filter.label }));
    let input: HTMLInputElement | HTMLSelectElement;
    if (filter.kind === 'search') {
      input = h('input', {
        attrs: { type: 'search', ...(filter.placeholder ? { placeholder: filter.placeholder } : {}) },
      });
    } else {
      input = h('select');
      for (const [value, text] of filter.options) input.append(h('option', { text, attrs: { value } }));
    }
    input.addEventListener('input', () => options.onChange?.(values()));
    input.addEventListener('change', () => options.onChange?.(values()));
    inputs.set(filter.id, input);
    label.append(input);
    root.append(label);
  }
  if (options.actions?.length) root.append(h('span', { class: 'admin-bar-spacer' }));
  for (const action of options.actions ?? []) {
    const button = h('button', {
      class: action.secondary ? 'admin-secondary' : '',
      text: action.label,
      attrs: { type: 'button' },
    });
    button.addEventListener('click', action.run);
    root.append(button);
  }
  return { root, values };
}

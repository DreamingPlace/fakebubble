import { h } from '../../cocreation/h.ts';

/** A path for an icon button (24px viewBox, stroked), or null for a text button. */
const ICONS = {
  line: '<path d="M3 17l5-6 4 3 7-8"/>',
  pie: '<circle cx="12" cy="12" r="8"/><path d="M12 4v8h8"/>',
  table: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  bar: '<path d="M6 20V11M12 20V5M18 20v-7"/>',
} as const;
export type SegIcon = keyof typeof ICONS;

export type SegOption<T extends string> = { id: T; label: string; icon?: SegIcon };

/**
 * A pill switch: one option is pressed. Every option is a real button (`aria-pressed`), so it works from the keyboard, and the
 * pressed one is told apart by more than colour (its weight). `set` changes the pressed option without calling `onPick`.
 */
export function segmented<T extends string>(
  label: string,
  options: ReadonlyArray<SegOption<T>>,
  value: T,
  onPick: (id: T) => void,
  size: 'm' | 's' = 's',
) {
  const root = h('div', { class: `seg seg-${size}`, attrs: { role: 'group', 'aria-label': label } });
  const buttons = new Map<T, HTMLButtonElement>();
  for (const option of options) {
    const button = h('button', {
      class: `seg-button${option.icon ? ' seg-icon' : ''}`,
      attrs: { type: 'button', 'aria-pressed': String(option.id === value), 'data-seg': option.id },
    });
    if (option.icon) {
      button.setAttribute('aria-label', option.label);
      button.setAttribute('title', option.label);
      button.append(icon(option.icon));
    } else button.textContent = option.label;
    button.addEventListener('click', () => {
      if (current === option.id) return;
      set(option.id);
      onPick(option.id);
    });
    buttons.set(option.id, button);
    root.append(button);
  }
  let current = value;
  function set(next: T) {
    current = next;
    for (const [id, button] of buttons) button.setAttribute('aria-pressed', String(id === next));
  }
  return {
    root,
    set,
    get value() {
      return current;
    },
    buttons,
  };
}

const NS = 'http://www.w3.org/2000/svg';
/** An SVG node; a document without namespaces (the minimal stubs some page tests use) gets a plain element instead. */
const svgNode = (tag: string): SVGElement =>
  (typeof document.createElementNS === 'function'
    ? document.createElementNS(NS, tag)
    : document.createElement(tag)) as unknown as SVGElement;

function icon(name: SegIcon) {
  const svg = svgNode('svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2.2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  // The paths are fixed strings above, never data. Built node by node so no markup is ever parsed.
  for (const part of ICONS[name].match(/<(path|circle)[^>]*\/>/g) ?? []) {
    const shape = svgNode(part.startsWith('<path') ? 'path' : 'circle');
    for (const [, key, value] of part.matchAll(/([\w-]+)="([^"]*)"/g)) shape.setAttribute(key!, value!);
    svg.append(shape);
  }
  return svg;
}

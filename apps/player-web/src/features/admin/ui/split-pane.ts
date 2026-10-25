import { h } from '../../cocreation/h.ts';

export type SplitPaneOptions = { initial?: number; min?: number; max?: number; label?: string };
/**
 * List | detail with a draggable (and arrow-key) divider. Both panes are their own scroll regions; the pane
 * itself never scrolls. The width lives in a CSS variable, so nothing is re-rendered while resizing.
 */
export function splitPane(parent: HTMLElement, options: SplitPaneOptions = {}) {
  const min = options.min ?? 220,
    max = options.max ?? 560;
  let width = Math.min(max, Math.max(min, options.initial ?? 320));
  const list = h('div', { class: 'admin-split-list' });
  const detail = h('div', { class: 'admin-split-detail' });
  const divider = h('div', {
    class: 'admin-split-divider',
    attrs: {
      role: 'separator',
      'aria-orientation': 'vertical',
      'aria-label': options.label ?? '调整列表宽度',
      tabindex: '0',
    },
  });
  const root = h('div', { class: 'admin-split' }, list, divider, detail);
  const apply = () => {
    // CSSOM, not a style attribute: the page's CSP (style-src 'self') refuses inline style.
    root.style.setProperty('--split-list-width', `${width}px`);
    divider.setAttribute('aria-valuenow', String(width));
    divider.setAttribute('aria-valuemin', String(min));
    divider.setAttribute('aria-valuemax', String(max));
  };
  const set = (next: number) => {
    width = Math.min(max, Math.max(min, Math.round(next)));
    apply();
  };
  divider.addEventListener('keydown', (event) => {
    const key = (event as KeyboardEvent).key;
    if (key === 'ArrowLeft') set(width - 16);
    else if (key === 'ArrowRight') set(width + 16);
    else return;
    event.preventDefault();
  });
  divider.addEventListener('pointerdown', (event) => {
    const start = (event as PointerEvent).clientX,
      from = width;
    const move = (e: Event) => set(from + ((e as PointerEvent).clientX - start));
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    event.preventDefault();
  });
  apply();
  parent.append(root);
  return { root, list, detail, divider, width: () => width, setWidth: set };
}

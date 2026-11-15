import { hoverValue } from './hover-value.ts';

/**
 * Part 24b-7f: an icon-only tool button (the role rail's 新建 / 导入 / 排序). The name is its aria-label and its hover / focus tip
 * (ui/tooltip.ts, placed in the viewport so the rail's own overflow never clips it); the glyph is a 24-box stroke path. The
 * button keeps its id, its click handler and its hidden state; only what it shows changes.
 */
export const ICON_PATHS = {
  add: 'M12 5v14M5 12h14',
  import: 'M12 4v11M8 11l4 4 4-4M5 19h14',
  sort: 'M8 5v14M5 8l3-3 3 3M16 19V5M13 16l3 3 3-3',
} as const;

export function iconTool(button: HTMLButtonElement, label: string, path: string): HTMLButtonElement {
  button.setAttribute('aria-label', label);
  button.className = `${button.className} ad-icon-tool`.trim();
  let glyph: Element;
  try {
    const NS = 'http://www.w3.org/2000/svg';
    glyph = document.createElementNS(NS, 'svg');
    glyph.setAttribute('viewBox', '0 0 24 24');
    glyph.setAttribute('width', '18');
    glyph.setAttribute('height', '18');
    glyph.setAttribute('fill', 'none');
    glyph.setAttribute('stroke', 'currentColor');
    glyph.setAttribute('stroke-width', '2');
    glyph.setAttribute('stroke-linecap', 'round');
    glyph.setAttribute('stroke-linejoin', 'round');
    glyph.setAttribute('aria-hidden', 'true');
    const shape = document.createElementNS(NS, 'path');
    shape.setAttribute('d', path);
    glyph.append(shape);
  } catch {
    // a document without namespaced elements (the small DOMs of some component tests)
    glyph = document.createElement('i');
  }
  button.replaceChildren(glyph);
  return hoverValue(button, label, true);
}

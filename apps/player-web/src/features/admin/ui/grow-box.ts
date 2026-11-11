/**
 * Part 24b-7b: a field takes the shape of what it holds.
 *   'one'  — ONE sentence (欢迎词, 一句话描述, 情境, 玩家说 …): starts at one line, grows as the text wraps, never shows an empty
 *            second line, no resize handle. A line break cannot be typed or pasted (a sentence has none) unless `multiline`.
 *   'para' — a paragraph (人设, 经历 text, JSON): starts at four lines and grows with the text.
 * The height is always the text's own (scrollHeight), so nothing inside the box is cut and nothing is left empty. It follows the box's
 * width too (a ResizeObserver): a box that was hidden (another tab) fits the moment it is shown. CSS: `.gb` in the admin shell.
 */
export type GrowKind = 'one' | 'para';
export const GROW_ROWS: Record<GrowKind, number> = { one: 1, para: 4 };

type Options = { multiline?: boolean };
const frame = (work: () => void) =>
  typeof requestAnimationFrame === 'function' ? requestAnimationFrame(work) : setTimeout(work, 0);

/** Fits the box to its text now. Skipped while the box has no width (hidden): the observer fits it when it appears. */
export function fitBox(node: HTMLTextAreaElement) {
  if (!node.style || !node.clientWidth) return;
  node.style.height = 'auto';
  const cs = typeof getComputedStyle === 'function' ? getComputedStyle(node) : null;
  const border = cs ? parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth) : 0;
  node.style.height = `${node.scrollHeight + (Number.isFinite(border) ? border : 0)}px`;
}

export function growBox<T extends HTMLTextAreaElement>(node: T, kind: GrowKind, options: Options = {}): T {
  node.rows = GROW_ROWS[kind];
  node.dataset.grow = kind;
  node.className = `${node.className} gb`.trim();
  node.setAttribute?.('spellcheck', 'false');
  if (kind === 'one' && !options.multiline) {
    node.addEventListener('keydown', (event) => {
      const key = event as KeyboardEvent;
      if (key.key === 'Enter' && !key.isComposing && !key.altKey) key.preventDefault();
    });
    // A pasted line break becomes nothing: a sentence is one line.
    node.addEventListener('input', () => {
      if (/[\r\n]/.test(node.value)) {
        const at = node.selectionStart ?? node.value.length;
        node.value = node.value.replace(/[\r\n]+/g, '');
        node.setSelectionRange?.(Math.min(at, node.value.length), Math.min(at, node.value.length));
      }
    });
  }
  node.addEventListener('input', () => fitBox(node));
  if (typeof ResizeObserver === 'function') {
    let width = 0;
    new ResizeObserver(() => {
      if (node.clientWidth !== width) {
        width = node.clientWidth;
        fitBox(node);
      }
    }).observe(node);
  }
  frame(() => fitBox(node));
  return node;
}

/**
 * A single-line input for a short value (a name, a code, a colour): as wide as its limit says (in characters, capped), and wider
 * when the text it holds is longer, so the text is never cut. `data-short` carries the size for the CSS.
 */
export function shortInput<T extends HTMLInputElement>(node: T, limit: number, cap = 40): T {
  const fit = () => {
    const held = [...node.value].length + 2;
    node.style?.setProperty('--short', `${Math.max(6, Math.min(limit, cap), held)}ch`);
  };
  node.className = `${node.className} si`.trim();
  node.dataset.short = String(Math.min(limit, cap));
  node.addEventListener('input', fit);
  fit();
  return node;
}

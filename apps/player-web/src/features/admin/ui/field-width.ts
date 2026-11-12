/**
 * Part 24b-7c: a single-line field is as wide as what it holds. Its width class comes from its REAL limit (the field table of
 * Part 24b-7b: the input's own maxlength), never from the space around it:
 *   xs  a number or a percentage (语速, weights, points)      ≤ 8 characters
 *   s   a code, an id, a hex colour                           ≤ 16
 *   m   a name or a short note                                ≤ 40
 *   l   the 920 px form column                                everything longer
 *   full  paragraphs (a textarea that is not a one-line box) and tables
 * A select is `fit`: the width of its longest option, kept inside the column. The class only sets `data-w`; the widths are CSS tokens
 * (--ad-w-xs … --ad-w-l, docs/ADMIN_LAYOUT.md). It never changes a value, a handler or a request. The 声音 tab (.vc-materials) is Part
 * 30's and is never touched. An element that already carries `data-w` keeps it (a screen can state its own class).
 */
type WidthClass = 'xs' | 's' | 'm' | 'l' | 'full' | 'fit';

export function widthClassOf(field: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): WidthClass {
  const tag = field.tagName.toLowerCase();
  if (tag === 'select') return 'fit';
  const limit = Number((field as HTMLInputElement | HTMLTextAreaElement).maxLength);
  const known = Number.isFinite(limit) && limit > 0 && limit < 100_000;
  if (tag === 'textarea') {
    if (field.getAttribute('data-grow') !== 'one') return 'full';
    return known ? classFor(limit) : 'l';
  }
  const type = (field as HTMLInputElement).type;
  if (type === 'number') return 'xs';
  if (type === 'date' || type === 'time' || type === 'datetime-local') return 's';
  // an address of more than 40 characters is not typed here: the limit (254) is the protocol's, not the field's
  if (type === 'email') return 'm';
  if ((field.getAttribute('inputmode') ?? '') === 'numeric' && !known) return 'xs';
  return known ? classFor(limit) : 'm';
}
const classFor = (limit: number): WidthClass => (limit <= 8 ? 'xs' : limit <= 16 ? 's' : limit <= 40 ? 'm' : 'l');

const SINGLE =
  'input:not([type="checkbox"]):not([type="radio"]):not([type="color"]):not([type="file"]):not([type="range"]):not([type="hidden"]), select, textarea';
function sizeFields(scope: ParentNode): void {
  const found = scope.querySelectorAll?.(SINGLE);
  if (!found) return;
  for (const node of Array.from(found) as Array<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) {
    if (node.hasAttribute('data-w') || node.closest?.('.vc-materials')) continue;
    node.setAttribute('data-w', widthClassOf(node));
  }
}

/** Keeps every field the console renders (now or later) classed. One observer for the whole shell; work is batched per frame. */
export function watchFieldWidths(root: HTMLElement): () => void {
  sizeFields(root);
  if (typeof MutationObserver === 'undefined') return () => {};
  let queued = false;
  const run = () => {
    queued = false;
    sizeFields(root);
  };
  const observer = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else queueMicrotask(run);
  });
  observer.observe(root, { childList: true, subtree: true });
  return () => observer.disconnect();
}

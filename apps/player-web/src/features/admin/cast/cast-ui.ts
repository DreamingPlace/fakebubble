import { h } from '../../cocreation/h.ts';
import type { CastDoc } from '../../../../../../packages/contracts/web-cast.ts';
import { DOTS } from './cast-model.ts';

/** What every region of the page shares: the working document, who may do what, and how to tell the others something changed. */
export type CastCtx = {
  /** The working copy the administrator edits. Always present when a region is painted. */
  doc: () => CastDoc;
  canEdit: () => boolean;
  /** Marks the draft changed (shows 保存); `soft` leaves the other regions alone, which keeps the field being typed in. */
  edited: (soft?: boolean) => void;
  /** Redraws regions by name (never the one holding a field that is being typed in). */
  paint: (...regions: Region[]) => void;
  /** Opens a character's panel (and selects their row in the grid). */
  openCharacter: (characterId: string) => void;
  /** Reduced-motion aware smooth scrolling to a region. */
  reveal: (node: HTMLElement) => void;
};
export type Region = 'bar' | 'versions' | 'notice' | 'grid' | 'side' | 'groups' | 'stories' | 'character' | 'sees';

/** A text input or textarea bound to a getter/setter; read-only (but visible) for someone who cannot edit. */
export function bound(
  ctx: CastCtx,
  label: string,
  get: () => string,
  set: (value: string) => void,
  options: { area?: boolean; max?: number; rows?: number; placeholder?: string; after?: (() => void) | undefined } = {},
) {
  const input = options.area ? h('textarea') : h('input', { attrs: { type: 'text' } });
  input.value = get();
  if (options.max) input.maxLength = options.max;
  if (options.area) (input as HTMLTextAreaElement).rows = options.rows ?? 3;
  if (options.placeholder) input.setAttribute('placeholder', options.placeholder);
  const edit = () => {
    set(input.value);
    ctx.edited(true);
  };
  input.addEventListener('input', edit);
  if (options.after) input.addEventListener('change', options.after);
  if (!ctx.canEdit()) input.setAttribute('readonly', '');
  const wrap = h('label', { class: 'cs-field' }, h('span', { text: label }), input);
  return { wrap, input };
}

/** The little round name tag used in the grid, panels and chips. */
export function dot(index: number, name: string, size = 26) {
  const node = h('span', { class: 'cs-dot', text: [...name][0] ?? '', attrs: { 'aria-hidden': 'true' } });
  node.style.setProperty('--dot', DOTS[index % DOTS.length]!);
  node.style.setProperty('--size', `${size}px`);
  return node;
}

/** A pill button that is pressed or not (participants, members). */
export function toggleChip(label: string, on: boolean, enabled: boolean, onToggle: () => void, lead?: Node) {
  const button = h('button', { class: 'cs-chip', attrs: { type: 'button', 'aria-pressed': String(on) } });
  if (lead) button.append(lead);
  button.append(label);
  if (!enabled) {
    button.setAttribute('data-locked', 'true');
    button.disabled = true;
  }
  button.addEventListener('click', onToggle);
  return button;
}

/** Disabled-by-state buttons keep their lock through the page's own re-enabling (it honours data-locked). */
export function lock(button: HTMLButtonElement, locked: boolean, why?: string) {
  button.dataset.locked = String(locked);
  button.disabled = locked;
  if (locked && why) button.setAttribute('title', why);
  else button.removeAttribute('title');
}

import { h } from '../../cocreation/h.ts';
import type { CastDoc } from '../../../../../../packages/contracts/web-cast.ts';

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
  /** The dot colour of a character (the same one 角色工作台 and 共创收件箱 use) or of a person (grey). */
  colour: (id: string) => string;
  /** The people in the grid, in order: the workbench roster (the fixed grid), then any cast character it does not list. */
  ids: () => string[];
  /** A character's name wherever the document does not have its entry yet (the workbench's display name). */
  nameOf: (id: string) => string;
  /** The draft as it was last read or saved, for the amber "not saved yet" marks. */
  base: () => CastDoc;
  /** Opens a story (an index into doc.stories) in the full-width editor below. */
  openStory: (index: number) => void;
  /** Lights the rows and columns of the group under the pointer (no repaint). */
  light: () => void;
};
export type Region =
  | 'bar'
  | 'versions'
  | 'notice'
  | 'start'
  | 'grid'
  | 'side'
  | 'groups'
  | 'stories'
  | 'world'
  | 'character'
  | 'sees';

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

/** The little round colour dot beside a name (never carries text of its own: the name is always written next to it). */
export function dot(colour: string, size = 12) {
  const node = h('i', { class: 'cs-dot', attrs: { 'aria-hidden': 'true' } });
  node.style.setProperty('--dot', colour);
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

/**
 * The picker for story participants and group members (Part 24b-4): every character of the cast, and (with `people`) every person,
 * as chips with a colour dot and the name, any number of them selected. `max` is the server's cap; once reached only the chosen
 * ones stay clickable (to take them off).
 */
export function picker(
  ctx: CastCtx,
  label: string,
  chosen: string[],
  options: { people: boolean; max: number; after: () => void },
) {
  const doc = ctx.doc();
  const edit = ctx.canEdit();
  const make = (id: string, name: string) => {
    const on = chosen.includes(id);
    return toggleChip(
      name,
      on,
      edit && (on || chosen.length < options.max),
      () => {
        if (on) chosen.splice(chosen.indexOf(id), 1);
        else chosen.push(id);
        ctx.edited();
        options.after();
      },
      dot(ctx.colour(id)),
    );
  };
  const box = h('div', { class: 'cs-chips', attrs: { role: 'group', 'aria-label': label } });
  for (const id of ctx.ids()) box.append(make(id, ctx.nameOf(id)));
  if (options.people)
    for (const p of doc.people) {
      const chip = make(p.id, p.names[0]?.text ?? p.id);
      chip.classList.add('is-person');
      box.append(chip);
    }
  return h(
    'div',
    { class: 'cs-picker' },
    h('span', { class: 'cs-label', text: `${label}（已选 ${chosen.length}）` }),
    box,
  );
}

/** Disabled-by-state buttons keep their lock through the page's own re-enabling (it honours data-locked). */
export function lock(button: HTMLButtonElement, locked: boolean, why?: string) {
  button.dataset.locked = String(locked);
  button.disabled = locked;
  if (locked && why) button.setAttribute('title', why);
  else button.removeAttribute('title');
}

const SVG_NS = 'http://www.w3.org/2000/svg';
/** An SVG node with its attributes (a document without namespaces - the stub DOMs of some tests - gets a plain element). */
export function svgNode(tag: string, attrs: Record<string, string> = {}): SVGElement {
  const node = (typeof document.createElementNS === 'function'
    ? document.createElementNS(SVG_NS, tag)
    : document.createElement(tag)) as unknown as SVGElement;
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

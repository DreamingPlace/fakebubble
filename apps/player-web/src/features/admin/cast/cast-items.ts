import {
  CAST_ITEM_CODE,
  castItemProblem,
  castLength,
  type CastText,
} from '../../../../../../packages/contracts/web-cast.ts';
import { h } from '../../cocreation/h.ts';
import { dragOrder } from '../ui/drag-order.ts';
import { dragHandle, liveRegion, movedSentence, removeButton } from '../ui/item-controls.ts';
import { markDirty } from '../ui/unsaved.ts';
import { issueSentence } from './cast-model.ts';
import type { CastCtx } from './cast-ui.ts';

/**
 * The list editor of the two ordered text lists of the cast (Part 24i): a character's 别名 (text + kind + attitude per row) and a
 * direction's 称呼 (text only). One row per item: the text, its live count (14/16), and 上移 / 下移 / 删除; the list has its own
 * count (5/12) and 加一项 stops at the cap.
 *
 * Nothing here cuts, trims or moves text: an input has NO maxlength (so a 17th unit is typed and then flagged on its own row, not
 * silently dropped), and a row that breaks a rule shows the same sentence the server and the cast file import give for it
 * (issueSentence), right under that row. The rules are the shared ones of web-cast.ts (castItemProblem, UTF-16 length).
 */
export interface ItemListSpec<T extends CastText> {
  ctx: CastCtx;
  /** 别名 / 称呼. */
  label: string;
  /** A sentence under the label, saying what the list is for. */
  hint?: string;
  /** The live array inside the working document; the editor changes it in place. */
  items: T[];
  /** The same list in the last saved draft (for the amber "not saved yet" mark), or null when it is new. */
  base: readonly T[] | null;
  max: number;
  maxText: number;
  blank: () => T;
  /** Where item `index` is in the document, spelled for humanIssue: characters[<id>].identity.aliases[<i>].text. */
  path: (index: number) => string;
  /** The path of the list itself (for the "too many" sentence). */
  listPath: string;
  /** Extra controls of a row (the alias kind and attitude). `changed` marks the draft changed without redrawing. */
  extra?: (item: T, changed: () => void) => HTMLElement[];
  /** Called after the list was reordered, grown or shortened (the grid's hover text shows the joined addresses). */
  structure?: () => void;
  testId: string;
}

/** What is wrong with item `index` of `items`, as a code (null: nothing). Empty, control, edge space, too long, then a repeat. */
export function itemCode(items: readonly CastText[], index: number, maxText: number): string | null {
  const problem = castItemProblem(items[index]!.text, maxText);
  if (problem) return CAST_ITEM_CODE[problem];
  // Part 24l: an alias is a repeat only with the same text AND the same kind (a name may be a 别名 and a 黑称).
  const kindOf = (item: CastText) => (item as { kind?: string }).kind;
  return items.findIndex(
    (other, at) => at < index && other.text === items[index]!.text && kindOf(other) === kindOf(items[index]!),
  ) >= 0
    ? 'CAST_DUPLICATE_ITEM'
    : null;
}

export function itemList<T extends CastText>(spec: ItemListSpec<T>): HTMLElement {
  const { ctx, items } = spec;
  const edit = ctx.canEdit();
  const root = h('div', { class: 'cs-items', attrs: { 'data-list': spec.testId } });
  const sentence = (code: string, path: string) => issueSentence(ctx.doc(), code, path).text;

  // Kept across renders: the drag / keyboard listeners are on it, and the live region announces the moves.
  const rows = h('div', { class: 'cs-item-rows' });
  const live = liveRegion();
  let focusKind: 'text' | 'handle' = 'text';
  const render = (focusAt: number | null = null) => {
    refreshers.length = 0;
    root.replaceChildren();
    rows.replaceChildren();
    const over = items.length > spec.max;
    const count = h('span', {
      class: `cs-items-count${over ? ' is-over' : ''}`,
      text: `${items.length}/${spec.max}`,
      attrs: { 'aria-label': `${spec.label}共 ${items.length} 项，最多 ${spec.max} 项` },
    });
    root.append(
      h(
        'div',
        { class: 'cs-items-head' },
        h('span', { class: 'cs-items-label', text: spec.label }),
        spec.hint ? h('span', { class: 'cs-hint-line', text: spec.hint }) : null,
        count,
      ),
    );
    if (over)
      root.append(
        h('p', {
          class: 'cs-item-error',
          text: sentence('CAST_TOO_MANY_ITEMS', spec.listPath),
          attrs: { role: 'alert' },
        }),
      );
    items.forEach((item, index) => {
      const input = h('input', {
        class: 'cs-item-text',
        // No maxlength on purpose: text is never cut while typing; a row over the cap is flagged instead.
        attrs: {
          type: 'text',
          'aria-label': `${spec.label} 第 ${index + 1} 项`,
          autocomplete: 'off',
          spellcheck: 'false',
        },
      });
      input.value = item.text;
      if (!edit) input.setAttribute('readonly', '');
      const used = h('span', { class: 'cs-item-count' });
      const error = h('p', { class: 'cs-item-error', attrs: { role: 'alert' }, hidden: true });
      const wrap = h('div', { class: 'cs-item', attrs: { 'data-index': String(index) } });
      const refresh = () => {
        const length = castLength(item.text);
        used.textContent = `${length}/${spec.maxText}`;
        used.classList.toggle('is-over', length > spec.maxText);
        const code = itemCode(items, index, spec.maxText);
        error.hidden = !code;
        error.textContent = code ? sentence(code, spec.path(index)) : '';
        wrap.setAttribute('data-invalid', String(!!code));
        input.setAttribute('aria-invalid', String(!!code));
        const saved = item.id ? spec.base?.find((b) => b.id === item.id) : undefined;
        markDirty(input, saved?.text !== item.text);
      };
      input.addEventListener('input', () => {
        item.text = input.value;
        // Every row is refreshed: another row that repeats this text (or stops repeating it) changes its own sentence too.
        refreshAll();
        ctx.edited(true);
      });
      const tools = edit ? removeButton(`删除${spec.label}第 ${index + 1} 项`, 'ad-remove cs-item-remove') : null;
      tools?.addEventListener('click', () => remove(index));
      const handle = edit ? dragHandle(`${spec.label}第 ${index + 1} 项`, 'ad-handle cs-item-handle') : null;
      wrap.setAttribute('data-drag-row', '');
      const extras = spec.extra
        ? spec.extra(item, () => {
            ctx.edited(true);
          })
        : [];
      wrap.append(
        h(
          'div',
          { class: 'cs-item-row' },
          handle,
          h('span', { class: 'cs-item-no', text: String(index + 1) }),
          input,
          ...extras,
          used,
          tools,
        ),
        error,
      );
      rows.append(wrap);
      refreshers.push(refresh);
      refresh();
    });
    root.append(rows, live.node);
    if (!items.length) root.append(h('p', { class: 'cs-hint-line', text: '还没有' }));
    if (edit) {
      const add = h('button', {
        class: 'cs-add cs-dashed',
        text: items.length >= spec.max ? `已满 ${spec.max} 项` : '+ 加一项',
        attrs: { type: 'button', 'aria-label': `给${spec.label}加一项` },
      });
      add.disabled = items.length >= spec.max;
      add.addEventListener('click', () => {
        items.push(spec.blank());
        changed(items.length - 1);
      });
      root.append(add);
    }
    if (focusAt !== null)
      (
        rows.querySelectorAll(focusKind === 'handle' ? '.cs-item-handle' : '.cs-item-text')[focusAt] as
          | HTMLElement
          | undefined
      )?.focus?.();
    focusKind = 'text';
  };
  const refreshers: (() => void)[] = [];
  const refreshAll = () => {
    for (const refresh of refreshers) refresh();
  };
  const changed = (focusAt: number | null) => {
    ctx.edited();
    // First the document (a blank direction joins it), then the rows: their paths are read from the document.
    spec.structure?.();
    render(focusAt);
  };
  const remove = (index: number) => {
    items.splice(index, 1);
    changed(null);
  };
  render();
  if (edit)
    dragOrder(rows, {
      rows: () => Array.from(rows.children) as HTMLElement[],
      idOf: (row) => row.getAttribute('data-index') ?? '',
      handle: '.ad-handle',
      onOrder: (ids) => {
        const before = [...items];
        // The row that had the focus (the handle or its field) keeps it at its new place.
        const active = (globalThis.document?.activeElement as HTMLElement | null)?.closest?.('[data-index]');
        const was = active && rows.contains(active) ? active.getAttribute('data-index') : null;
        focusKind = (globalThis.document?.activeElement as HTMLElement | null)?.classList?.contains('cs-item-handle')
          ? 'handle'
          : 'text';
        items.splice(0, items.length, ...ids.map((id) => before[Number(id)]!));
        changed(was === null ? null : ids.indexOf(was));
      },
      announce: (row, to, total) =>
        live.say(movedSentence(`${spec.label}第 ${Number(row.getAttribute('data-index')) + 1} 项`, to, total)),
    });
  return root;
}

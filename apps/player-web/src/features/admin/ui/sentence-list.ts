import { dragOrder } from './drag-order.ts';
import { growBox } from './grow-box.ts';
import { dragHandle, liveRegion, movedSentence, removeButton } from './item-controls.ts';
import { markDirty } from './unsaved.ts';

/**
 * Part 24b-7b: a list whose items are SENTENCES (说话风格, 对话风格 …; any list whose items can pass 25 characters): one row per item,
 * each a growing one-sentence box. Round 2: the row controls are the console's shared ones (ui/item-controls.ts): one drag handle, one ×,
 * Alt+↑ / Alt+↓ and the polite live announcement, exactly like 欢迎内容 and 色板. An empty list shows ONE empty row to type into;
 * that row is not data until it has text (read() never returns an empty item).
 */
export type SentenceList = {
  node: HTMLElement;
  /** The items as typed, empty rows left out. */
  read: () => string[];
  /** Whether the items differ from the ones the list started with. */
  changed: () => boolean;
  setDisabled: (disabled: boolean) => void;
};
type Row = { id: number; row: HTMLElement; handle: HTMLElement; box: HTMLTextAreaElement; del: HTMLButtonElement };
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
};

export function sentenceList(
  initial: readonly string[],
  options: { label: string; limit?: number; onChange: () => void; addText?: string },
): SentenceList {
  const root = node('div', 'sl');
  const list = node('div', 'sl-rows');
  list.setAttribute?.('role', 'list');
  const add = node('button', 'sl-add', options.addText ?? '＋ 添加一条');
  add.type = 'button';
  const live = liveRegion();
  root.append(list, add, live.node);
  // Empty items of the incoming data are not rows to show; `changed` compares what is typed with the non-empty ones.
  const original = initial.filter((text) => text.trim() !== '');
  let rows: Row[] = [];
  let seq = 0;
  let locked = false;
  const read = () => rows.map((r) => r.box.value).filter((text) => text.trim() !== '');
  const changed = () => JSON.stringify(read()) !== JSON.stringify(original);
  const paint = () => {
    rows.forEach((r, i) => {
      r.row.dataset.index = String(i + 1);
      r.box.setAttribute?.('aria-label', `${options.label} 第 ${i + 1} 条`);
      r.handle.setAttribute?.('aria-label', `${options.label}第 ${i + 1} 条：拖动排序（键盘：Alt+↑ / Alt+↓）`);
      r.del.setAttribute?.('aria-label', `删除${options.label}第 ${i + 1} 条`);
      // the lone empty row is only a place to type: it has nothing to remove, so no × is shown for it
      const idle = rows.length === 1 && r.box.value === '';
      r.del.disabled = locked || idle;
      r.del.dataset.idle = String(idle);
    });
    add.disabled = locked;
  };
  const touched = () => {
    paint();
    options.onChange();
  };
  const make = (text: string, enter: boolean): Row => {
    const row = node('div', 'sl-row');
    row.setAttribute?.('role', 'listitem');
    const id = ++seq;
    row.dataset.dragRow = '';
    row.dataset.id = String(id);
    const handle = dragHandle(options.label, 'ad-handle sl-grip');
    const box = growBox(node('textarea'), 'one');
    box.value = text;
    if (options.limit) box.maxLength = options.limit;
    box.setAttribute?.('data-was', text);
    const del = removeButton(`删除${options.label}`, 'ad-remove sl-del');
    row.append(handle, box, del);
    const record: Row = { id, row, handle, box, del };
    box.addEventListener('input', () => {
      markDirty(box, box.value !== box.getAttribute('data-was'));
      touched();
    });
    del.addEventListener('click', () => {
      if (locked) return;
      rows = rows.filter((r) => r !== record);
      row.remove();
      // the last row is never removed from the page: an empty list shows one empty row
      if (!rows.length) {
        const blank = make('', false);
        rows.push(blank);
        list.append(blank.row);
      }
      touched();
    });
    if (enter) row.classList.add('is-entering');
    return record;
  };
  for (const text of original.length ? original : ['']) {
    const r = make(text, false);
    rows.push(r);
    list.append(r.row);
  }
  add.addEventListener('click', () => {
    if (locked) return;
    const r = make('', true);
    rows.push(r);
    list.append(r.row);
    touched();
    r.box.focus?.();
  });
  dragOrder(list, {
    rows: () => rows.map((r) => r.row),
    idOf: (row) => row.dataset.id!,
    onOrder: (ids) => {
      rows = ids.map((id) => rows.find((r) => String(r.id) === id)!);
      touched();
    },
    handle: '.ad-handle',
    announce: (_row, to, total) => live.say(movedSentence(options.label, to, total)),
  });
  paint();
  return {
    node: root,
    read,
    changed,
    setDisabled: (disabled) => {
      locked = disabled;
      for (const c of root.querySelectorAll<HTMLTextAreaElement | HTMLButtonElement>('textarea,button')) {
        c.dataset.locked = String(disabled);
        c.disabled = disabled;
      }
      if (!disabled) paint();
    },
  };
}

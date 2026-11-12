import { h } from '../../cocreation/h.ts';

/**
 * Part 27: the two controls every ordered item list of the console shares (aliases / 称呼, welcome lines, palette): a drag handle
 * (pointer and touch, with motion: ui/drag-order.ts) and one × to remove the row. Keyboard reordering is Alt+↑ / Alt+↓ on a focused
 * row (the handle, or a field inside the row); every move is announced through a polite live region.
 */
export const HANDLE_HINT = '拖动排序；键盘：Alt+↑ / Alt+↓';

/** `label` names the row for a screen reader: 拖动排序：别名 第 2 项. */
export function dragHandle(label: string, className = 'ad-handle') {
  return h('button', {
    class: className,
    text: '⋮⋮',
    attrs: {
      type: 'button',
      'aria-label': `${label}：拖动排序（键盘：Alt+↑ / Alt+↓）`,
      'aria-keyshortcuts': 'Alt+ArrowUp Alt+ArrowDown',
      title: HANDLE_HINT,
    },
  });
}

/** The row's one remove control: a × with the row's name for a screen reader. */
export function removeButton(label: string, className = 'ad-remove') {
  return h('button', { class: className, text: '×', attrs: { type: 'button', 'aria-label': label, title: '删除' } });
}

/** A visually hidden polite live region; `say` replaces its text (a repeated sentence is announced again). */
export function liveRegion() {
  const node = h('span', { class: 'sr-only', attrs: { role: 'status', 'aria-live': 'polite' } });
  let flip = false;
  return {
    node,
    say(message: string) {
      flip = !flip;
      node.textContent = flip ? message : `${message}​`;
    },
  };
}

/** The sentence announced after a move: 别名 第 2 项 移到第 1 位，共 5 项. */
export const movedSentence = (name: string, to: number, total: number) => `${name}移到第 ${to + 1} 位，共 ${total} 项`;

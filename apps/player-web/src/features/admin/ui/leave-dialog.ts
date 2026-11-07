import { h } from '../../cocreation/h.ts';

export type LeaveChoice = 'save' | 'discard' | 'cancel';
const CLOSE_MS = 160;
/**
 * The one question asked before leaving a page that holds unsaved changes: 保存 (save, then leave), 不保存 (leave, the changes
 * are dropped, nothing is written) or 取消 (stay). Escape and the backdrop mean 取消; focus starts on 取消 so Enter never saves or
 * drops by accident. It opens and closes with a short fade and rise (none under reduced motion). Nothing is saved here: the caller does
 * what the answer says.
 */
export function leaveDialog(parent: HTMLElement): Promise<LeaveChoice> {
  return new Promise((resolve) => {
    const button = (text: string, choice: LeaveChoice, className: string) => {
      const node = h('button', { class: className, text, attrs: { type: 'button', 'data-leave': choice } });
      node.addEventListener('click', () => finish(choice));
      return node;
    };
    const cancel = button('取消', 'cancel', 'admin-secondary');
    const backdrop = h('div', { class: 'admin-backdrop admin-leave-backdrop', attrs: { 'data-state': 'open' } });
    const dialog = h(
      'div',
      {
        class: 'admin-dialog admin-leave-dialog',
        attrs: { role: 'alertdialog', 'aria-modal': 'true', 'aria-label': '有未保存的修改', 'data-state': 'open' },
      },
      h('h3', { text: '有未保存的修改' }),
      h(
        'div',
        { class: 'admin-dialog-actions' },
        cancel,
        button('不保存', 'discard', 'admin-secondary'),
        button('保存', 'save', 'admin-primary'),
      ),
    );
    let settled = false;
    const finish = (choice: LeaveChoice) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey);
      backdrop.setAttribute('data-state', 'closing');
      dialog.setAttribute('data-state', 'closing');
      const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
      setTimeout(
        () => {
          backdrop.remove();
          dialog.remove();
        },
        reduced ? 0 : CLOSE_MS,
      );
      resolve(choice);
    };
    const onKey = (event: Event) => {
      if ((event as KeyboardEvent).key === 'Escape') finish('cancel');
    };
    document.addEventListener('keydown', onKey);
    backdrop.addEventListener('click', () => finish('cancel'));
    parent.append(backdrop, dialog);
    cancel.focus();
  });
}

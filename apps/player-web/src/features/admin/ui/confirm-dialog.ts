import { h } from '../../cocreation/h.ts';

export type ConfirmOptions = {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Irreversible or outward-facing: the confirm button is drawn as a danger action and is not the default focus. */
  danger?: boolean;
};
/**
 * Modal confirmation. Resolves true only for an explicit press of the confirm button; Escape, the backdrop and
 * 取消 all resolve false. Focus starts on 取消 so Enter never confirms by accident.
 */
export function confirmDialog(parent: HTMLElement, options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const confirm = h('button', {
      class: options.danger ? 'admin-danger' : '',
      text: options.confirmLabel ?? '确认',
      attrs: { type: 'button' },
    });
    const cancel = h('button', {
      class: 'admin-secondary',
      text: options.cancelLabel ?? '取消',
      attrs: { type: 'button' },
    });
    const backdrop = h('div', { class: 'admin-backdrop' });
    const dialog = h(
      'div',
      { class: 'admin-dialog', attrs: { role: 'alertdialog', 'aria-modal': 'true', 'aria-label': options.title } },
      h('h3', { text: options.title }),
      h('p', { text: options.message }),
      h('div', { class: 'admin-dialog-actions' }, cancel, confirm),
    );
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
      dialog.remove();
      resolve(value);
    };
    const onKey = (event: Event) => {
      if ((event as KeyboardEvent).key === 'Escape') finish(false);
    };
    document.addEventListener('keydown', onKey);
    backdrop.addEventListener('click', () => finish(false));
    cancel.addEventListener('click', () => finish(false));
    confirm.addEventListener('click', () => finish(true));
    parent.append(backdrop, dialog);
    cancel.focus();
  });
}

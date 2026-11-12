import { h } from '../../cocreation/h.ts';

export type ConfirmOptions = {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Irreversible or outward-facing: the confirm button is drawn as a danger action and is not the default focus. */
  danger?: boolean;
  /** The confirm button is the dialog's primary action (solid), for a confirm that is the point of the dialog. */
  primary?: boolean;
};
/**
 * Modal confirmation. Resolves true only for an explicit press of the confirm button; Escape, the backdrop and
 * 取消 all resolve false. Focus starts on 取消 so Enter never confirms by accident.
 */
export function confirmDialog(parent: HTMLElement, options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    // Part 24b-7: focus returns to the opener, and Tab stays inside the dialog while it is open.
    const opener = document.activeElement as HTMLElement | null;
    const confirm = h('button', {
      class: options.danger ? 'admin-danger' : options.primary ? 'admin-primary' : '',
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
      opener?.focus?.();
      backdrop.remove();
      dialog.remove();
      resolve(value);
    };
    const onKey = (event: Event) => {
      const key = event as KeyboardEvent;
      if (key.key === 'Escape') finish(false);
      if (key.key !== 'Tab') return;
      const stops = Array.from(dialog.querySelectorAll<HTMLElement>('button'));
      const first = stops[0],
        last = stops[stops.length - 1];
      if (!first || !last) return;
      const at = document.activeElement;
      if (!dialog.contains(at as Node) || (key.shiftKey && at === first)) {
        key.preventDefault();
        (key.shiftKey && dialog.contains(at as Node) ? last : first).focus();
      } else if (!key.shiftKey && at === last) {
        key.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    backdrop.addEventListener('click', () => finish(false));
    cancel.addEventListener('click', () => finish(false));
    confirm.addEventListener('click', () => finish(true));
    parent.append(backdrop, dialog);
    cancel.focus();
  });
}

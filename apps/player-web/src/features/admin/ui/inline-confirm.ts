import { h } from '../../cocreation/h.ts';

export type InlineConfirmOptions = {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
};

/** What every view asks for: the question, and the place on its own page where the answer bar opens. */
export type ConfirmInPlace = (options: InlineConfirmOptions, host: HTMLElement) => Promise<boolean>;

const open = new WeakMap<HTMLElement, () => void>();

/**
 * Part 24b-6: a confirmation that opens IN PLACE (no dialog). The bar grows into `host` (240 ms), says what will happen and has 取消
 * and one confirm button; it resolves true only for the confirm button. Asking again in the same host closes the older bar as a no.
 * Escape inside the bar is a no. Focus starts on 取消.
 */
export function inlineConfirm(host: HTMLElement, options: InlineConfirmOptions): Promise<boolean> {
  open.get(host)?.();
  return new Promise((resolve) => {
    const cancel = h('button', { text: options.cancelLabel ?? '取消', attrs: { type: 'button' } });
    const confirm = h('button', {
      class: 'ic-go',
      text: options.confirmLabel ?? '确认',
      attrs: { type: 'button' },
    });
    const inner = h(
      'div',
      { class: 'ic-inner' },
      h(
        'div',
        { class: 'ic-body' },
        h('div', { class: 'ic-text' }, h('p', { text: options.message })),
        h('div', { class: 'ic-actions' }, cancel, confirm),
      ),
    );
    const bar = h('div', { class: 'ic', attrs: { role: 'group', 'aria-label': options.title, 'data-state': 'closed' } }, inner);
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      open.delete(host);
      bar.dataset.state = 'closed';
      setTimeout(() => bar.remove(), 260);
      resolve(value);
    };
    open.set(host, () => finish(false));
    cancel.addEventListener('click', () => finish(false));
    confirm.addEventListener('click', () => finish(true));
    bar.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Escape') finish(false);
    });
    host.append(bar);
    // One frame later, so the height can grow from nothing.
    setTimeout(() => {
      if (!settled) bar.dataset.state = 'open';
    }, 16);
    cancel.focus?.();
  });
}

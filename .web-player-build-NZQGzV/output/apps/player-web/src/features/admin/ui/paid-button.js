import { h } from "../../cocreation/h.js";
/**
 * Part 24b-6c: the paid-call confirmation lives ON the button. The idle button names what it will do and what it costs
 * ("预演 1 条 · 2 次付费调用"). The first click turns the same button into the amber "确认付费 · 2 次" with 取消 beside it for
 * PAID_CONFIRM_MS; only the second click sends. When sending is impossible the button is off and ONE short line beside it says
 * why, so there is never a silent grey button. Anything that changes what would be sent (the label) puts the button back to idle.
 */
export const PAID_CONFIRM_MS = 6000;
export function paidButton(options) {
    const set = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    const clear = options.clearTimer ?? ((handle) => clearTimeout(handle));
    const button = h('button', { class: 'pw-send', attrs: { type: 'button', 'data-state': 'idle' } });
    button.setAttribute('data-pw-send', options.name);
    const cancel = h('button', { class: 'pw-cancel', text: '取消', attrs: { type: 'button' }, hidden: true });
    cancel.setAttribute('data-pw-cancel', options.name);
    const reasonId = `pw-reason-${options.name}`;
    const reason = h('span', { class: 'pw-reason', attrs: { id: reasonId, 'data-pw-reason': options.name } });
    button.setAttribute('aria-describedby', reasonId);
    const root = h('div', { class: 'pw-sendbar', attrs: { 'data-pw-bar': options.name } }, button, cancel, reason);
    let armed = null;
    let handle = null;
    const stop = () => {
        if (handle !== null)
            clear(handle);
        handle = null;
    };
    const paint = () => {
        const why = options.reason();
        const label = options.label();
        // What the second click would send changed, or sending became impossible: back to the first click.
        if (armed !== null && (why !== '' || armed !== label)) {
            armed = null;
            stop();
        }
        const confirming = armed !== null;
        button.textContent = confirming ? options.confirmLabel() : label;
        button.setAttribute('data-state', confirming ? 'confirm' : 'idle');
        button.disabled = why !== '';
        button.dataset.locked = String(why !== '');
        cancel.hidden = !confirming;
        // Only when it changed: a link in the reason must stay the same node between the press and the release of a click.
        if (typeof why === 'string') {
            if (reason.textContent !== why || reason.children.length)
                reason.textContent = why;
        }
        else if (reason.firstChild !== why)
            reason.replaceChildren(why);
        reason.hidden = why === '';
    };
    const disarm = () => {
        armed = null;
        stop();
        paint();
    };
    button.addEventListener('click', () => {
        if (button.disabled)
            return;
        if (armed === null) {
            armed = options.label();
            stop();
            handle = set(disarm, options.ttlMs ?? PAID_CONFIRM_MS);
            paint();
            return;
        }
        disarm();
        options.onConfirm();
    });
    cancel.addEventListener('click', disarm);
    root.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && armed !== null)
            disarm();
    });
    paint();
    return {
        root,
        button,
        cancel,
        /** Repaint after the inputs, the settings or the busy state changed. */
        refresh: paint,
        disarm,
        get armed() {
            return armed !== null;
        },
        dispose: stop,
    };
}

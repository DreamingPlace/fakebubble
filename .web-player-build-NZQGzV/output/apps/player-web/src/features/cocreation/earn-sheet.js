import { h } from "./h.js";
export const earnCopy = {
    button: '获得点数',
    title: '获得点数',
    line: (s) => `写共创 +${s.notePoints}（每天最多 ${s.dailyCap} 条）· 被采用 +${s.adoptPoints}`,
    go: '去共创',
    close: '关闭',
    failed: '没能加载，稍后再试试',
};
export function openEarnSheet(options) {
    const mountPoint = options.mount ?? document.body;
    const opener = document.activeElement;
    const closeButton = h('button', {
        class: 'acct-close icon-button',
        attrs: { type: 'button', 'aria-label': earnCopy.close },
        text: '×',
    });
    const line = h('p', { class: 'earn-line', attrs: { role: 'status', 'aria-live': 'polite' } });
    const go = h('button', { class: 'acct-primary earn-go', text: earnCopy.go, attrs: { type: 'button' } });
    go.disabled = true;
    const sheet = h('div', {
        // Part 25b: a small bottom sheet in the model sheet's frame (a dim, a panel that slides up), sized to its content.
        class: 'acct-sheet mp-sheet earn-sheet',
        attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'earn-title' },
    }, h('div', { class: 'mp-panel' }, h('span', { class: 'mp-grip', attrs: { 'aria-hidden': 'true' } }), h('header', { class: 'acct-head' }, h('strong', { class: 'acct-title', text: earnCopy.title, attrs: { id: 'earn-title' } }), closeButton), h('div', { class: 'acct-body earn-body' }, line, go)));
    sheet.addEventListener('click', (event) => {
        if (event.target === sheet)
            close();
    });
    let closed = false;
    const close = () => {
        if (closed)
            return;
        closed = true;
        sheet.remove();
        document.removeEventListener?.('keydown', onKey, true);
        opener?.focus?.();
    };
    function onKey(event) {
        if (event.key === 'Escape') {
            event.stopPropagation?.();
            close();
        }
    }
    closeButton.addEventListener('click', close);
    go.addEventListener('click', () => {
        close();
        options.openCocreation();
    });
    document.addEventListener?.('keydown', onKey, true);
    mountPoint.append(sheet);
    closeButton.focus?.();
    void options.api.cocreationRewards().then((settings) => {
        if (closed)
            return;
        line.textContent = earnCopy.line(settings);
        go.disabled = false;
    }, () => {
        if (!closed)
            line.textContent = earnCopy.failed;
    });
    return { close, element: sheet };
}

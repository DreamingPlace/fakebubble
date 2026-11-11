export const GROW_ROWS = { one: 1, para: 4 };
const frame = (work) => typeof requestAnimationFrame === 'function' ? requestAnimationFrame(work) : setTimeout(work, 0);
/** Fits the box to its text now. Skipped while the box has no width (hidden): the observer fits it when it appears. */
export function fitBox(node) {
    if (!node.style || !node.clientWidth)
        return;
    node.style.height = 'auto';
    const cs = typeof getComputedStyle === 'function' ? getComputedStyle(node) : null;
    const border = cs ? parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth) : 0;
    node.style.height = `${node.scrollHeight + (Number.isFinite(border) ? border : 0)}px`;
}
export function growBox(node, kind, options = {}) {
    node.rows = GROW_ROWS[kind];
    node.dataset.grow = kind;
    node.className = `${node.className} gb`.trim();
    node.setAttribute?.('spellcheck', 'false');
    if (kind === 'one' && !options.multiline) {
        node.addEventListener('keydown', (event) => {
            const key = event;
            if (key.key === 'Enter' && !key.isComposing && !key.altKey)
                key.preventDefault();
        });
        // A pasted line break becomes nothing: a sentence is one line.
        node.addEventListener('input', () => {
            if (/[\r\n]/.test(node.value)) {
                const at = node.selectionStart ?? node.value.length;
                node.value = node.value.replace(/[\r\n]+/g, '');
                node.setSelectionRange?.(Math.min(at, node.value.length), Math.min(at, node.value.length));
            }
        });
    }
    node.addEventListener('input', () => fitBox(node));
    if (typeof ResizeObserver === 'function') {
        let width = 0;
        new ResizeObserver(() => {
            if (node.clientWidth !== width) {
                width = node.clientWidth;
                fitBox(node);
            }
        }).observe(node);
    }
    frame(() => fitBox(node));
    return node;
}
/**
 * A single-line input for a short value (a name, a code, a colour): as wide as its limit says (in characters, capped), and wider
 * when the text it holds is longer, so the text is never cut. `data-short` carries the size for the CSS.
 */
export function shortInput(node, limit, cap = 40) {
    const fit = () => {
        const held = [...node.value].length + 2;
        node.style?.setProperty('--short', `${Math.max(6, Math.min(limit, cap), held)}ch`);
    };
    node.className = `${node.className} si`.trim();
    node.dataset.short = String(Math.min(limit, cap));
    node.addEventListener('input', fit);
    fit();
    return node;
}

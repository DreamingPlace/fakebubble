import { chevron } from "./open-table.js";
/**
 * Part 24b-7b: ONE disclosure pattern for everything in the console that opens or closes (table rows with a detail below, the 预演
 * settings line, 审核对比, the rail groups, every <details>). The control shows it can be opened:
 *   - a chevron that points right when closed and turns down when open (the select motion token; none under reduced motion);
 *   - a pointer cursor, a hover background and a visible focus ring (CSS: `.dc` in the admin shell);
 *   - `aria-expanded` on the control, kept in step with the state; Enter / Space toggle it (a <button> and <summary> do natively).
 * Open-below table rows (ui/open-table.ts) already carry the same chevron and aria-expanded; they get the `dc` class there.
 */
export const disclosureChevron = () => {
    try {
        const node = chevron();
        node.setAttribute?.('class', 'ot-chevron dc-chev');
        return node;
    }
    catch {
        // a document without namespaced elements (the small DOMs of some component tests): a plain mark, drawn by the same CSS class
        const node = document.createElement('i');
        node.className = 'ot-chevron dc-chev';
        return node;
    }
};
const markClass = (control) => {
    if (!/\bdc\b/.test(control.className))
        control.className = `${control.className} dc`.trim();
};
/** A button (or any control) that shows and hides something: the chevron goes first, then the label, aria-expanded follows `open`. */
export function disclosureButton(control, label, open) {
    markClass(control);
    const text = document.createElement('span');
    text.className = 'dc-text';
    if (typeof label === 'string')
        text.textContent = label;
    else
        text.append(label);
    control.replaceChildren(disclosureChevron(), text);
    control.setAttribute?.('aria-expanded', String(open));
    return {
        set(next) {
            control.setAttribute?.('aria-expanded', String(next));
        },
    };
}
/** A <details>: its summary gets the chevron and aria-expanded (native Enter / Space toggle it); `open` is mirrored on every toggle. */
export function disclosureDetails(details, title) {
    const summary = document.createElement('summary');
    disclosureButton(summary, title, details.open === true);
    details.append(summary);
    const sync = () => summary.setAttribute?.('aria-expanded', String(details.open === true));
    details.addEventListener('toggle', sync);
    return { summary, sync };
}

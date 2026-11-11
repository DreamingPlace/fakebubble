import { h } from "../../cocreation/h.js";
/**
 * The title row every console page starts with (Part 24b-3, V3 in 24b-6): the page's name on the left; on the right ONE status line
 * (parts separated by thin rules) and the page's single solid primary button. It has one height in CSS (56 px), so the content
 * below starts on the same line on every page.
 */
export const pageHead = (title, ...right) => h('div', { class: 'page-head' }, h('h2', { text: title }), h('div', { class: 'page-head-actions' }, ...right));
/** Fills a status line: parts in a row with a thin separator. A part may be a node (a tag, an amber count) or text. */
export const fillStatus = (line, ...parts) => {
    line.replaceChildren();
    const real = parts.filter((p) => !!p);
    real.forEach((part, index) => {
        if (index > 0)
            line.append(h('i', { class: 'head-sep', attrs: { 'aria-hidden': 'true' } }));
        line.append(typeof part === 'string' ? h('span', { text: part }) : part);
    });
    return line;
};
export const statusLine = (...parts) => fillStatus(h('span', { class: 'head-status' }), ...parts);

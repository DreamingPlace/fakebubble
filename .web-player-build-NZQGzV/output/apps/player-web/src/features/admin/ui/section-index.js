import { h } from "../../cocreation/h.js";
/**
 * In-page index for a long form: one button per section that scrolls the (single) content region to it and opens a
 * collapsed section. Fewer than two sections: the index hides itself.
 */
export function sectionIndex(nav, sections) {
    nav.replaceChildren();
    nav.hidden = sections.length < 2;
    for (const { label, node } of sections) {
        const jump = h('button', { class: 'admin-secondary', text: label });
        jump.type = 'button';
        jump.addEventListener('click', () => {
            const details = node;
            if (node.tagName.toLowerCase() === 'details')
                details.open = true;
            node.scrollIntoView?.({ block: 'start' });
        });
        nav.append(jump);
    }
}

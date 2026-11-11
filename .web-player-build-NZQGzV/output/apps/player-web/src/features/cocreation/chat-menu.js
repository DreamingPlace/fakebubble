import { h } from "./h.js";
/**
 * The small "⋯" menu of a chat header. Items are read when the menu opens, so they always reflect the current access
 * (a guest sees the co-creation entry disabled, an invited player sees it active).
 */
export function mountChatMenu(button, host, items) {
    let menu = null;
    const onDocument = (event) => {
        if (menu && event.target instanceof Node && !menu.contains(event.target) && !button.contains(event.target))
            close();
    };
    const onKey = (event) => {
        const key = event.key;
        if (key === 'Escape') {
            event.stopPropagation?.();
            close();
            button.focus?.();
        }
    };
    function close() {
        if (!menu)
            return;
        menu.remove();
        menu = null;
        host.classList?.remove('menu-open');
        button.setAttribute('aria-expanded', 'false');
        document.removeEventListener?.('pointerdown', onDocument);
        document.removeEventListener?.('keydown', onKey, true);
    }
    function open() {
        const list = h('div', { class: 'chat-menu', attrs: { role: 'menu', 'aria-label': '更多' } });
        for (const item of items()) {
            const entry = h('button', { class: 'chat-menu-item', attrs: { type: 'button', role: 'menuitem' } }, h('span', { class: 'chat-menu-title', text: item.label }), item.sub ? h('span', { class: 'chat-menu-sub', text: item.sub }) : null);
            if (item.disabled) {
                entry.disabled = true;
                entry.setAttribute('aria-disabled', 'true');
            }
            entry.addEventListener('click', () => {
                if (item.disabled)
                    return;
                close();
                item.onSelect();
            });
            list.append(entry);
        }
        host.append(list);
        // A host that is itself a stacking context (the top bar) is lifted above every card while its menu is open.
        host.classList?.add('menu-open');
        menu = list;
        button.setAttribute('aria-expanded', 'true');
        document.addEventListener?.('pointerdown', onDocument);
        document.addEventListener?.('keydown', onKey, true);
        list.querySelector('.chat-menu-item:not([disabled])')?.focus?.();
    }
    button.addEventListener('click', () => (menu ? close() : open()));
    return { close, isOpen: () => menu !== null };
}

import { h } from "../../cocreation/h.js";
/** A small pill for a state such as 已发布／已撤销. The tone is data, so colour is never the only signal: the text says it. */
export function statusBadge(text, tone = 'neutral') {
    return h('span', { class: 'admin-badge', text, attrs: { 'data-tone': tone } });
}

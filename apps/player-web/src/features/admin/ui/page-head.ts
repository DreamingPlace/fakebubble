import { h } from '../../cocreation/h.ts';

/**
 * The title row every console page starts with (Part 24b-3): the page's name on the left; on the right the page's one status or main
 * action (and a date or a range switch). It has one height in CSS, so the content below starts on the same line on every page.
 */
export const pageHead = (title: string, ...right: Array<Node | null | undefined>) =>
  h('div', { class: 'page-head' }, h('h2', { text: title }), h('div', { class: 'page-head-actions' }, ...right));

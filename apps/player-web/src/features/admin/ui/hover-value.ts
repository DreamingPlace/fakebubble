import { h } from '../../cocreation/h.ts';
import { bindTip } from './tooltip.ts';

/**
 * Part 24b-6: "指到哪，数字就在哪". Any element becomes a hover target for its exact value, in the console's one light bubble
 * (ui/tooltip.ts). Mouse and keyboard focus show the same bubble. The anchor stays what it was (a table cell, a chip, a bar
 * segment); it only gains the bubble as its last child, tabindex 0 (unless it already is focusable) and an accessible description.
 */
let counter = 0;
/** The bubble of each target (a WeakMap, so the stub DOMs of the component tests need no querySelector). */
const bubbles = new WeakMap<HTMLElement, HTMLElement>();
export function hoverValue<T extends HTMLElement>(anchor: T, text: string): T {
  const existing = bubbles.get(anchor);
  if (existing) {
    existing.textContent = text;
    return anchor;
  }
  const tip = h('span', { class: 'ad-tip', text, attrs: { id: `hv-${++counter}` } });
  anchor.append(tip);
  bubbles.set(anchor, tip);
  bindTip(anchor, tip);
  anchor.setAttribute?.('aria-describedby', tip.id);
  const tag = anchor.tagName;
  if (!anchor.getAttribute?.('tabindex') && tag !== 'BUTTON' && tag !== 'A' && tag !== 'INPUT' && tag !== 'SELECT')
    anchor.setAttribute?.('tabindex', '0');
  return anchor;
}
/** The exact forms the boards show. Money keeps its full precision: $0.071 204; parts read 注册 31 / 访客 27. */
export const exactMoney = (micros: number) => {
  const dollars = micros / 1_000_000;
  const whole = Math.trunc(dollars);
  const frac = Math.round(Math.abs(dollars - whole) * 1_000_000)
    .toString()
    .padStart(6, '0');
  return `$${whole.toLocaleString('en-US')}.${frac.slice(0, 3)} ${frac.slice(3)}`;
};
export const exactCount = (value: number) => value.toLocaleString('en-US');
export const partsText = (parts: ReadonlyArray<readonly [name: string, value: number]>) =>
  parts.map(([name, value]) => `${name} ${exactCount(value)}`).join(' / ');

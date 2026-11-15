import { h } from '../../cocreation/h.ts';
import { hoverValue } from './hover-value.ts';

/**
 * Part 24b-7d: prices in the units people think in. DISPLAY ONLY: the stored value (micro-dollars per unit) is never changed and is
 * always the hover. 1 micro-dollar per token is exactly $1 per million tokens, so the number does not change, only the words.
 */
const UNIT_WORDS: Record<string, string> = { token: '百万令牌', byte: '百万字节', call: '次' };
const STORED_UNIT: Record<string, string> = { token: '令牌', byte: '字节', call: '次' };
const groupDigits = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
/** "$1.32" / "$0.0031": two decimals from $1 up, four below, whole dollars from $100, no trailing zeros past the cents. */
export function dollarText(dollars: number): string {
  const places = dollars >= 100 ? 0 : dollars >= 1 ? 2 : 4;
  const [whole = '0', frac = ''] = dollars.toFixed(places).split('.');
  const trimmed = frac.replace(/0+$/, '').padEnd(Math.min(2, places), '0');
  return `$${groupDigits(whole)}${trimmed ? `.${trimmed}` : ''}`;
}
/** The price as shown: per million tokens or bytes, per call. */
export function priceText(microsPerUnit: number, unit: string): string {
  if (unit === 'call') return `${dollarText(microsPerUnit / 1_000_000)} / 次`;
  return `${dollarText(microsPerUnit)} / ${UNIT_WORDS[unit] ?? unit}`;
}
/** What is stored, in the stored unit. */
export const storedPriceText = (microsPerUnit: number, unit: string) =>
  `存储值：${groupDigits(String(microsPerUnit))} 微美元 / ${STORED_UNIT[unit] ?? unit}`;
/** A price cell: the readable price, the exact stored value on hover. */
export function priceCell(microsPerUnit: number, unit: string, extra = ''): HTMLElement {
  const cell = h('span', {
    class: 'admin-price',
    text: priceText(microsPerUnit, unit),
    attrs: { 'data-price': 'true' },
  });
  return hoverValue(cell, `${storedPriceText(microsPerUnit, unit)}${extra ? ` · ${extra}` : ''}`);
}

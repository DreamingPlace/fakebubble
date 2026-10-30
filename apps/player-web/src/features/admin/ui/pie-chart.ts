import { bindTip } from './tooltip.ts';

/**
 * Part 24b-6: the pie (Overview3, 饼图 = by character). Slices are circles drawn with a dash, so a new set of figures slides from the
 * old shares (CSS transition). Every slice, and every row of the list beside it, is a hover and keyboard target of the light bubble.
 */
export type PieEntry = { name: string; color: string; value: number; tip: string; share: string; figure: string };
const NS = 'http://www.w3.org/2000/svg';
const CIRCUMFERENCE = 100;
const svgNode = (tag: string) =>
  (typeof document.createElementNS === 'function'
    ? document.createElementNS(NS, tag)
    : document.createElement(tag)) as unknown as SVGElement;

export function pieChart(label: string) {
  const root = document.createElement('div');
  root.className = 'pie ad-tip-bounds';
  const svg = svgNode('svg');
  svg.setAttribute('viewBox', '0 0 42 42');
  svg.setAttribute('class', 'pie-svg');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);
  const list = document.createElement('div');
  list.className = 'pie-list';
  const tip = document.createElement('span');
  tip.className = 'ad-tip pie-tip';
  root.append(svg, list, tip);
  bindTip(root, tip);
  const show = (text: string | null) => {
    if (text === null) {
      delete root.dataset.active;
      return;
    }
    tip.textContent = text;
    root.dataset.active = 'true';
  };
  root.addEventListener('mouseleave', () => show(null));
  const arcs = new Map<string, SVGElement>();
  return {
    root,
    update(entries: readonly PieEntry[], heading: string) {
      const whole = entries.reduce((sum, entry) => sum + entry.value, 0);
      let before = 0;
      const live = new Set<string>();
      svg.setAttribute('aria-label', `${label}：${entries.map((e) => `${e.name} ${e.share}`).join('，')}`);
      for (const entry of entries) {
        live.add(entry.name);
        let arc = arcs.get(entry.name);
        if (!arc) {
          arc = svgNode('circle');
          arc.setAttribute('class', 'pie-arc');
          arc.setAttribute('cx', '21');
          arc.setAttribute('cy', '21');
          arc.setAttribute('r', String(CIRCUMFERENCE / (2 * Math.PI)));
          arc.setAttribute('fill', 'none');
          arc.setAttribute('tabindex', '0');
          arcs.set(entry.name, arc);
          svg.append(arc);
        }
        const part = whole > 0 ? (entry.value / whole) * CIRCUMFERENCE : 0;
        arc.setAttribute('stroke', entry.color);
        arc.setAttribute('stroke-dasharray', `${part.toFixed(3)} ${(CIRCUMFERENCE - part).toFixed(3)}`);
        arc.setAttribute('stroke-dashoffset', String((25 - before).toFixed(3)));
        arc.setAttribute('aria-label', entry.tip);
        arc.onmouseenter = () => show(entry.tip);
        arc.onfocus = () => show(entry.tip);
        arc.onblur = () => show(null);
        before += part;
      }
      for (const [name, arc] of arcs)
        if (!live.has(name)) {
          arc.remove();
          arcs.delete(name);
        }
      list.replaceChildren();
      const title = document.createElement('span');
      title.className = 'pie-title';
      title.textContent = heading;
      list.append(title);
      for (const entry of entries) {
        const row = document.createElement('span');
        row.className = 'pie-row';
        row.setAttribute('tabindex', '0');
        const dot = document.createElement('i');
        dot.style.setProperty('--c', entry.color);
        const name = document.createElement('span');
        name.textContent = entry.name;
        const share = document.createElement('b');
        share.textContent = entry.share;
        const figure = document.createElement('span');
        figure.className = 'pie-figure';
        figure.textContent = entry.figure;
        row.append(dot, name, share, figure);
        row.onmouseenter = () => show(entry.tip);
        row.onfocus = () => show(entry.tip);
        row.onblur = () => show(null);
        list.append(row);
      }
    },
  };
}

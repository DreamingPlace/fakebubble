import { h } from '../../cocreation/h.ts';
import { hoverValue } from '../ui/hover-value.ts';
import {
  HEAT,
  directionOf,
  heatIndex,
  ratingOf,
  ratingShort,
  ratingText,
  setDirection,
  setRating,
  starFill,
  starValue,
  storiesOfPair,
  blankStory,
} from './cast-model.ts';
import { dot, svgNode, type CastCtx } from './cast-ui.ts';
import { markDirty } from '../ui/unsaved.ts';

export type GridState = {
  /** The one-way pair being edited: [row, column]. */
  pair: [string, string] | null;
  /** The cell under the pointer or keyboard focus. */
  hover: [string, string] | null;
  /** The character whose name card is open. */
  sel: string | null;
  /** The members of the group under the pointer: their rows and columns light up in the grid. */
  lit: string[] | null;
};

/**
 * 关系 (Cast3): the FIXED grid of ONE-WAY ratings (row → column) over the workbench roster. Headers are horizontal, a dot and the whole
 * name. A cell is its number on a heat colour; hovering says "A → B · 4 星 · 叫他“吉米”"; a small dot marks a pair with a shared story;
 * a changed cell is amber until it is saved. A click on a NAME opens that character, a click on a CELL opens the pair.
 */
export function castGrid(host: HTMLElement, ctx: CastCtx, state: GridState) {
  const cells = new Map<string, HTMLButtonElement>();
  const heads: { row: HTMLElement; col: HTMLElement; id: string }[] = [];
  const light = () => {
    const at = state.hover ?? state.pair;
    const group = state.lit;
    for (const [key, cell] of cells) {
      const [from, to] = key.split('\n') as [string, string];
      const lit = group ? group.includes(from) && group.includes(to) : !!at && (from === at[0] || to === at[1]);
      cell.dataset.lit = String(lit);
      cell.classList?.toggle('is-lit', lit);
      cell.dataset.dim = String((!!at || !!group) && !lit);
      cell.setAttribute('aria-pressed', String(!!state.pair && state.pair[0] === from && state.pair[1] === to));
    }
    for (const head of heads) {
      const on = group ? group.includes(head.id) : !!at && (at[0] === head.id || at[1] === head.id);
      head.row.dataset.lit = String(on);
      head.col.dataset.lit = String(on);
      head.row.dataset.open = String(state.sel === head.id);
      head.col.dataset.open = String(state.sel === head.id);
    }
  };
  const move = (from: string, to: string, dr: number, dc: number) => {
    const ids = ctx.ids();
    let r = ids.indexOf(from) + dr,
      c = ids.indexOf(to) + dc;
    for (let guard = 0; guard < ids.length; guard++) {
      if (r < 0 || c < 0 || r >= ids.length || c >= ids.length) return;
      if (r !== c) break;
      r += dr || 0;
      c += dc || 0;
    }
    cells.get(`${ids[r]}\n${ids[c]}`)?.focus();
  };
  const paint = () => {
    cells.clear();
    heads.length = 0;
    const doc = ctx.doc();
    const base = ctx.base();
    const ids = ctx.ids();
    const n = ids.length;
    const grid = h('div', { class: 'cs-grid', attrs: { role: 'grid', 'aria-label': `${n}×${n} 关系（行 → 列）` } });
    grid.style.setProperty('--n', String(n));
    grid.addEventListener('mouseleave', () => {
      state.hover = null;
      light();
    });
    grid.append(h('span', { class: 'cs-corner' }));
    const nameOf = (id: string) => ctx.nameOf(id);
    const cols = ids.map((id) => {
      const head = h('button', { class: 'cs-head cs-head-col', attrs: { type: 'button', 'aria-label': `打开 ${nameOf(id)}` } }, dot(ctx.colour(id), 8), h('span', { class: 'cs-head-name', text: nameOf(id) }));
      head.addEventListener('click', () => ctx.openCharacter(id));
      grid.append(head);
      return head;
    });
    ids.forEach((rowId, r) => {
      const rowName = nameOf(rowId);
      const head = h('button', { class: 'cs-head cs-head-row', attrs: { type: 'button', 'aria-label': `打开 ${rowName}` } }, dot(ctx.colour(rowId), 8), h('span', { class: 'cs-head-name', text: rowName }));
      head.addEventListener('click', () => ctx.openCharacter(rowId));
      grid.append(head);
      heads.push({ row: head, col: cols[r]!, id: rowId });
      ids.forEach((colId, c) => {
        if (r === c) {
          grid.append(h('span', { class: 'cs-cell is-self', attrs: { 'aria-hidden': 'true' } }));
          return;
        }
        const value = ratingOf(doc, rowId, colId);
        const address = directionOf(doc, rowId, colId)?.address ?? '';
        const tip = `${rowName} → ${nameOf(colId)} · ${value === null ? '未设置' : `${ratingText(value)} 星`}${address ? ` · 叫他“${address}”` : ''}`;
        const cell = h('button', {
          class: `cs-cell${value === null ? ' is-unset' : ''}`,
          attrs: { type: 'button', 'data-from': rowId, 'data-to': colId, 'aria-label': tip, 'aria-pressed': 'false' },
        });
        cell.style.setProperty('--heat', value === null ? 'transparent' : HEAT[heatIndex(value)!]!);
        if (value !== null) cell.textContent = ratingShort(value);
        if (storiesOfPair(doc, rowId, colId).length) cell.append(h('i', { class: 'cs-story-dot', attrs: { 'aria-hidden': 'true' } }));
        markDirty(cell, ratingOf(base, rowId, colId) !== value);
        hoverValue(cell, tip);
        cell.addEventListener('click', () => {
          state.pair = [rowId, colId];
          state.sel = null;
          light();
          ctx.paint('side', 'character', 'groups');
        });
        const hover = () => {
          state.hover = [rowId, colId];
          light();
        };
        cell.addEventListener('mouseenter', hover);
        cell.addEventListener('focus', hover);
        cell.addEventListener('keydown', (event) => {
          const key = (event as KeyboardEvent).key;
          const delta: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
          if (!delta[key]) return;
          event.preventDefault();
          move(rowId, colId, delta[key]![0], delta[key]![1]);
        });
        cells.set(`${rowId}\n${colId}`, cell);
        grid.append(cell);
      });
    });
    host.replaceChildren(
      h('div', { class: 'cs-card-head' }, h('h2', { text: '关系' }), h('span', { class: 'cs-hint-line', text: '点名字看这个人 · 点格子看两个人 · 行 → 列' })),
      grid,
      h(
        'span',
        { class: 'cs-legend' },
        h('span', { class: 'cs-legend-item' }, h('i', { class: 'cs-legend-dot' }), '有故事'),
        h('span', { class: 'cs-legend-item' }, h('i', { class: 'cs-legend-amber' }), '未保存'),
        h('span', { class: 'cs-legend-item' }, h('i', { class: 'cs-legend-unset' }), '未设置'),
      ),
    );
    light();
  };
  return { paint, light };
}

/** A real five-pointed star; the half star is the SAME path clipped to its left half (never a square drawn over it). */
export const STAR_PATH = 'M12 2.6l2.85 5.95 6.55.85-4.8 4.55 1.25 6.5L12 17.3l-5.85 3.15 1.25-6.5-4.8-4.55 6.55-.85z';

/** Five stars, each half a button: the left half sets n − 0.5, the right half n. A pressed state is told apart by more than colour. */
function stars(ctx: CastCtx, label: string, get: () => number | null, set: (value: number | null) => void, again: () => void) {
  const row = h('div', { class: 'cs-stars', attrs: { role: 'radiogroup', 'aria-label': label } });
  const value = get();
  for (let n = 1; n <= 5; n++) {
    const fill = starFill(value, n);
    const star = h('span', { class: 'cs-star', attrs: { 'data-fill': String(fill) } });
    const svg = svgNode('svg', { viewBox: '0 0 24 24', width: '28', height: '28', 'aria-hidden': 'true' });
    svg.append(svgNode('path', { d: STAR_PATH, fill: '#ece8e3', class: 'cs-star-back' }));
    if (fill === 1) svg.append(svgNode('path', { d: STAR_PATH, fill: '#e0a100', class: 'cs-star-full' }));
    if (fill === 0.5) svg.append(svgNode('path', { d: STAR_PATH, fill: '#e0a100', class: 'cs-star-half', 'clip-path': 'url(#cs-half)' }));
    star.append(svg);
    for (const half of [true, false]) {
      const target = starValue(n, half);
      const button = h('button', {
        class: `cs-star-hit ${half ? 'is-half' : 'is-whole'}`,
        attrs: { type: 'button', role: 'radio', 'aria-checked': String(value === target), 'aria-label': `${target} 星` },
      });
      if (!ctx.canEdit()) {
        button.setAttribute('data-locked', 'true');
        button.disabled = true;
      }
      button.addEventListener('click', () => {
        set(target);
        again();
      });
      star.append(button);
    }
    row.append(star);
  }
  return row;
}

/** The panel of the selected cell: the two directions between A and B (stars, 0, 未设置, 称呼, 相处) and the stories they share. */
export function pairPanel(host: HTMLElement, ctx: CastCtx, state: GridState) {
  const paint = () => {
    const doc = ctx.doc();
    const pair = state.pair;
    host.replaceChildren();
    if (!pair || !ctx.ids().includes(pair[0]) || !ctx.ids().includes(pair[1])) {
      host.hidden = true;
      return;
    }
    host.hidden = false;
    const [a, b] = pair;
    const nameA = ctx.nameOf(a),
      nameB = ctx.nameOf(b);
    const again = () => {
      ctx.edited();
      ctx.paint('grid', 'side', 'groups');
    };
    host.append(h('h2', { class: 'cs-pair-title' }, dot(ctx.colour(a), 10), nameA, h('span', { class: 'cs-with', text: '与' }), dot(ctx.colour(b), 10), nameB));
    for (const [from, to, fromName, toName] of [
      [a, b, nameA, nameB],
      [b, a, nameB, nameA],
    ] as const) {
      const value = ratingOf(doc, from, to);
      const base = ratingOf(ctx.base(), from, to);
      const line = h('div', { class: 'cs-dir', attrs: { 'data-from': from, 'data-to': to } });
      const head = h(
        'div',
        { class: 'cs-dir-head' },
        h('span', { class: 'cs-dir-label' }, dot(ctx.colour(from), 8), h('b', { class: 'cs-dir-name', text: fromName }), h('i', { class: 'cs-arrow', text: '→' }), dot(ctx.colour(to), 8), h('b', { class: 'cs-dir-name', text: toName })),
        h(
          'span',
          { class: 'cs-dir-rate' },
          stars(ctx, `${fromName} 对 ${toName}`, () => ratingOf(doc, from, to), (next) => setRating(doc, from, to, next), again),
          h('b', { class: `cs-rating${value === null ? ' is-unset' : ''}`, text: ratingText(value), attrs: { 'data-rating': value === null ? 'unset' : String(value), 'data-dirty': String(value !== base) } }),
        ),
      );
      if (ctx.canEdit()) {
        const zero = h('button', { class: 'cs-mini', text: '0', attrs: { type: 'button', 'aria-label': `${fromName} 对 ${toName}：设为 0 星`, 'aria-pressed': String(value === 0) } });
        hoverValue(zero, '陌生人');
        zero.addEventListener('click', () => {
          setRating(doc, from, to, 0);
          again();
        });
        const unset = h('button', { class: 'cs-mini', text: '未设置', attrs: { type: 'button', 'aria-label': `${fromName} 对 ${toName}：清除评分`, 'aria-pressed': String(value === null) } });
        unset.addEventListener('click', () => {
          setRating(doc, from, to, null);
          again();
        });
        head.querySelector?.('.cs-dir-rate')?.append(zero, unset);
      }
      const direction = () => directionOf(doc, from, to);
      const baseDir = directionOf(ctx.base(), from, to);
      const input = (field: 'address' | 'treatment', placeholder: string, max: number) => {
        const node = h('input', { attrs: { type: 'text', maxlength: String(max), placeholder, 'aria-label': `${fromName} ${field === 'address' ? '叫' : '怎么对'} ${toName}（${placeholder}）` } });
        node.value = direction()?.[field] ?? '';
        if (!ctx.canEdit()) node.setAttribute('readonly', '');
        node.addEventListener('input', () => {
          setDirection(doc, from, to, field, node.value);
          markDirty(node, node.value !== (baseDir?.[field] ?? ''));
          ctx.edited(true);
        });
        markDirty(node, node.value !== (baseDir?.[field] ?? ''));
        return node;
      };
      line.append(head, h('div', { class: 'cs-dir-texts' }, input('address', '称呼', 16), input('treatment', '相处', 100)));
      host.append(line);
    }
    const shared = storiesOfPair(doc, a, b);
    const write = ctx.canEdit()
      ? h('button', { class: 'cs-add', text: '+ 写他们的故事', attrs: { type: 'button' } })
      : null;
    write?.addEventListener('click', () => {
      doc.stories.push(blankStory([a, b]));
      ctx.edited();
      ctx.openStory(doc.stories.length - 1);
    });
    host.append(
      h(
        'div',
        { class: 'cs-pair-stories' },
        h('div', { class: 'cs-card-head' }, h('h3', { text: '他们一起的故事' }), write),
        ...shared.map((story) => {
          const index = doc.stories.indexOf(story);
          const row = h(
            'button',
            { class: 'cs-story-row', attrs: { type: 'button', 'aria-pressed': 'false', 'data-story': String(index) } },
            h('span', { class: 'cs-story-title', text: story.title || '（无标题）' }),
            h('span', { class: 'cs-stack' }, ...story.participants.map((id) => dot(ctx.colour(id), 10))),
          );
          row.addEventListener('click', () => ctx.openStory(index));
          return row;
        }),
        shared.length ? null : h('span', { class: 'cs-hint-line', text: '还没有' }),
      ),
    );
  };
  return { paint };
}

import { h } from '../../cocreation/h.ts';
import {
  HEAT,
  directionOf,
  heatIndex,
  nameOf,
  ratingOf,
  ratingText,
  setDirection,
  setRating,
  sharedGroups,
  starFill,
  starValue,
  storiesOfPair,
} from './cast-model.ts';
import { bound, dot, type CastCtx } from './cast-ui.ts';

export type GridState = {
  /** The one-way pair being edited: [row, column]. */
  pair: [string, string] | null;
  /** The cell under the pointer or keyboard focus. */
  hover: [string, string] | null;
  /** The character whose panel is open. */
  sel: string | null;
};

/**
 * The 15×15 grid of ONE-WAY ratings (row → column). Hovering or selecting a cell lights its row and its column (the cells keep
 * their nodes, only classes change, so a pointer sweep repaints nothing). Colour is closeness; a cell that was never set is drawn
 * apart from one that is 0.
 */
export function castGrid(host: HTMLElement, ctx: CastCtx, state: GridState) {
  const cells = new Map<string, HTMLButtonElement>();
  const heads: { row: HTMLElement; col: HTMLElement; id: string }[] = [];
  const light = () => {
    const at = state.hover ?? state.pair;
    for (const [key, cell] of cells) {
      const [from, to] = key.split('\n') as [string, string];
      const lit = !!at && (from === at[0] || to === at[1]);
      cell.classList.toggle('is-lit', lit);
      cell.classList.toggle('is-dim', !!at && !lit);
      cell.setAttribute('aria-pressed', String(!!state.pair && state.pair[0] === from && state.pair[1] === to));
    }
    for (const head of heads) {
      head.row.classList.toggle('is-lit', !!at && at[0] === head.id);
      head.col.classList.toggle('is-lit', !!at && at[1] === head.id);
      head.row.classList.toggle('is-open', state.sel === head.id);
    }
  };
  const move = (from: string, to: string, dr: number, dc: number) => {
    const ids = ctx.doc().characters.map((c) => c.characterId);
    let r = ids.indexOf(from) + dr,
      c = ids.indexOf(to) + dc;
    for (let guard = 0; guard < ids.length; guard++) {
      if (r < 0 || c < 0 || r >= ids.length || c >= ids.length) return;
      if (r !== c) break;
      r += dr || 0;
      c += dc || 0;
    }
    const next = cells.get(`${ids[r]}\n${ids[c]}`);
    next?.focus();
  };
  const paint = () => {
    cells.clear();
    heads.length = 0;
    const doc = ctx.doc();
    const n = doc.characters.length;
    const grid = h('div', {
      class: 'cs-grid',
      attrs: { role: 'grid', 'aria-label': `${n}×${n} 关系网（行 → 列）` },
    });
    grid.style.setProperty('--n', String(n));
    grid.addEventListener('mouseleave', () => {
      state.hover = null;
      light();
    });
    grid.append(h('span'));
    const cols = doc.characters.map((c, i) => {
      const name = nameOf(doc, c.characterId);
      const node = h(
        'span',
        { class: 'cs-head cs-head-col', attrs: { 'aria-hidden': 'true', title: name } },
        dot(i, name),
      );
      grid.append(node);
      return node;
    });
    doc.characters.forEach((row, r) => {
      const name = nameOf(doc, row.characterId);
      const head = h(
        'button',
        {
          class: 'cs-head cs-head-row',
          attrs: { type: 'button', title: `${name} 的资料`, 'aria-label': `打开 ${name} 的资料` },
        },
        dot(r, name),
      );
      head.addEventListener('click', () => ctx.openCharacter(row.characterId));
      grid.append(head);
      heads.push({ row: head, col: cols[r]!, id: row.characterId });
      doc.characters.forEach((col, c) => {
        if (r === c) {
          grid.append(h('span', { class: 'cs-cell is-self', attrs: { 'aria-hidden': 'true' } }));
          return;
        }
        const value = ratingOf(doc, row.characterId, col.characterId);
        const cell = h('button', {
          class: `cs-cell${value === null ? ' is-unset' : ''}`,
          attrs: {
            type: 'button',
            'data-from': row.characterId,
            'data-to': col.characterId,
            'aria-label': `${name} → ${nameOf(doc, col.characterId)}：${value === null ? '未设置' : `${ratingText(value)} 星`}`,
            'aria-pressed': 'false',
          },
        });
        cell.style.setProperty('--heat', value === null ? 'transparent' : HEAT[heatIndex(value)!]!);
        cell.addEventListener('click', () => {
          state.pair = [row.characterId, col.characterId];
          state.sel = row.characterId;
          light();
          ctx.paint('side');
        });
        const hover = () => {
          state.hover = [row.characterId, col.characterId];
          light();
        };
        cell.addEventListener('mouseenter', hover);
        cell.addEventListener('focus', hover);
        cell.addEventListener('keydown', (event) => {
          const key = (event as KeyboardEvent).key;
          const delta: Record<string, [number, number]> = {
            ArrowUp: [-1, 0],
            ArrowDown: [1, 0],
            ArrowLeft: [0, -1],
            ArrowRight: [0, 1],
          };
          if (!delta[key]) return;
          event.preventDefault();
          move(row.characterId, col.characterId, delta[key]![0], delta[key]![1]);
        });
        cells.set(`${row.characterId}\n${col.characterId}`, cell);
        grid.append(cell);
      });
    });
    host.replaceChildren(
      h(
        'div',
        { class: 'cs-card-head' },
        h('h2', { text: '关系网' }),
        h(
          'span',
          { class: 'cs-legend', attrs: { 'aria-label': '颜色越深越亲近，0 到 5 星；虚线格是还没设置' } },
          h('i', { class: 'cs-legend-unset' }),
          h('span', { text: '未设置' }),
          h('i', { class: 'cs-legend-bar' }),
          h('span', { text: '★5' }),
          h('span', { class: 'cs-mono', text: '行 → 列' }),
        ),
      ),
      grid,
    );
    light();
  };
  return { paint, light };
}

const STAR_PATH = '★';
/** Five stars, each half a button: the left half sets n − 0.5, the right half n. A pressed state is told apart by more than colour. */
function stars(
  ctx: CastCtx,
  label: string,
  get: () => number | null,
  set: (value: number | null) => void,
  again: () => void,
) {
  const row = h('div', { class: 'cs-stars', attrs: { role: 'radiogroup', 'aria-label': label } });
  const value = get();
  for (let n = 1; n <= 5; n++) {
    const fill = starFill(value, n);
    const star = h(
      'span',
      { class: 'cs-star' },
      h('b', { class: 'cs-star-glyph', text: STAR_PATH, attrs: { 'aria-hidden': 'true' } }),
    );
    star.style.setProperty('--fill', `${fill * 100}%`);
    if (value !== null && Math.ceil(value) === n && fill > 0) star.classList.add('is-pop');
    for (const half of [true, false]) {
      const target = starValue(n, half);
      const button = h('button', {
        class: `cs-star-hit ${half ? 'is-half' : 'is-whole'}`,
        attrs: {
          type: 'button',
          role: 'radio',
          'aria-checked': String(value === target),
          'aria-label': `${target} 星`,
        },
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

/** The panel of the selected cell: the two directions between A and B, each its own stars, 称呼 and 相处. */
export function pairPanel(host: HTMLElement, ctx: CastCtx, state: GridState) {
  const paint = () => {
    const doc = ctx.doc();
    const pair = state.pair;
    host.replaceChildren();
    if (
      !pair ||
      !doc.characters.some((c) => c.characterId === pair[0]) ||
      !doc.characters.some((c) => c.characterId === pair[1])
    ) {
      host.append(h('p', { class: 'cs-hint', text: '点一格，设置两个人对彼此的好感。' }));
      return;
    }
    const [a, b] = pair;
    const index = (id: string) => doc.characters.findIndex((c) => c.characterId === id);
    const nameA = nameOf(doc, a),
      nameB = nameOf(doc, b);
    const again = () => {
      ctx.edited();
      ctx.paint('grid', 'side');
    };
    host.append(
      h(
        'div',
        { class: 'cs-pair-title' },
        dot(index(a), nameA, 36),
        h('span', { class: 'cs-overlap' }, dot(index(b), nameB, 36)),
        h('h2', { text: `${nameA} · ${nameB}` }),
      ),
    );
    for (const [from, to, fromName, toName] of [
      [a, b, nameA, nameB],
      [b, a, nameB, nameA],
    ] as const) {
      const value = ratingOf(doc, from, to);
      const line = h('div', { class: 'cs-dir', attrs: { 'data-from': from, 'data-to': to } });
      line.append(
        h(
          'span',
          { class: 'cs-dir-label' },
          dot(index(from), fromName, 24),
          h('i', { class: 'cs-arrow', text: '→' }),
          dot(index(to), toName, 24),
        ),
        stars(
          ctx,
          `${fromName} 对 ${toName}`,
          () => ratingOf(doc, from, to),
          (next) => setRating(doc, from, to, next),
          again,
        ),
        h('span', {
          class: `cs-rating${value === null ? ' is-unset' : ''}`,
          text: ratingText(value),
          attrs: { 'data-rating': value === null ? 'unset' : String(value) },
        }),
      );
      if (ctx.canEdit()) {
        const zero = h('button', {
          class: 'cs-mini',
          text: '0',
          attrs: {
            type: 'button',
            'aria-label': `${fromName} 对 ${toName}：设为 0 星`,
            'aria-pressed': String(value === 0),
          },
        });
        zero.addEventListener('click', () => {
          setRating(doc, from, to, 0);
          again();
        });
        const unset = h('button', {
          class: 'cs-mini',
          text: '未设置',
          attrs: {
            type: 'button',
            'aria-label': `${fromName} 对 ${toName}：清除评分`,
            'aria-pressed': String(value === null),
          },
        });
        unset.addEventListener('click', () => {
          setRating(doc, from, to, null);
          again();
        });
        line.append(zero, unset);
      }
      host.append(line);
    }
    const texts = h('div', { class: 'cs-pair-texts' });
    for (const [from, to, fromName, toName] of [
      [a, b, nameA, nameB],
      [b, a, nameB, nameA],
    ] as const) {
      const direction = () => directionOf(doc, from, to);
      texts.append(
        h(
          'div',
          { class: 'cs-pair-col' },
          bound(
            ctx,
            `${fromName} 叫 ${toName}`,
            () => direction()?.address ?? '',
            (v) => setDirection(doc, from, to, 'address', v),
            { max: 16 },
          ).wrap,
          bound(
            ctx,
            `${fromName} 怎么对 ${toName}`,
            () => direction()?.treatment ?? '',
            (v) => setDirection(doc, from, to, 'treatment', v),
            { area: true, max: 100, rows: 3 },
          ).wrap,
        ),
      );
    }
    host.append(texts);
    const groups = sharedGroups(doc, a, b);
    host.append(
      h(
        'span',
        { class: 'cs-tags' },
        ...groups.map((g) => h('span', { class: 'cs-tag', text: g.name })),
        h('span', { class: 'cs-tag', text: `故事 ${storiesOfPair(doc, a, b).length}` }),
      ),
    );
  };
  return { paint };
}

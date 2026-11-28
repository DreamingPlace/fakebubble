/**
 * Part 39: 玩家眼中的关系. For every directed pair players have rated: how many ratings, the average, the distribution 0–5 and the
 * administrator's current grid value next to it, in the console's order. Counts only; nobody is named. The stars are opinions: this
 * view never writes the grid (only the 关系与故事 page sets stars).
 */
import { RELATION_STAR_LABELS } from '../../../../../packages/contracts/cocreation-relations.ts';
import type { CocreationRelationsClient, RelationPairStat } from '../../services/cocreation-admin-api.ts';
import { h } from '../cocreation/h.ts';
import { dot } from './cast/cast-ui.ts';
import { dataTable } from './ui/data-table.ts';
import { exactCount, hoverValue } from './ui/hover-value.ts';

type Deps = {
  api: Pick<CocreationRelationsClient, 'stats'>;
  nameOf: (id: string) => string;
  colour: (id: string) => string;
};

/** Six small bars, 0 to 5; each is a hover target with its exact count. */
const distribution = (pair: RelationPairStat) => {
  const top = Math.max(1, ...pair.distribution);
  const strip = h('span', {
    class: 'cr-dist',
    attrs: { role: 'img', 'aria-label': `星级分布：${pair.distribution.map((n, i) => `${i} 星 ${n}`).join('，')}` },
  });
  pair.distribution.forEach((n, stars) => {
    const bar = h(
      'span',
      { class: 'cr-bar', attrs: { 'data-stars': String(stars) } },
      h('i', {}),
      h('b', { class: 'is-mono', text: String(n) }),
    );
    (bar.firstElementChild as HTMLElement).style.setProperty('--h', `${Math.round((n / top) * 100)}%`);
    hoverValue(bar, `${stars} 星 · ${RELATION_STAR_LABELS[stars]} · ${exactCount(n)} 条`);
    strip.append(bar);
  });
  return strip;
};

export function relationsView(root: HTMLElement, deps: Deps) {
  const people = (id: string) =>
    h('span', { class: 'cr-who' }, dot(deps.colour(id), 8), h('b', { text: deps.nameOf(id) }));
  const table = dataTable<RelationPairStat>({
    rowKey: (row) => `${row.from}>${row.to}`,
    emptyText: '还没有玩家评过星。',
    columns: [
      {
        key: 'pair',
        label: '谁对谁',
        render: (row) =>
          h(
            'span',
            { class: 'cr-pair' },
            people(row.from),
            h('span', { class: 'cr-arrow', text: '对' }),
            people(row.to),
          ),
      },
      {
        key: 'count',
        label: '评分数',
        sortable: true,
        sortValue: (row) => row.count,
        render: (row) => exactCount(row.count),
        align: 'end',
      },
      {
        key: 'average',
        label: '平均',
        sortable: true,
        sortValue: (row) => row.average,
        render: (row) => (row.average === null ? '—' : row.average.toFixed(2)),
        align: 'end',
      },
      { key: 'dist', label: '分布（0–5 星）', render: (row) => distribution(row) },
      {
        key: 'grid',
        label: '现在的设定',
        sortable: true,
        sortValue: (row) => row.gridValue,
        render: (row) => (row.gridValue === null ? '未设置' : row.gridValue.toFixed(1)),
        align: 'end',
      },
    ],
  });
  const status = h('span', { class: 'head-status cr-view-status' });
  root.replaceChildren(table.root);
  return {
    status,
    async load() {
      const stats = await deps.api.stats();
      table.setRows(stats.pairs);
      status.textContent = `${stats.pairs.length} 个方向 · 已不计入 ${stats.excludedSubmissions} 条投稿`;
    },
  };
}

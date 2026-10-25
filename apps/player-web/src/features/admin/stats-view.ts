import {
  STATS_RANGES,
  type ChartView,
  type CohortRetention,
  type PlayerStatsView,
  type StatsRange,
} from '../../../../../packages/contracts/web-stats.ts';
import { h } from '../cocreation/h.ts';
import { CHARACTER_COLORS } from './overview-view.ts';
import { countLabel } from './ui/chart-math.ts';
import { dataTable } from './ui/data-table.ts';
import { segmented } from './ui/segmented.ts';
import { xyChart } from './ui/xy-chart.ts';

const pair = (a: number, b: number) => `${a} / ${b}`;
const retention = (c: CohortRetention | null) =>
  c === null
    ? '—'
    : `${c.retained} / ${c.cohort}${c.cohort > 0 ? `（${Math.round((c.retained / c.cohort) * 100)}%）` : ''}`;
const percentOf = (c: CohortRetention | null) =>
  c === null || c.cohort === 0 ? '—' : `${Math.round((c.retained / c.cohort) * 100)}%`;
/** '' = a reply admitted while model choice was off. */
const modelLabel = (model: string) => (model === '' ? '未选择模型' : model);
const addDays = (day: string, days: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

type Tab = 'days' | 'characters' | 'models';
const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: 'days', label: '按天' },
  { id: 'characters', label: '按角色' },
  { id: 'models', label: '按模型' },
];

/**
 * The people who chatted with each character on the newest COMPLETE UTC day (the day before `today`), by display name, from the
 * 22d chart data. A name the chart does not know reads null.
 */
export function chatPeopleByName(chart: ChartView | null, today: string): Map<string, number | null> {
  const found = new Map<string, number | null>();
  if (!chart || chart.bucket !== 'day') return found;
  const index = chart.buckets.indexOf(addDays(today, -1));
  if (index < 0) return found;
  for (const series of chart.characters) found.set(series.name, series.values[index] ?? null);
  return found;
}

/**
 * 运营 → 玩家统计. Counts per UTC day (newest first, with a totals row), per character (display NAME, with the people who chatted
 * with it) and per chosen model, for the last 7 / 30 / 90 days, five figures on top, a bar chart of the people who opened the site
 * each day, and 导出表格 of the daily table. Nothing here names a player: the server only ever sends counts.
 */
export function statsView(
  root: HTMLElement,
  deps: {
    load: (range: StatsRange) => Promise<PlayerStatsView>;
    /** 22d: chat users per character (14 days of daily buckets). Absent or failing = the 聊天人数 of a character reads —. */
    chatUsers?: (() => Promise<ChartView>) | undefined;
    exportCsv: (range: StatsRange) => Promise<{ csv: string; rows: number }>;
    download: (filename: string, text: string) => void;
    run: (work: () => Promise<void>) => Promise<void>;
    disposed: () => boolean;
  },
) {
  let range: StatsRange = 7,
    tab: Tab = 'days';
  type Row = {
    key: string;
    label: string;
    signups: number;
    newGuests: number;
    active: string;
    chat: string;
    replies: string;
    voice: number;
    deleted: number;
    inactive: number;
    expired: number;
    d1: string;
    d7: string;
  };
  const days = dataTable<Row>({
    columns: [
      { key: 'label', label: '日期（UTC）' },
      { key: 'signups', label: '新注册', align: 'end' },
      { key: 'newGuests', label: '新访客', align: 'end' },
      { key: 'active', label: '活跃（注册 / 访客）', align: 'end' },
      { key: 'chat', label: '聊天人数（注册 / 访客）', align: 'end' },
      { key: 'replies', label: '回复（成功 / 失败 / 未知）', align: 'end' },
      { key: 'voice', label: '语音回复', align: 'end' },
      { key: 'deleted', label: '删除账号', align: 'end' },
      { key: 'inactive', label: '不活跃清理', align: 'end' },
      { key: 'expired', label: '试用到期清理', align: 'end' },
      { key: 'd1', label: '次日留存', align: 'end' },
      { key: 'd7', label: '7 日留存', align: 'end' },
    ],
    rowKey: (row) => row.key,
    emptyText: '还没有统计数据。玩家访问或聊天之后，每日数字会显示在这里。',
    caption: '玩家统计（按天）',
  });
  const characters = h('div', { class: 'stat-characters' });
  const charactersEmpty = h('p', { class: 'admin-empty', text: '这段时间还没有回复。', hidden: true });
  const characterBox = h(
    'div',
    { class: 'stat-characters-box', attrs: { 'aria-label': '玩家统计（按角色）' } },
    characters,
    charactersEmpty,
  );
  const models = dataTable<PlayerStatsView['byModel'][number]>({
    columns: [
      { key: 'model', label: '模型', render: (row) => modelLabel(row.model) },
      { key: 'published', label: '回复（成功）', align: 'end' },
      { key: 'failed', label: '回复（失败）', align: 'end' },
      { key: 'unknown', label: '回复（未知）', align: 'end' },
      { key: 'voice', label: '语音回复', align: 'end' },
    ],
    rowKey: (row) => row.model,
    emptyText: '这段时间还没有回复。',
    caption: '玩家统计（按模型）',
  });

  const rangeSwitch = segmented(
    '时间范围',
    STATS_RANGES.map((n) => ({ id: String(n), label: `最近 ${n} 天` })),
    String(range),
    (id) => {
      range = Number(id) as StatsRange;
      void deps.run(() => load());
    },
    'm',
  );
  const exportButton = h('button', { class: 'admin-secondary', text: '导出表格', attrs: { type: 'button' } });
  exportButton.addEventListener('click', () => void deps.run(() => exportTable()));
  const since = h('span', { class: 'page-kicker', attrs: { role: 'status' } });
  const kpis = h('div', { class: 'stat-kpis' });
  const active = xyChart();
  const activeCard = h(
    'section',
    { class: 'stat-active', attrs: { 'aria-label': '每天活跃' } },
    h(
      'div',
      { class: 'cost-chart-bar' },
      h('h3', { text: '每天活跃' }),
      h(
        'span',
        { class: 'ov-legend' },
        h('span', { class: 'ov-chip' }, h('i', { class: 'ov-dot is-registered' }), '注册玩家'),
        h('span', { class: 'ov-chip' }, h('i', { class: 'ov-dot is-guest' }), '访客'),
      ),
    ),
    active.root,
  );
  // No tabs: 按天 on top, 按角色 and 按模型 side by side under it.
  const card = (title: string, ...children: HTMLElement[]) =>
    h('section', { class: 'stat-detail', attrs: { 'aria-label': title } }, h('h3', { text: title }), ...children);
  root.replaceChildren(
    h(
      'div',
      { class: 'page-head' },
      h('div', {}, since, h('h2', { text: '玩家统计' })),
      h('div', { class: 'ov-chart-tools' }, rangeSwitch.root, exportButton),
    ),
    kpis,
    activeCard,
    card('按天', days.root),
    h('div', { class: 'stat-pair' }, card('按角色', characterBox), card('按模型', models.root)),
  );

  const kpi = (label: string, value: string, sub: string) =>
    h(
      'div',
      { class: 'overview-card' },
      h('span', { class: 'overview-label', text: label }),
      h('strong', { text: value }),
      h('span', { class: 'overview-sub', text: sub }),
    );

  async function load() {
    const [view, chat] = await Promise.all([
      deps.load(range),
      deps.chatUsers ? deps.chatUsers().catch(() => null) : Promise.resolve(null),
    ]);
    if (deps.disposed()) return;
    since.textContent = view.since === null ? '统计尚未开始。' : `统计自 ${view.since} 起（UTC）`;
    const row = (key: string, label: string, r: PlayerStatsView['totals']): Row => ({
      key,
      label,
      signups: r.signups,
      newGuests: r.newGuests,
      active: pair(r.activeRegistered, r.activeGuests),
      chat: pair(r.chatRegistered, r.chatGuests),
      replies: `${r.repliesPublished} / ${r.repliesFailed} / ${r.repliesUnknown}`,
      voice: r.voiceReplies,
      deleted: r.deletedAccounts,
      inactive: r.inactivePurged,
      expired: r.expiredPurged,
      d1: retention(r.d1),
      d7: retention(r.d7),
    });
    days.setRows(
      view.days.length
        ? [...view.days.map((day) => row(day.day, day.day, day)), row('total', '合计', view.totals)]
        : [],
    );
    models.setRows(view.byModel);

    // ---- five figures: yesterday is the newest complete UTC day ----
    // The newest row is the server's today; yesterday is the row right before it, when the counters ran that day.
    const today = view.days[0]?.day ?? '';
    const yesterday = today && view.days[1]?.day === addDays(today, -1) ? view.days[1]! : null;
    kpis.replaceChildren(
      kpi(
        '昨天活跃',
        yesterday ? String(yesterday.activeRegistered + yesterday.activeGuests) : '—',
        yesterday ? `注册 ${yesterday.activeRegistered} · 访客 ${yesterday.activeGuests}` : '注册 — · 访客 —',
      ),
      kpi('新注册', view.days.length ? String(view.totals.signups) : '—', `最近 ${range} 天`),
      kpi(
        '昨天聊天人数',
        yesterday ? String(yesterday.chatRegistered + yesterday.chatGuests) : '—',
        yesterday ? `注册 ${yesterday.chatRegistered} · 访客 ${yesterday.chatGuests}` : '注册 — · 访客 —',
      ),
      kpi(
        '次日留存',
        percentOf(view.totals.d1),
        view.totals.d1 ? `${view.totals.d1.retained} / ${view.totals.d1.cohort}` : '注册玩家',
      ),
      kpi(
        '7 日留存',
        percentOf(view.totals.d7),
        view.totals.d7 ? `${view.totals.d7.retained} / ${view.totals.d7.cohort}` : '注册玩家',
      ),
    );

    // ---- 每天活跃: registered players and guests who opened the site, oldest day first ----
    const chronological = [...view.days].reverse();
    activeCard.hidden = chronological.length === 0;
    const step = Math.max(1, Math.ceil(chronological.length / 7));
    active.update({
      mode: 'bar',
      series: [
        {
          id: 'registered',
          name: '注册玩家',
          color: '#141414',
          values: chronological.map((d) => d.activeRegistered),
          on: true,
        },
        { id: 'guests', name: '访客', color: '#BDB5AC', values: chronological.map((d) => d.activeGuests), on: true },
      ],
      buckets: chronological.map((d) => d.day),
      ticks: chronological
        .map((d, index) => ({ index, label: d.day.slice(5) }))
        .filter((tick) => tick.index % step === 0 || tick.index === chronological.length - 1),
      axisLabel: countLabel,
      valueLabel: countLabel,
      ariaLabel: '每天活跃',
    });

    // ---- 按角色: a card each, with the people who chatted with it ----
    const people = chatPeopleByName(chat, today);
    const replies = view.byCharacter.reduce((sum, c) => sum + c.published, 0);
    charactersEmpty.hidden = view.byCharacter.length > 0;
    characters.replaceChildren(
      ...view.byCharacter.map((c, i) => {
        const share = replies > 0 ? Math.round((c.published / replies) * 100) : 0;
        const talked = people.get(c.name);
        const cardNode = h(
          'article',
          { class: 'stat-character', attrs: { 'data-character': c.name } },
          h('span', { class: 'stat-character-name' }, h('i', { class: 'ov-dot' }), c.name),
          h('span', { class: 'stat-character-count' }, h('b', { text: String(c.published) }), ' 条回复'),
          h(
            'span',
            { class: 'stat-character-sub' },
            `语音 ${c.voice} · 失败 ${c.failed} · 未知 ${c.unknown} · `,
            h('span', {
              text: `聊天人数 ${talked === undefined || talked === null ? '—' : talked}`,
              attrs: { title: '昨天（UTC）' },
            }),
          ),
          h(
            'span',
            {
              class: 'stat-share',
              attrs: {
                role: 'meter',
                'aria-valuemin': '0',
                'aria-valuemax': '100',
                'aria-valuenow': String(share),
                'aria-label': `占全部回复 ${share}%`,
              },
            },
            h('span', { class: 'stat-share-fill' }),
          ),
          h('span', { class: 'stat-share-text', text: `占全部回复 ${share}%` }),
        );
        (cardNode.querySelector('.ov-dot') as HTMLElement).style.setProperty(
          '--c',
          CHARACTER_COLORS[i % CHARACTER_COLORS.length]!,
        );
        (cardNode.querySelector('.stat-share-fill') as HTMLElement).style.setProperty('--w', `${share}%`);
        (cardNode.querySelector('.stat-share-fill') as HTMLElement).style.setProperty(
          '--c',
          CHARACTER_COLORS[i % CHARACTER_COLORS.length]!,
        );
        return cardNode;
      }),
    );
  }
  async function exportTable() {
    const { csv } = await deps.exportCsv(range);
    if (!deps.disposed()) deps.download(`玩家统计-最近${range}天.csv`, csv);
  }
  return {
    load,
    clear() {
      since.textContent = '';
      days.setRows([]);
      models.setRows([]);
      characters.replaceChildren();
      kpis.replaceChildren();
    },
  };
}

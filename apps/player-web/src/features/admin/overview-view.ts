import type { OverviewView } from '../../../../../packages/contracts/web-system.ts';
import { colourOfName } from './ui/character-colour.ts';
import {
  STATS_RANGES,
  type ChartMetric,
  type ChartRange,
  type ChartView,
  type CohortRetention,
  type PlayerStatsDay,
  type PlayerStatsView,
  type StatsRange,
} from '../../../../../packages/contracts/web-stats.ts';
import { h } from '../cocreation/h.ts';
import { dollars } from './system-format.ts';
import { rmb } from './costs-view.ts';
import { countLabel } from './ui/chart-math.ts';
import { exactCount, exactMoney, hoverValue, partsText } from './ui/hover-value.ts';
import { rollNumber } from './ui/number-roll.ts';
import { buildSplit, figureOf, SPLITS, type Split, type SplitData } from './overview-split.ts';
import { openTable, type OpenColumn } from './ui/open-table.ts';
import { fillStatus, pageHead } from './ui/page-head.ts';
import { pieChart, type PieEntry } from './ui/pie-chart.ts';
import { segmented } from './ui/segmented.ts';
import { xyChart, type XySeries } from './ui/xy-chart.ts';

/** The one-line summary of the 系统状态 warnings; null when there is nothing to say. */
export function warningLine(warnings: OverviewView['warnings']) {
  const parts = [
    warnings.priceExpiring > 0 ? `${exactCount(warnings.priceExpiring)} 项价格即将到期` : null,
    warnings.retentionFailing > 0 ? `${exactCount(warnings.retentionFailing)} 位玩家的清理失败` : null,
    warnings.unknownNew > 0 ? `近 24 小时新增 ${exactCount(warnings.unknownNew)} 次结果未确认的调用` : null,
  ].filter((part): part is string => part !== null);
  return parts.length ? parts.join(' · ') : null;
}

/** One colour per character in the order the server sends them (most replies first); the rest are one grey. */
const CHARACTER_COLORS = ['#1D4ED8', '#B45309', '#BE185D', '#0E7490', '#4D7C0F', '#6D28D9', '#C2410C', '#9D174D'];
const OTHER_COLOUR = '#C9C2B8';
const SHOWN_CHARACTERS = 4;
const PRIMARY = '#5B4FC4';
const DANGER = '#B23A26';

/** 总览's range: the whole page follows it. 24H is hourly (the chart endpoint); the others are the player statistics' 7 / 30 / 90 days. */
type Span = '24h' | StatsRange;
const SPANS: ReadonlyArray<{ id: Span; label: string }> = [
  { id: '24h', label: '24H' },
  ...STATS_RANGES.map((n) => ({ id: n, label: `${n}天` })),
];
type Metric = 'replies' | 'chat' | 'active';
const METRICS: ReadonlyArray<{ id: Metric; label: string; unit: string }> = [
  { id: 'replies', label: '回复', unit: '条' },
  { id: 'chat', label: '聊天人数', unit: '人' },
  { id: 'active', label: '活跃', unit: '人' },
];
type Kind = 'line' | 'bar' | 'pie';
const KINDS: ReadonlyArray<{ id: Kind; label: string }> = [
  { id: 'line', label: '折线' },
  { id: 'bar', label: '柱状' },
  { id: 'pie', label: '饼图' },
];

/** The label of a bucket: 'HH:00' for an hour ('YYYY-MM-DDTHH'), 'MM-DD' for a day on the axis, the whole date in tables. */
const bucketLabel = (bucket: string, short: boolean) =>
  bucket.length > 10 ? `${bucket.slice(11, 13)}:00` : short ? bucket.slice(5) : bucket;

const sum = (values: readonly (number | null)[]) => values.reduce<number>((a, b) => a + (b ?? 0), 0);
/** The last value that is known (the newest bucket the counters were running for). */
const latest = (values: readonly (number | null)[]) => {
  for (let i = values.length - 1; i >= 0; i--) if (values[i] !== null) return values[i]!;
  return null;
};
/**
 * What the chart shows for one series: replies add up over the window; players do not (a player who chats on two days is two
 * points but one person), so 聊天人数 shows the newest bucket's count instead of a sum.
 */
export const seriesFigure = (metric: ChartMetric, values: readonly (number | null)[]) =>
  metric === 'replies' ? (values.every((v) => v === null) ? null : sum(values)) : latest(values);

const addDays = (day: string, days: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const pct = (c: CohortRetention | null) =>
  c === null || c.cohort === 0 ? '—' : `${Math.round((c.retained / c.cohort) * 100)}%`;
const modelLabel = (model: string) => (model === '' ? '未选择模型' : model);

export type OverviewDeps = {
  load: () => Promise<OverviewView>;
  run: (work: () => Promise<void>) => Promise<void>;
  disposed: () => boolean;
  /** 24H and the people per character: the 22d chart endpoint (the owner and stats.read). */
  chart?:
    | {
        load: (metric: ChartMetric, range: ChartRange) => Promise<ChartView>;
        available?: () => boolean;
      }
    | undefined;
  /** The player statistics (the owner and stats.read): the day table, the splits, the trend and the CSV. */
  stats?:
    | {
        load: (range: StatsRange) => Promise<PlayerStatsView>;
        exportCsv: (range: StatsRange) => Promise<{ csv: string; rows: number }>;
        download: (filename: string, text: string) => void;
        available?: () => boolean;
      }
    | undefined;
};

/**
 * 总览 (Overview3), with 玩家统计 merged in. The title row has the UTC day, the 系统状态 warning and ONE range for the whole page;
 * under it eight number tiles (two rows of four), the trend card (回复 / 聊天人数 / 活跃 × 折线 / 柱状 / 饼图), the 按天 table and
 * 按角色 beside 按模型. Every number is a hover target for its exact value. An administrator without stats.read sees today's two
 * tiles and the warning only.
 */
export function overviewView(root: HTMLElement, deps: OverviewDeps) {
  let span: Span = 7;
  let metric: Metric = 'replies';
  let kind: Kind = 'line';
  let overview: OverviewView | null = null;
  let stats: PlayerStatsView | null = null;
  let hourly: { replies: ChartView | null; chat: ChartView | null } = { replies: null, chat: null };
  let people: ChartView | null = null;
  // Part 24b-7e: the one split of the whole page (全部 / 按角色 / 按模型): the trend chart AND the 统计表 follow it.
  let split: Split = 'all';
  const hiddenSeries = new Set<string>();
  const splitViews = new Map<string, ChartView>();

  const status = h('span', { class: 'head-status' });
  const rangeSwitch = segmented(
    '时间范围',
    SPANS.map((s) => ({ id: String(s.id), label: s.label })),
    String(span),
    (id) => {
      span = id === '24h' ? '24h' : (Number(id) as StatsRange);
      if (span === '24h' && metric === 'active') setMetric('replies');
      paintMetricTabs();
      void deps.run(loadRange);
    },
    'm',
  );
  const exportButton = h('button', { text: '导出表格', attrs: { type: 'button' } });
  exportButton.addEventListener('click', () => void deps.run(exportTable));
  const head = pageHead('总览', status, rangeSwitch.root, exportButton);

  // ---- tiles ----
  const tiles = h('section', { class: 'ov-tiles', attrs: { 'aria-label': '数字' } });

  // ---- trend ----
  const metricSwitch = segmented(
    '指标',
    METRICS.map(({ id, label }) => ({ id, label })),
    metric,
    (id) => {
      metric = id;
      hiddenSeries.clear();
      paintSplitTabs();
      paintTableMode();
      if (split === 'all') {
        paintTrend();
        return;
      }
      paintTableMode();
      void deps.run(async () => {
        await ensureSplitView();
        if (deps.disposed()) return;
        paintTrend(true);
      });
    },
    'm',
  );
  const kindSwitch = segmented(
    '图表类型',
    KINDS.map(({ id, label }) => ({ id, label })),
    kind,
    (id) => {
      kind = id;
      paintTrend();
    },
    'm',
  );
  const splitSwitch = segmented<Split>(
    '分组',
    SPLITS.map(({ id, label }) => ({ id, label })),
    split,
    (id) => {
      split = id;
      hiddenSeries.clear();
      paintSplitTabs();
      paintTableMode();
      void deps.run(async () => {
        await ensureSplitView();
        if (deps.disposed()) return;
        paintTrend(true);
        paintSplits();
      });
    },
    'm',
  );
  const legend = h('span', { class: 'ovx-legend' });
  const chart = xyChart();
  const chartBox = h('div', { class: 'ovx-pane ovx-line' }, chart.root);
  const pie = pieChart('按角色的占比');
  const pieBox = h('div', { class: 'ovx-pane ovx-pie-pane' }, pie.root);
  const trendEmpty = h('p', { class: 'ovx-empty', text: '还没有数据。', hidden: true });
  const trend = h(
    'section',
    { class: 'ovx-trend', attrs: { 'aria-label': '趋势' } },
    h(
      'div',
      { class: 'ovx-bar' },
      h('div', { class: 'ovx-switches' }, metricSwitch.root, splitSwitch.root),
      h('div', { class: 'ovx-tools' }, kindSwitch.root),
    ),
    legend,
    chartBox,
    pieBox,
    trendEmpty,
  );

  // ---- 按天 ----
  type DayRow = { key: string; label: string; counts: PlayerStatsDay | PlayerStatsView['totals']; total: boolean };
  const num = (n: number) => exactCount(n);
  const dayColumns: OpenColumn<DayRow>[] = [
    {
      key: 'day',
      label: '日期 UTC',
      width: '130px',
      mono: true,
      cell: (r) => r.label,
      tip: (r) => (r.total ? null : `${r.label} UTC`),
    },
    {
      key: 'signups',
      label: '新注册',
      align: 'end',
      mono: true,
      cell: (r) => num(r.counts.signups),
      tip: (r) => exactCount(r.counts.signups),
    },
    {
      key: 'guests',
      label: '新访客',
      align: 'end',
      mono: true,
      cell: (r) => num(r.counts.newGuests),
      tip: (r) => exactCount(r.counts.newGuests),
    },
    {
      key: 'active',
      label: '活跃',
      align: 'end',
      mono: true,
      headTip: '注册 / 访客',
      cell: (r) => num(r.counts.activeRegistered + r.counts.activeGuests),
      tip: (r) =>
        partsText([
          ['注册', r.counts.activeRegistered],
          ['访客', r.counts.activeGuests],
        ]),
    },
    {
      key: 'chat',
      label: '聊天人数',
      align: 'end',
      mono: true,
      headTip: '注册 / 访客',
      cell: (r) => num(r.counts.chatRegistered + r.counts.chatGuests),
      tip: (r) =>
        partsText([
          ['注册', r.counts.chatRegistered],
          ['访客', r.counts.chatGuests],
        ]),
    },
    {
      key: 'replies',
      label: '回复',
      align: 'end',
      mono: true,
      headTip: '成功 / 失败 / 未知',
      cell: (r) => num(r.counts.repliesPublished + r.counts.repliesFailed + r.counts.repliesUnknown),
      tip: (r) =>
        partsText([
          ['成功', r.counts.repliesPublished],
          ['失败', r.counts.repliesFailed],
          ['未知', r.counts.repliesUnknown],
        ]),
    },
    {
      key: 'voice',
      label: '语音回复',
      align: 'end',
      mono: true,
      cell: (r) => num(r.counts.voiceReplies),
      tip: (r) => exactCount(r.counts.voiceReplies),
    },
    {
      key: 'deleted',
      label: '删除账号',
      align: 'end',
      mono: true,
      cell: (r) => num(r.counts.deletedAccounts),
      tip: (r) => exactCount(r.counts.deletedAccounts),
    },
    {
      key: 'clean',
      label: '清理',
      align: 'end',
      mono: true,
      headTip: '不活跃清理 / 试用到期清理',
      cell: (r) => num(r.counts.inactivePurged + r.counts.expiredPurged),
      tip: (r) =>
        partsText([
          ['不活跃', r.counts.inactivePurged],
          ['试用到期', r.counts.expiredPurged],
        ]),
    },
    {
      key: 'd1',
      label: '次日留存',
      align: 'end',
      mono: true,
      cell: (r) => pct(r.counts.d1),
      tip: (r) => (r.counts.d1 ? `${r.counts.d1.retained} / ${r.counts.d1.cohort}` : '还要等一天'),
    },
    {
      key: 'd7',
      label: '7 日留存',
      align: 'end',
      mono: true,
      cell: (r) => pct(r.counts.d7),
      tip: (r) => (r.counts.d7 ? `${r.counts.d7.retained} / ${r.counts.d7.cohort}` : '要满 7 天才有'),
    },
  ];
  // Part 24b-7b: every column sorts (the 合计 row stays last).
  const ratio = (c: CohortRetention | null) => (c && c.cohort ? c.retained / c.cohort : null);
  const daySort: Record<string, (r: DayRow) => number | string | null> = {
    day: (r) => r.label,
    signups: (r) => r.counts.signups,
    guests: (r) => r.counts.newGuests,
    active: (r) => r.counts.activeRegistered + r.counts.activeGuests,
    chat: (r) => r.counts.chatRegistered + r.counts.chatGuests,
    replies: (r) => r.counts.repliesPublished + r.counts.repliesFailed + r.counts.repliesUnknown,
    voice: (r) => r.counts.voiceReplies,
    deleted: (r) => r.counts.deletedAccounts,
    clean: (r) => r.counts.inactivePurged + r.counts.expiredPurged,
    d1: (r) => ratio(r.counts.d1),
    d7: (r) => ratio(r.counts.d7),
  };
  for (const column of dayColumns) column.sortValue = daySort[column.key]!;
  const days = openTable<DayRow>({
    label: '玩家统计（按天）',
    className: 'ov-days',
    rowKey: (r) => r.key,
    columns: dayColumns,
    emptyText: '还没有统计数据。玩家访问或聊天之后，每日数字会显示在这里。',
    rowClass: (r) => (r.total ? 'is-total' : ''),
    pinLast: (r) => r.total,
  });

  // ---- 按角色 / 按模型: the same table, other rows (the columns that apply: 成功 / 失败 / 未知 / 回复 / 语音回复) ----
  type SplitRow = {
    key: string;
    label: string;
    published: number;
    failed: number;
    unknown: number;
    voice: number;
    total: boolean;
    tip: string | null;
    /** Every replies of the table this row is in (for 占比). */
    whole: number;
  };
  const splitColumns = (first: string): OpenColumn<SplitRow>[] => [
    { key: 'name', label: first, mono: false, cell: (r) => r.label, tip: (r) => r.tip, sortValue: (r) => r.label },
    {
      key: 'published',
      label: '成功',
      align: 'end',
      mono: true,
      cell: (r) => num(r.published),
      tip: (r) => exactCount(r.published),
      sortValue: (r) => r.published,
    },
    {
      key: 'failed',
      label: '失败',
      align: 'end',
      mono: true,
      cell: (r) => num(r.failed),
      tip: (r) => exactCount(r.failed),
      sortValue: (r) => r.failed,
    },
    {
      key: 'unknown',
      label: '未知',
      align: 'end',
      mono: true,
      cell: (r) => num(r.unknown),
      tip: (r) => exactCount(r.unknown),
      sortValue: (r) => r.unknown,
    },
    {
      key: 'replies',
      label: '回复',
      align: 'end',
      mono: true,
      headTip: '成功 + 失败 + 未知',
      cell: (r) => num(r.published + r.failed + r.unknown),
      tip: (r) =>
        partsText([
          ['成功', r.published],
          ['失败', r.failed],
          ['未知', r.unknown],
        ]),
      sortValue: (r) => r.published + r.failed + r.unknown,
    },
    {
      key: 'voice',
      label: '语音回复',
      align: 'end',
      mono: true,
      cell: (r) => num(r.voice),
      tip: (r) => exactCount(r.voice),
      sortValue: (r) => r.voice,
    },
    {
      key: 'share',
      label: '占比',
      align: 'end',
      mono: true,
      headTip: '这一行的回复占全部回复的比例',
      cell: (r) => shareOf(r),
      tip: (r) => `${exactCount(r.published + r.failed + r.unknown)} / ${exactCount(r.whole)}`,
      sortValue: (r) => r.published + r.failed + r.unknown,
    },
  ];
  // 占比: a row's replies over the replies of every row (the 合计 row is 100%).
  const shareOf = (r: SplitRow) =>
    r.whole > 0 ? `${Math.round(((r.published + r.failed + r.unknown) / r.whole) * 1000) / 10}%` : '—';
  /** The per-day values of one row, read from the same chart data the 趋势 draws (published replies per UTC day, names only). */
  const dayDetail =
    (kindOfSplit: 'character' | 'model', chat = false) =>
    async (row: SplitRow) => {
      if (row.total) return h('p', { class: 'admin-hint', text: '合计没有逐日明细。' });
      if (span === '24h' || !chartOn()) return h('p', { class: 'admin-hint', text: '这段时间没有逐日数据。' });
      const metricName: ChartMetric = chat ? 'chat_users' : 'replies';
      const key = `${metricName}|${rangeId()}`;
      if (!splitViews.has(key)) splitViews.set(key, await deps.chart!.load(metricName, rangeId()));
      const view = splitViews.get(key)!;
      const own = (kindOfSplit === 'character' ? view.characters : view.models)?.find(
        (s) => (kindOfSplit === 'model' ? modelLabel(s.name) : s.name) === row.label,
      );
      if (!own) return h('p', { class: 'admin-hint', text: '这段时间没有逐日数据。' });
      const lines = view.buckets.map((bucket, i) => ({ bucket, value: own.values[i] ?? null })).reverse();
      return h(
        'div',
        { class: 'ov-split-days' },
        h('p', {
          class: 'admin-hint',
          text: `${row.label} · ${chat ? '每天的聊天人数' : '每天的成功回复'}（UTC，新的在前）`,
        }),
        h(
          'ul',
          { class: 'ov-split-day-list' },
          ...lines.map((l) =>
            h(
              'li',
              {},
              h('span', { class: 'is-mono', text: l.bucket }),
              hoverValue(
                h('b', { class: 'is-mono', text: l.value === null ? '—' : exactCount(l.value) }),
                l.value === null ? '这天还没有开始统计' : `${exactCount(l.value)} ${chat ? '人' : '条'}`,
              ),
            ),
          ),
        ),
      );
    };
  const byCharacter = openTable<SplitRow>({
    label: '玩家统计（按角色）',
    className: 'ov-by',
    detail: dayDetail('character'),
    rowKey: (r) => r.key,
    columns: splitColumns('角色'),
    emptyText: '这段时间还没有回复。',
    rowClass: (r) => (r.total ? 'is-total' : ''),
    pinLast: (r) => r.total,
  });
  // 聊天人数 × 按角色: a player who chatted with two characters is in both rows, so the rows do not add up to a whole and 占比 is not
  // shown. The counts stay; this is the same table without that column.
  const byCharacterChat = openTable<SplitRow>({
    label: '玩家统计（按角色，聊天人数）',
    className: 'ov-by',
    detail: dayDetail('character', true),
    rowKey: (r) => r.key,
    columns: splitColumns('角色').filter((c) => c.key !== 'share'),
    emptyText: '这段时间还没有回复。',
    rowClass: (r) => (r.total ? 'is-total' : ''),
    pinLast: (r) => r.total,
  });
  const byModel = openTable<SplitRow>({
    label: '玩家统计（按模型）',
    className: 'ov-by',
    detail: dayDetail('model'),
    rowKey: (r) => r.key,
    columns: splitColumns('模型'),
    emptyText: '这段时间还没有回复。',
    rowClass: (r) => (r.total ? 'is-total' : ''),
    pinLast: (r) => r.total,
  });
  // Part 24b-7e: the 统计表 has no switch of its own; the page's 全部 / 按角色 / 按模型 chooses its rows.
  type TableMode = 'day' | 'character' | 'model';
  const tableModeOf = (): TableMode => (split === 'all' ? 'day' : split);
  const tableNote = h('span', { class: 'ov-table-note', hidden: true });
  const tableTitle = h('h3', { text: '统计表' });
  const daysCard = h(
    'section',
    { class: 'ov-card ad-tip-bounds', attrs: { 'aria-label': '统计表' } },
    h('div', { class: 'ov-table-head' }, tableTitle, h('div', { class: 'ovx-tools' }, tableNote)),
    days.root,
    byCharacter.root,
    byCharacterChat.root,
    byModel.root,
  );
  function paintTableMode() {
    const tableMode = tableModeOf();
    days.root.hidden = tableMode !== 'day';
    const chatRoles = metric === 'chat';
    byCharacter.root.hidden = tableMode !== 'character' || chatRoles;
    byCharacterChat.root.hidden = tableMode !== 'character' || !chatRoles;
    byModel.root.hidden = tableMode !== 'model';
    tableNote.hidden = !(span === '24h' && tableMode !== 'day');
    tableNote.textContent = '近 7 天';
  }
  paintTableMode();

  root.replaceChildren(head, tiles, trend, daysCard);

  function setMetric(next: Metric) {
    metric = next;
    metricSwitch.set(next);
  }
  /** Why a split is not offered for this metric and range (null when it is). Never a guess: no data, no tab. */
  function splitDisabledReason(next: Exclude<Split, 'all'>): string | null {
    if (metric === 'active') return '活跃是按玩家统计的，没有按角色或按模型的数据。';
    if (!chartOn()) return '这个账号读不到按角色、按模型的数据。';
    if (next === 'model' && metric === 'chat') return '聊天人数是按角色统计的，没有按模型的数据。';
    if (next === 'model' && span === '24h') return '按小时的统计没有记录模型，请选 7 天以上。';
    return null;
  }
  const pieDisabledReason = (): string | null =>
    metric === 'chat' && split === 'character' ? '一位玩家可能和几个角色都聊过，按角色的人数不能相加成占比' : null;
  function paintSplitTabs() {
    for (const id of ['character', 'model'] as const) {
      const button = splitSwitch.buttons.get(id);
      if (!button) continue;
      const why = splitDisabledReason(id);
      button.disabled = why !== null;
      // The page re-enables every control after a request; data-locked is the lock it honours.
      button.dataset.locked = String(why !== null);
      if (why) button.setAttribute('title', why);
      else button.removeAttribute('title');
    }
    // 聊天人数 × 按角色: the pie would show shares of an over-counted whole (a player is in every character they chatted with).
    const pieButton = kindSwitch.buttons.get('pie');
    if (pieButton) {
      const why = pieDisabledReason();
      pieButton.disabled = why !== null;
      pieButton.dataset.locked = String(why !== null);
      if (why) pieButton.setAttribute('title', why);
      else pieButton.removeAttribute('title');
      if (why && kind === 'pie') {
        kind = 'line';
        kindSwitch.set('line');
      }
    }
    if (split !== 'all' && splitDisabledReason(split)) {
      split = 'all';
      splitSwitch.set('all');
      hiddenSeries.clear();
      // the 统计表 follows the switch, so it goes back to the days too
      paintTableMode();
    }
  }
  function paintMetricTabs() {
    paintSplitTabs();
    const active = metricSwitch.buttons.get('active');
    if (active) {
      active.disabled = span === '24h';
      active.dataset.locked = String(span === '24h');
      if (span === '24h') active.title = '按小时没有活跃数';
      else active.removeAttribute('title');
    }
  }

  // ---- paint ----
  const tile = (label: string, value: string, sub: string, tip: string, count?: number) => {
    const big = h('span', { class: 'ov-big', text: value });
    if (count !== undefined) rollNumber(big, count, (v) => exactCount(Math.round(v)));
    return h(
      'div',
      { class: 'ov-tile' },
      h('span', { class: 'ov-tile-label', text: label }),
      hoverValue(big, tip),
      h('span', { class: 'ov-tile-sub', text: sub }),
    );
  };
  function paintTiles() {
    const view = overview;
    if (!view) return;
    const today = view.today;
    const list: HTMLElement[] = [
      tile(
        `今日回复`,
        exactCount(today.replies),
        `语音 ${exactCount(today.voiceReplies)} · 失败 ${exactCount(today.failedReplies)}`,
        `成功 ${exactCount(today.replies)} · 失败 ${exactCount(today.failedReplies)} · 语音 ${exactCount(today.voiceReplies)}`,
        today.replies,
      ),
      tile(
        '今日花费 · 列表价',
        today.spendMicros === null ? '—' : dollars(today.spendMicros),
        '',
        today.spendMicros === null ? '还没有记录' : exactMoney(today.spendMicros),
      ),
    ];
    if (view.stats) {
      const todayDay = stats?.days[0]?.day ?? '';
      const yesterday: PlayerStatsDay | null =
        todayDay && stats?.days[1]?.day === addDays(todayDay, -1) ? stats.days[1]! : null;
      const y = view.stats.yesterday;
      const fen = view.stats.monthListCostRmbFen;
      list.push(
        tile('本月花费 · 约', rmb(fen), '', `¥${(fen / 100).toFixed(2)}（列表价按汇率折算）`),
        tile(`昨日新注册`, exactCount(y.signups), '', `${y.day} UTC · ${exactCount(y.signups)} 人`, y.signups),
        tile(
          '昨日活跃',
          exactCount(y.active),
          yesterday ? `注册 ${yesterday.activeRegistered} · 访客 ${yesterday.activeGuests}` : '',
          `${y.day} UTC`,
          y.active,
        ),
        tile(
          '昨日聊天人数',
          yesterday ? exactCount(yesterday.chatRegistered + yesterday.chatGuests) : '—',
          yesterday ? `注册 ${yesterday.chatRegistered} · 访客 ${yesterday.chatGuests}` : '',
          `${y.day} UTC`,
        ),
        tile(
          '次日留存',
          stats ? pct(stats.totals.d1) : '—',
          '注册玩家',
          stats?.totals.d1 ? `${stats.totals.d1.retained} / ${stats.totals.d1.cohort}` : '还要等一天',
        ),
        tile(
          '7 日留存',
          stats ? pct(stats.totals.d7) : '—',
          '注册玩家',
          stats?.totals.d7 ? `${stats.totals.d7.retained} / ${stats.totals.d7.cohort}` : '要满 7 天才有',
        ),
      );
    }
    tiles.replaceChildren(...list);
  }
  function paintStatus() {
    const view = overview;
    if (!view) return;
    const note = warningLine(view.warnings);
    const utc = h('span', { class: 'is-mono', text: `UTC ${view.day}` });
    if (stats?.since) hoverValue(utc, `统计自 ${stats.since} 起`);
    const pill = note
      ? h(
          'a',
          // A failing cleanup goes straight to its section (and its table) in 系统状态; the other warnings to the page.
          { class: 'ov-warn', attrs: { href: view.warnings.retentionFailing > 0 ? '#/system/cleanup' : '#/system' } },
          h('i'),
          note,
        )
      : h('span', { class: 'is-ok', text: '正常' });
    fillStatus(status, utc, pill);
  }

  const colorOf = (index: number) => CHARACTER_COLORS[index % CHARACTER_COLORS.length]!;
  /** The characters by their most-replies order, the rest together as one grey entry. */
  function grouped<T extends { name: string }>(rows: readonly T[], value: (row: T) => number) {
    const head = rows
      .slice(0, SHOWN_CHARACTERS)
      .map((row, i) => ({ name: row.name, color: colourOfName(row.name) ?? colorOf(i), value: value(row) }));
    const rest = rows.slice(SHOWN_CHARACTERS);
    if (rest.length)
      head.push({ name: `其他 ${rest.length} 位`, color: OTHER_COLOUR, value: rest.reduce((a, r) => a + value(r), 0) });
    return head;
  }

  function series(): {
    names: [string, string];
    colors: [string, string];
    a: (number | null)[];
    b: (number | null)[];
    buckets: string[];
    hourly: boolean;
  } | null {
    if (span === '24h') {
      const view = metric === 'chat' ? hourly.chat : hourly.replies;
      if (!view) return null;
      return {
        names: ['合计', '合计'],
        colors: [PRIMARY, PRIMARY],
        a: view.total,
        b: view.total.map(() => null),
        buckets: view.buckets,
        hourly: true,
      };
    }
    if (!stats) return null;
    const chrono = [...stats.days].reverse();
    if (metric === 'replies')
      return {
        names: ['成功', '失败'],
        colors: [PRIMARY, DANGER],
        a: chrono.map((d) => d.repliesPublished),
        b: chrono.map((d) => d.repliesFailed),
        buckets: chrono.map((d) => d.day),
        hourly: false,
      };
    if (metric === 'chat')
      return {
        names: ['注册玩家', '访客'],
        colors: [PRIMARY, OTHER_COLOUR],
        a: chrono.map((d) => d.chatRegistered),
        b: chrono.map((d) => d.chatGuests),
        buckets: chrono.map((d) => d.day),
        hourly: false,
      };
    return {
      names: ['注册玩家', '访客'],
      colors: [PRIMARY, OTHER_COLOUR],
      a: chrono.map((d) => d.activeRegistered),
      b: chrono.map((d) => d.activeGuests),
      buckets: chrono.map((d) => d.day),
      hourly: false,
    };
  }

  const rangeId = (): ChartRange => (span === '24h' ? '24h' : (`${span}d` as ChartRange));
  const chartMetric = (): ChartMetric => (metric === 'chat' ? 'chat_users' : 'replies');
  /** The chart read the split draws from: the hourly one for 24H, else the one for this metric and range (read when first needed). */
  const splitView = (): ChartView | null =>
    span === '24h'
      ? metric === 'chat'
        ? hourly.chat
        : hourly.replies
      : (splitViews.get(`${chartMetric()}|${rangeId()}`) ?? null);
  async function ensureSplitView() {
    if (split === 'all' || span === '24h' || !chartOn()) return;
    const key = `${chartMetric()}|${rangeId()}`;
    if (!splitViews.has(key)) splitViews.set(key, await deps.chart!.load(chartMetric(), rangeId()));
  }
  function paintSplit(replay: boolean) {
    const kindOfSplit = split as Exclude<Split, 'all'>;
    const view = splitView();
    const data: SplitData | null = view ? buildSplit(view, kindOfSplit) : null;
    const known = !!data && data.series.some((s) => s.values.some((v) => v !== null));
    trendEmpty.textContent = !view
      ? '正在读取…'
      : !data
        ? `这段时间没有${kindOfSplit === 'model' ? '按模型' : '按角色'}的数据。`
        : '还没有数据。';
    trendEmpty.hidden = known;
    chartBox.hidden = !known || kind === 'pie';
    pieBox.hidden = !known || kind !== 'pie';
    if (!data || !known) {
      legend.replaceChildren();
      return;
    }
    const unit = METRICS.find((m) => m.id === metric)!.unit;
    const heading = kindOfSplit === 'character' ? '按角色' : '按模型';
    const figureText = (values: readonly (number | null)[]) => {
      const figure = figureOf(chartMetric(), values);
      return figure === null ? '—' : countLabel(figure);
    };
    legend.replaceChildren(
      ...data.series.map((s) => {
        const figure = figureOf(chartMetric(), s.values);
        const chip = h(
          'button',
          {
            class: `ovx-chip is-toggle${hiddenSeries.has(s.id) ? ' is-off' : ''}`,
            attrs: { type: 'button', 'aria-pressed': String(!hiddenSeries.has(s.id)), 'data-series': s.id },
          },
          h('i', { class: 'ovx-dot' }),
          `${s.name} `,
          h('b', { text: figureText(s.values) }),
        );
        (chip.querySelector?.('i') as HTMLElement | null)?.style.setProperty('--c', s.color);
        chip.addEventListener('click', () => {
          if (hiddenSeries.has(s.id)) hiddenSeries.delete(s.id);
          else hiddenSeries.add(s.id);
          paintTrend(false);
        });
        return hoverValue(
          chip,
          `${s.name} ${figure === null ? '—' : exactCount(figure)} ${unit}${metric === 'replies' ? '（这段时间的合计）' : '（最新一格）'}。点一下隐藏或显示。`,
        );
      }),
    );
    const visible = data.series.filter((s) => !hiddenSeries.has(s.id));
    if (kind === 'pie') {
      const entries = visible.map((s) => ({
        name: s.name,
        color: s.color,
        value: figureOf(chartMetric(), s.values) ?? 0,
      }));
      const whole = entries.reduce((a, e) => a + e.value, 0);
      pie.update(
        entries.map((e) => {
          const share = whole > 0 ? `${Math.round((e.value / whole) * 100)}%` : '—';
          return {
            ...e,
            share,
            figure: exactCount(e.value),
            tip: `${e.name} · ${exactCount(e.value)} ${unit} · ${share}`,
          };
        }),
        heading,
      );
      return;
    }
    const step = Math.max(1, Math.ceil(data.buckets.length / 8));
    const list: XySeries[] = data.series.map((s) => ({
      id: s.id,
      name: s.name,
      color: s.color,
      values: s.values,
      on: !hiddenSeries.has(s.id),
    }));
    chart.update(
      {
        mode: kind === 'bar' ? 'bar' : 'line',
        series: list,
        buckets: data.buckets.map((b) => bucketLabel(b, false)),
        ticks: data.buckets
          .map((b, index) => ({ index, label: bucketLabel(b, true) }))
          .filter((t) => t.index % step === 0),
        axisLabel: countLabel,
        valueLabel: countLabel,
        ariaLabel: `${METRICS.find((m) => m.id === metric)!.label}${heading}${kind === 'bar' ? '柱状' : '折线'}`,
        tipLines: (i) => [
          `${bucketLabel(data.buckets[i]!, false)} UTC`,
          ...list.map((s) => `${s.name} ${s.values[i] == null ? '—' : exactCount(s.values[i]!)} ${unit}`),
          `合计 ${data.total[i] == null ? '—' : exactCount(data.total[i]!)} ${unit}${metric === 'chat' ? '（同一玩家只算一次）' : ''}`,
        ],
      },
      replay,
    );
  }
  function paintTrend(replay = false) {
    if (split !== 'all') {
      trend.hidden = !deps.stats && !deps.chart;
      paintSplit(replay);
      return;
    }
    trendEmpty.textContent = '还没有数据。';
    const data = series();
    const unit = METRICS.find((m) => m.id === metric)!.unit;
    const known = !!data && (data.a.some((v) => v !== null) || data.b.some((v) => v !== null));
    trend.hidden = !deps.stats && !deps.chart;
    trendEmpty.hidden = known;
    chartBox.hidden = !known || kind === 'pie';
    pieBox.hidden = !known || kind !== 'pie';
    if (!data || !known) {
      legend.replaceChildren();
      return;
    }
    const single = data.names[0] === data.names[1];
    const figureOf = (values: readonly (number | null)[]) => (metric === 'replies' ? sum(values) : latest(values));
    const chip = (name: string, color: string, values: readonly (number | null)[]) => {
      const figure = figureOf(values);
      const node = h(
        'span',
        { class: 'ovx-chip' },
        h('i', { class: 'ovx-dot' }),
        `${name} `,
        h('b', { text: figure === null ? '—' : countLabel(figure) }),
      );
      (node.querySelector?.('i') as HTMLElement | null)?.style.setProperty('--c', color);
      return hoverValue(
        node,
        `${name} ${figure === null ? '—' : exactCount(figure)} ${unit}${metric === 'replies' ? '（这段时间的合计）' : '（最新一格）'}`,
      );
    };
    legend.replaceChildren(
      chip(data.names[0], data.colors[0], data.a),
      ...(single ? [] : [chip(data.names[1], data.colors[1], data.b)]),
    );
    if (kind === 'pie') {
      paintPie(data, unit);
      return;
    }
    const step = Math.max(1, Math.ceil(data.buckets.length / 8));
    const list: XySeries[] = [
      { id: 'a', name: data.names[0], color: data.colors[0], values: data.a, on: true },
      ...(single ? [] : [{ id: 'b', name: data.names[1], color: data.colors[1], values: data.b, on: true }]),
    ];
    chart.update(
      {
        mode: kind === 'bar' ? 'bar' : 'line',
        series: list,
        buckets: data.buckets.map((b) => bucketLabel(b, false)),
        ticks: data.buckets
          .map((b, index) => ({ index, label: bucketLabel(b, true) }))
          .filter((t) => t.index % step === 0),
        axisLabel: countLabel,
        valueLabel: countLabel,
        ariaLabel: `${METRICS.find((m) => m.id === metric)!.label}${kind === 'bar' ? '柱状' : '折线'}`,
        tipLines: (i) => [
          `${bucketLabel(data.buckets[i]!, false)} UTC`,
          ...list.map((s) => `${s.name} ${s.values[i] == null ? '—' : exactCount(s.values[i]!)} ${unit}`),
        ],
      },
      replay,
    );
  }
  function paintPie(data: NonNullable<ReturnType<typeof series>>, unit: string) {
    let entries: Array<{ name: string; color: string; value: number }>;
    let heading = '按角色';
    if (metric === 'active') {
      heading = '注册 / 访客';
      entries = [
        { name: data.names[0], color: data.colors[0], value: sum(data.a) },
        { name: data.names[1], color: data.colors[1], value: sum(data.b) },
      ];
    } else if (span === '24h') {
      const view = metric === 'chat' ? hourly.chat : hourly.replies;
      entries = grouped(
        view?.characters ?? [],
        (c) => seriesFigure(metric === 'chat' ? 'chat_users' : 'replies', c.values) ?? 0,
      );
    } else if (metric === 'replies') {
      entries = grouped(stats?.byCharacter ?? [], (c) => c.published);
    } else {
      entries = grouped(people?.characters ?? [], (c) => seriesFigure('chat_users', c.values) ?? 0);
    }
    const whole = entries.reduce((a, e) => a + e.value, 0);
    const list: PieEntry[] = entries.map((e) => {
      const share = whole > 0 ? `${Math.round((e.value / whole) * 100)}%` : '—';
      return { ...e, share, figure: exactCount(e.value), tip: `${e.name} · ${exactCount(e.value)} ${unit} · ${share}` };
    });
    pie.update(list, heading);
  }

  function paintSplits() {
    const view = stats;
    if (!view) {
      byCharacter.setRows([]);
      byCharacterChat.setRows([]);
      byModel.setRows([]);
      return;
    }
    const totalRow = (rows: SplitRow[]): SplitRow => ({
      key: 'total',
      label: '合计',
      published: rows.reduce((n, r) => n + r.published, 0),
      failed: rows.reduce((n, r) => n + r.failed, 0),
      unknown: rows.reduce((n, r) => n + r.unknown, 0),
      voice: rows.reduce((n, r) => n + r.voice, 0),
      total: true,
      tip: null,
      whole: rows.reduce((n, r) => n + r.published + r.failed + r.unknown, 0),
    });
    const wholeOf = (list: ReadonlyArray<{ published: number; failed: number; unknown: number }>) =>
      list.reduce((n, r) => n + r.published + r.failed + r.unknown, 0);
    const chatFor = (name: string) => {
      const chart = people;
      if (!chart || chart.bucket !== 'day') return null;
      const todayDay = view.days[0]?.day ?? '';
      const index = chart.buckets.indexOf(addDays(todayDay, -1));
      return index < 0 ? null : (chart.characters.find((c) => c.name === name)?.values[index] ?? null);
    };
    const charsWhole = wholeOf(view.byCharacter);
    const chars: SplitRow[] = view.byCharacter.map((c) => {
      const chat = chatFor(c.name);
      return {
        key: c.name,
        label: c.name,
        published: c.published,
        failed: c.failed,
        unknown: c.unknown,
        voice: c.voice,
        total: false,
        whole: charsWhole,
        tip: chat === null ? null : `${c.name} · 昨日聊天 ${exactCount(chat)} 人`,
      };
    });
    byCharacter.setRows(chars.length ? [...chars, totalRow(chars)] : []);
    byCharacterChat.setRows(chars.length ? [...chars, totalRow(chars)] : []);
    const modelsWhole = wholeOf(view.byModel);
    const models: SplitRow[] = view.byModel.map((m) => ({
      key: m.model || '(none)',
      label: modelLabel(m.model),
      published: m.published,
      failed: m.failed,
      unknown: m.unknown,
      voice: m.voice,
      total: false,
      whole: modelsWhole,
      tip: null,
    }));
    byModel.setRows(models.length ? [...models, totalRow(models)] : []);
    paintTableMode();
  }
  function paintDays() {
    const view = stats;
    if (!view || !view.days.length) {
      days.setRows([]);
      return;
    }
    const rows: DayRow[] = view.days.map((d) => ({ key: d.day, label: d.day, counts: d, total: false }));
    // 24H: today and yesterday; the other ranges: every day, then the totals.
    const shownRows = span === '24h' ? rows.slice(0, 2) : rows;
    days.setRows(
      span === '24h' ? shownRows : [...shownRows, { key: 'total', label: '合计', counts: view.totals, total: true }],
    );
  }
  function paintAll(replay = false) {
    paintMetricTabs();
    paintStatus();
    paintTiles();
    paintTrend(replay);
    paintDays();
    paintSplits();
  }

  // ---- loading ----
  const statsRange = (): StatsRange => (span === '24h' ? 7 : span);
  const chartOn = () => !!deps.chart && deps.chart.available?.() !== false;
  const statsOn = () => !!deps.stats && deps.stats.available?.() !== false;
  async function loadRange() {
    const [next, replies, chat, who] = await Promise.all([
      statsOn() ? deps.stats!.load(statsRange()) : Promise.resolve(null),
      span === '24h' && chartOn() ? deps.chart!.load('replies', '24h') : Promise.resolve(null),
      span === '24h' && chartOn() ? deps.chart!.load('chat_users', '24h') : Promise.resolve(null),
      chartOn() ? deps.chart!.load('chat_users', '14d').catch(() => null) : Promise.resolve(null),
    ]);
    if (deps.disposed()) return;
    stats = next;
    hourly = { replies, chat };
    people = who;
    splitViews.clear();
    paintSplitTabs();
    await ensureSplitView();
    if (deps.disposed()) return;
    paintAll(true);
  }
  async function load() {
    const view = await deps.load();
    if (deps.disposed()) return;
    overview = view;
    trend.hidden = !statsOn() && !chartOn();
    tiles.dataset.full = String(!!view.stats);
    daysCard.hidden = !statsOn();
    exportButton.hidden = !statsOn();
    if (!statsOn()) {
      stats = null;
      paintAll();
      if (chartOn()) await loadRange();
      return;
    }
    await loadRange();
  }
  async function exportTable() {
    if (!deps.stats) return;
    const { csv } = await deps.stats.exportCsv(statsRange());
    if (!deps.disposed()) deps.stats.download(`玩家统计-最近${statsRange()}天.csv`, csv);
  }
  paintMetricTabs();
  return {
    load,
    /** The chart's current choices, for tests. */
    get chartState() {
      return { metric, span, kind, stats, overview };
    },
    clear() {
      tiles.replaceChildren();
      status.replaceChildren();
      legend.replaceChildren();
      days.setRows([]);
      byCharacter.setRows([]);
      byCharacterChat.setRows([]);
      byModel.setRows([]);
      overview = null;
      stats = null;
      hourly = { replies: null, chat: null };
      people = null;
    },
  };
}

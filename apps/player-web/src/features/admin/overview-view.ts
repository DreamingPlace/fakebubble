import type { OverviewView } from '../../../../../packages/contracts/web-system.ts';
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
import { openTable, type OpenColumn } from './ui/open-table.ts';
import { fillStatus, pageHead } from './ui/page-head.ts';
import { pieChart, type PieEntry } from './ui/pie-chart.ts';
import { segmented } from './ui/segmented.ts';
import { xyChart, type XySeries } from './ui/xy-chart.ts';

/** The one-line summary of the 系统状态 warnings; null when there is nothing to say. */
export function warningLine(warnings: OverviewView['warnings']) {
  const parts = [
    warnings.priceExpiring > 0 ? `${warnings.priceExpiring} 项价格即将到期` : null,
    warnings.retentionFailing > 0 ? `${warnings.retentionFailing} 位玩家的清理失败` : null,
    warnings.unknownNew > 0 ? `近 24 小时新增 ${warnings.unknownNew} 个 UNKNOWN 调用` : null,
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
      paintTrend();
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
  const legend = h('span', { class: 'ovx-legend' });
  const chart = xyChart();
  const chartBox = h('div', { class: 'ovx-pane ovx-line' }, chart.root);
  const pie = pieChart('按角色的占比');
  const pieBox = h('div', { class: 'ovx-pane ovx-pie-pane' }, pie.root);
  const trendEmpty = h('p', { class: 'ovx-empty', text: '还没有数据。', hidden: true });
  const trend = h(
    'section',
    { class: 'ovx-trend', attrs: { 'aria-label': '趋势' } },
    h('div', { class: 'ovx-bar' }, metricSwitch.root, h('div', { class: 'ovx-tools' }, legend, kindSwitch.root)),
    chartBox,
    pieBox,
    trendEmpty,
  );

  // ---- 按天 ----
  type DayRow = { key: string; label: string; counts: PlayerStatsDay | PlayerStatsView['totals']; total: boolean };
  const num = (n: number) => String(n);
  const dayColumns: OpenColumn<DayRow>[] = [
    { key: 'day', label: '日期 UTC', width: '130px', mono: true, cell: (r) => r.label },
    { key: 'signups', label: '新注册', align: 'end', mono: true, cell: (r) => num(r.counts.signups), tip: (r) => exactCount(r.counts.signups) },
    { key: 'guests', label: '新访客', align: 'end', mono: true, cell: (r) => num(r.counts.newGuests), tip: (r) => exactCount(r.counts.newGuests) },
    {
      key: 'active', label: '活跃', align: 'end', mono: true, headTip: '注册 / 访客',
      cell: (r) => num(r.counts.activeRegistered + r.counts.activeGuests),
      tip: (r) => partsText([['注册', r.counts.activeRegistered], ['访客', r.counts.activeGuests]]),
    },
    {
      key: 'chat', label: '聊天人数', align: 'end', mono: true, headTip: '注册 / 访客',
      cell: (r) => num(r.counts.chatRegistered + r.counts.chatGuests),
      tip: (r) => partsText([['注册', r.counts.chatRegistered], ['访客', r.counts.chatGuests]]),
    },
    {
      key: 'replies', label: '回复', align: 'end', mono: true, headTip: '成功 / 失败 / 未知',
      cell: (r) => num(r.counts.repliesPublished + r.counts.repliesFailed + r.counts.repliesUnknown),
      tip: (r) => partsText([['成功', r.counts.repliesPublished], ['失败', r.counts.repliesFailed], ['未知', r.counts.repliesUnknown]]),
    },
    { key: 'voice', label: '语音回复', align: 'end', mono: true, cell: (r) => num(r.counts.voiceReplies), tip: (r) => exactCount(r.counts.voiceReplies) },
    { key: 'deleted', label: '删除账号', align: 'end', mono: true, cell: (r) => num(r.counts.deletedAccounts), tip: (r) => exactCount(r.counts.deletedAccounts) },
    {
      key: 'clean', label: '清理', align: 'end', mono: true, headTip: '不活跃清理 / 试用到期清理',
      cell: (r) => num(r.counts.inactivePurged + r.counts.expiredPurged),
      tip: (r) => partsText([['不活跃', r.counts.inactivePurged], ['试用到期', r.counts.expiredPurged]]),
    },
    {
      key: 'd1', label: '次日留存', align: 'end', mono: true,
      cell: (r) => pct(r.counts.d1),
      tip: (r) => (r.counts.d1 ? `${r.counts.d1.retained} / ${r.counts.d1.cohort}` : '还要等一天'),
    },
    {
      key: 'd7', label: '7 日留存', align: 'end', mono: true,
      cell: (r) => pct(r.counts.d7),
      tip: (r) => (r.counts.d7 ? `${r.counts.d7.retained} / ${r.counts.d7.cohort}` : '要满 7 天才有'),
    },
  ];
  const days = openTable<DayRow>({
    label: '玩家统计（按天）',
    className: 'ov-days',
    rowKey: (r) => r.key,
    columns: dayColumns,
    emptyText: '还没有统计数据。玩家访问或聊天之后，每日数字会显示在这里。',
    rowClass: (r) => (r.total ? 'is-total' : ''),
  });
  const daysCard = h('section', { class: 'ov-card ad-tip-bounds', attrs: { 'aria-label': '按天' } }, h('h3', { text: '按天' }), days.root);

  // ---- splits ----
  const characterHost = h('div', { class: 'ov-split-rows' });
  const modelHost = h('div', { class: 'ov-split-rows' });
  const modelTitle = h('h3', { text: '按模型' });
  const split = h(
    'div',
    { class: 'ov-pair' },
    h('section', { class: 'ov-card ad-tip-bounds', attrs: { 'aria-label': '按角色' } }, h('h3', { text: '按角色' }), characterHost),
    h('section', { class: 'ov-card ad-tip-bounds', attrs: { 'aria-label': '按模型' } }, modelTitle, modelHost),
  );

  root.replaceChildren(head, tiles, trend, daysCard, split);

  function setMetric(next: Metric) {
    metric = next;
    metricSwitch.set(next);
  }
  function paintMetricTabs() {
    const active = metricSwitch.buttons.get('active');
    if (active) {
      active.disabled = span === '24h';
      if (span === '24h') active.title = '按小时没有活跃数';
      else active.removeAttribute('title');
    }
  }

  // ---- paint ----
  const tile = (label: string, value: string, sub: string, tip: string, count?: number) => {
    const big = h('span', { class: 'ov-big', text: value });
    if (count !== undefined) rollNumber(big, count, (v) => String(Math.round(v)));
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
        String(today.replies),
        `语音 ${today.voiceReplies} · 失败 ${today.failedReplies}`,
        `成功 ${today.replies} · 失败 ${today.failedReplies} · 语音 ${today.voiceReplies}`,
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
        tile(`昨日新注册`, String(y.signups), '', `${y.day} UTC · ${y.signups} 人`, y.signups),
        tile(
          '昨日活跃',
          String(y.active),
          yesterday ? `注册 ${yesterday.activeRegistered} · 访客 ${yesterday.activeGuests}` : '',
          `${y.day} UTC`,
          y.active,
        ),
        tile(
          '昨日聊天人数',
          yesterday ? String(yesterday.chatRegistered + yesterday.chatGuests) : '—',
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
      ? h('a', { class: 'ov-warn', attrs: { href: '#/system' } }, h('i'), note)
      : h('span', { class: 'is-ok', text: '正常' });
    fillStatus(status, utc, pill);
  }

  const colorOf = (index: number) => CHARACTER_COLORS[index % CHARACTER_COLORS.length]!;
  /** The characters by their most-replies order, the rest together as one grey entry. */
  function grouped<T extends { name: string }>(rows: readonly T[], value: (row: T) => number) {
    const head = rows.slice(0, SHOWN_CHARACTERS).map((row, i) => ({ name: row.name, color: colorOf(i), value: value(row) }));
    const rest = rows.slice(SHOWN_CHARACTERS);
    if (rest.length) head.push({ name: `其他 ${rest.length} 位`, color: OTHER_COLOUR, value: rest.reduce((a, r) => a + value(r), 0) });
    return head;
  }

  function series(): { names: [string, string]; colors: [string, string]; a: (number | null)[]; b: (number | null)[]; buckets: string[]; hourly: boolean } | null {
    if (span === '24h') {
      const view = metric === 'chat' ? hourly.chat : hourly.replies;
      if (!view) return null;
      return { names: ['合计', '合计'], colors: [PRIMARY, PRIMARY], a: view.total, b: view.total.map(() => null), buckets: view.buckets, hourly: true };
    }
    if (!stats) return null;
    const chrono = [...stats.days].reverse();
    if (metric === 'replies')
      return { names: ['成功', '失败'], colors: [PRIMARY, DANGER], a: chrono.map((d) => d.repliesPublished), b: chrono.map((d) => d.repliesFailed), buckets: chrono.map((d) => d.day), hourly: false };
    if (metric === 'chat')
      return { names: ['注册玩家', '访客'], colors: [PRIMARY, OTHER_COLOUR], a: chrono.map((d) => d.chatRegistered), b: chrono.map((d) => d.chatGuests), buckets: chrono.map((d) => d.day), hourly: false };
    return { names: ['注册玩家', '访客'], colors: [PRIMARY, OTHER_COLOUR], a: chrono.map((d) => d.activeRegistered), b: chrono.map((d) => d.activeGuests), buckets: chrono.map((d) => d.day), hourly: false };
  }

  function paintTrend(replay = false) {
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
      const node = h('span', { class: 'ovx-chip' }, h('i', { class: 'ovx-dot' }), `${name} `, h('b', { text: figure === null ? '—' : countLabel(figure) }));
      (node.querySelector?.('i') as HTMLElement | null)?.style.setProperty('--c', color);
      return hoverValue(node, `${name} ${figure === null ? '—' : exactCount(figure)} ${unit}${metric === 'replies' ? '（这段时间的合计）' : '（最新一格）'}`);
    };
    legend.replaceChildren(chip(data.names[0], data.colors[0], data.a), ...(single ? [] : [chip(data.names[1], data.colors[1], data.b)]));
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
        ticks: data.buckets.map((b, index) => ({ index, label: bucketLabel(b, true) })).filter((t) => t.index % step === 0),
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
      entries = grouped(view?.characters ?? [], (c) => seriesFigure(metric === 'chat' ? 'chat_users' : 'replies', c.values) ?? 0);
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
      characterHost.replaceChildren();
      modelHost.replaceChildren();
      return;
    }
    const rowFor = (name: string, color: string, value: number, top: number, round: string, tip: string) => {
      const bar = h('span', { class: 'ov-bar' }, h('i'));
      (bar.querySelector?.('i') as HTMLElement | null)?.style.setProperty('--w', `${top > 0 ? Math.round((value / top) * 100) : 0}%`);
      (bar.querySelector?.('i') as HTMLElement | null)?.style.setProperty('--c', color);
      const dot = h('i', { class: 'ov-rdot' });
      dot.style.setProperty('--c', color);
      dot.style.setProperty('--r', round);
      const row = h('div', { class: 'ov-split-row' }, h('span', { class: 'ov-split-name' }, dot, name), bar, h('span', { class: 'ov-split-value', text: exactCount(value) }));
      return hoverValue(row, tip);
    };
    const chars = view.byCharacter;
    const charTop = Math.max(0, ...chars.map((c) => c.published));
    const chatFor = (name: string) => {
      const chart = people;
      if (!chart || chart.bucket !== 'day') return null;
      const todayDay = view.days[0]?.day ?? '';
      const index = chart.buckets.indexOf(addDays(todayDay, -1));
      return index < 0 ? null : (chart.characters.find((c) => c.name === name)?.values[index] ?? null);
    };
    const shown = chars.slice(0, SHOWN_CHARACTERS).map((c, i) => ({ c, color: colorOf(i) }));
    const rest = chars.slice(SHOWN_CHARACTERS);
    const rows = shown.map(({ c, color }) => {
      const chat = chatFor(c.name);
      return rowFor(c.name, color, c.published, charTop, '50%', `${c.name} · 成功 ${exactCount(c.published)} / 失败 ${exactCount(c.failed)} / 未知 ${exactCount(c.unknown)} · 语音 ${exactCount(c.voice)}${chat === null ? '' : ` · 昨日聊天 ${exactCount(chat)} 人`}`);
    });
    if (rest.length) {
      const value = rest.reduce((a, c) => a + c.published, 0);
      rows.push(rowFor(`其他 ${rest.length} 位`, OTHER_COLOUR, value, charTop, '50%', `其他 ${rest.length} 位 · ${exactCount(value)} 条回复`));
    }
    characterHost.replaceChildren(...(rows.length ? rows : [h('p', { class: 'ot-empty', text: '这段时间还没有回复。' })]));
    const models = view.byModel;
    const modelTop = Math.max(0, ...models.map((m) => m.published));
    const palette = [PRIMARY, '#0E7490', '#B45309', '#9D174D'];
    modelHost.replaceChildren(
      ...(models.length
        ? models.map((m, i) =>
            rowFor(modelLabel(m.model), m.model === '' ? OTHER_COLOUR : palette[i % palette.length]!, m.published, modelTop, '2px', `${modelLabel(m.model)} · 成功 ${exactCount(m.published)} / 失败 ${exactCount(m.failed)} / 未知 ${exactCount(m.unknown)} · 语音 ${exactCount(m.voice)}`),
          )
        : [h('p', { class: 'ot-empty', text: '这段时间还没有回复。' })]),
    );
    modelTitle.textContent = span === '24h' ? '按模型 · 7 天' : '按模型';
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
    days.setRows(span === '24h' ? shownRows : [...shownRows, { key: 'total', label: '合计', counts: view.totals, total: true }]);
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
    paintAll(true);
  }
  async function load() {
    const view = await deps.load();
    if (deps.disposed()) return;
    overview = view;
    trend.hidden = !statsOn() && !chartOn();
    tiles.dataset.full = String(!!view.stats);
    daysCard.hidden = split.hidden = !statsOn();
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
      characterHost.replaceChildren();
      modelHost.replaceChildren();
      overview = null;
      stats = null;
      hourly = { replies: null, chat: null };
      people = null;
    },
  };
}

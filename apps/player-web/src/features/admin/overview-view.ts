import type { OverviewView } from '../../../../../packages/contracts/web-system.ts';
import type { ChartMetric, ChartRange, ChartView } from '../../../../../packages/contracts/web-stats.ts';
import { h } from '../cocreation/h.ts';
import { dollars } from './system-format.ts';
import { rmb } from './costs-view.ts';
import { conicGradient, countLabel } from './ui/chart-math.ts';
import { segmented } from './ui/segmented.ts';
import { statusBadge } from './ui/status-badge.ts';
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

/** One colour per character (in the order the server sends them: most replies first) and the dark one for the total. */
export const CHARACTER_COLORS = [
  '#E8561E',
  '#2F7BEA',
  '#7C4DEB',
  '#1E8E4E',
  '#D98A00',
  '#C2410C',
  '#0E7490',
  '#9D174D',
];
export const TOTAL_COLOR = '#141414';

const METRICS = [
  { id: 'replies', label: '回复', unit: '条' },
  { id: 'chat_users', label: '聊天人数', unit: '人' },
] as const;
const RANGES = [
  { id: '24h', label: '24H' },
  { id: '7d', label: '7天' },
  { id: '14d', label: '14天' },
] as const;
type ChartViewKind = 'line' | 'pie' | 'table';
const VIEWS = [
  { id: 'line', label: '折线', icon: 'line' },
  { id: 'pie', label: '饼图', icon: 'pie' },
  { id: 'table', label: '表格', icon: 'table' },
] as const;

/** The label of a bucket: 'HH:00' for an hour ('YYYY-MM-DDTHH'), 'MM-DD' for a day on the axis, the whole date in tables. */
export const bucketLabel = (bucket: string, short: boolean) =>
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

export type ChartDeps = {
  load: (metric: ChartMetric, range: ChartRange) => Promise<ChartView>;
  /** The chart is for the owner and stats.read; asked at every load, because the session changes. Absent = always. */
  available?: () => boolean;
};

/**
 * 总览 (everyone who can log in): today in UTC - replies, voice replies, failed replies and the spend so far at list price -, the
 * 系统状态 warnings as one pill, yesterday and the month for stats.read, ONE chart card (回复 / 聊天人数 × 24H / 7天 / 14天 ×
 * 折线 / 饼图 / 表格, per character and in total) for the administrators who may read the statistics, and a link to each section.
 */
export function overviewView(
  root: HTMLElement,
  deps: {
    load: () => Promise<OverviewView>;
    run: (work: () => Promise<void>) => Promise<void>;
    disposed: () => boolean;
    /** Present for the owner and stats.read: the 22d chart endpoint. Without it the page has no chart card. */
    chart?: ChartDeps | undefined;
  },
) {
  const cards = h('div', { class: 'overview-cards ov-today' });
  // Part 22c: yesterday and this month, only for the owner and stats.read (the server sends null to everyone else).
  const yesterday = h('div', { class: 'overview-cards ov-yesterday' });
  const warnings = h('p', { class: 'overview-warnings ov-status', attrs: { role: 'status' } });
  const day = h('span', { class: 'page-kicker' });

  // ---- the chart card ---------------------------------------------------------------------------------------------------
  let metric: ChartMetric = 'replies',
    range: ChartRange = '14d',
    kind: ChartViewKind = 'line',
    data: ChartView | null = null;
  const metricSwitch = segmented(
    '指标',
    METRICS.map(({ id, label }) => ({ id, label })),
    metric,
    (id) => {
      metric = id;
      void deps.run(loadChart);
    },
    'm',
  );
  const rangeSwitch = segmented(
    '时间范围',
    RANGES.map(({ id, label }) => ({ id, label })),
    range,
    (id) => {
      range = id;
      void deps.run(loadChart);
    },
  );
  const viewSwitch = segmented(
    '图表类型',
    VIEWS.map(({ id, label, icon }) => ({ id, label, icon })),
    kind,
    (id) => {
      kind = id;
      paintChart(true);
    },
  );
  const legend = h('div', { class: 'ov-legend' });
  const line = xyChart();
  const lineBox = h('div', { class: 'ov-pane ov-line' }, line.root);
  const pieDisc = h('div', { class: 'ov-pie-disc', attrs: { role: 'img' } });
  const pieTotal = h('span', { class: 'ov-pie-total' });
  const pieUnit = h('span', { class: 'ov-pie-unit' });
  const pieList = h('div', { class: 'ov-pie-list' });
  pieDisc.append(h('div', { class: 'ov-pie-hole' }, pieTotal, pieUnit));
  const pieBox = h('div', { class: 'ov-pane ov-pie' }, pieDisc, pieList);
  const tableBox = h('div', { class: 'ov-pane ov-table' });
  const empty = h('p', { class: 'ov-empty', text: '还没有数据。', hidden: true });
  const body = h('div', { class: 'ov-body' }, lineBox, pieBox, tableBox, empty);
  const chartCard = h(
    'section',
    { class: 'ov-chart', attrs: { 'aria-label': '趋势' }, hidden: true },
    h(
      'div',
      { class: 'ov-chart-bar' },
      metricSwitch.root,
      h('div', { class: 'ov-chart-tools' }, rangeSwitch.root, viewSwitch.root),
    ),
    legend,
    body,
  );

  root.replaceChildren(
    h('div', { class: 'page-head' }, h('div', {}, day, h('h2', { text: '总览' })), warnings),
    cards,
    yesterday,
    chartCard,
  );

  const card = (label: string, value: string, sub?: string, tone: 'plain' | 'dark' = 'plain') =>
    h(
      'div',
      { class: `overview-card${tone === 'dark' ? ' is-dark' : ''}` },
      h('span', { class: 'overview-label', text: label }),
      h('strong', { text: value }),
      sub ? h('span', { class: 'overview-sub', text: sub }) : null,
    );
  const unit = () => METRICS.find((m) => m.id === metric)!.unit;
  const colorOf = (index: number) => CHARACTER_COLORS[index % CHARACTER_COLORS.length]!;
  function entries() {
    if (!data) return [];
    return [
      ...data.characters.map((series, i) => ({ name: series.name, color: colorOf(i), values: series.values })),
      { name: '合计', color: TOTAL_COLOR, values: data.total, total: true },
    ];
  }
  function paintChart(replay = false) {
    if (!data) return;
    const view = data;
    const hourly = view.bucket === 'hour';
    const all = entries();
    const known =
      view.total.some((value) => value !== null) || view.characters.some((c) => c.values.some((v) => v !== null));
    empty.hidden = known;
    lineBox.hidden = !known || kind !== 'line';
    pieBox.hidden = !known || kind !== 'pie';
    tableBox.hidden = !known || kind !== 'table';
    legend.replaceChildren(
      ...all.map((entry) => {
        const figure = seriesFigure(metric, entry.values);
        const chip = h(
          'span',
          { class: 'ov-chip', attrs: { title: metric === 'chat_users' ? '最新一格的人数' : '这段时间的合计' } },
          h('i', { class: 'ov-dot' }),
          entry.name,
          ' ',
          h('b', { text: figure === null ? '—' : countLabel(figure) }),
        );
        (chip.querySelector('i') as HTMLElement).style.setProperty('--c', entry.color);
        return chip;
      }),
    );
    const step = view.buckets.length > 14 ? 4 : view.buckets.length > 7 ? 2 : 1;
    const series: XySeries[] = all.map((entry, i) => ({
      id: `${i}`,
      name: entry.name,
      color: entry.color,
      values: entry.values,
      on: true,
      ...('total' in entry ? { total: true } : {}),
    }));
    line.update(
      {
        mode: 'line',
        series,
        buckets: view.buckets.map((bucket) => bucketLabel(bucket, false)),
        ticks: view.buckets
          .map((bucket, index) => ({ index, label: bucketLabel(bucket, true) }))
          .filter((tick) => tick.index % step === 0),
        axisLabel: countLabel,
        valueLabel: countLabel,
        ariaLabel: `${METRICS.find((m) => m.id === metric)!.label}折线`,
      },
      replay,
    );
    // 饼图: the characters' shares of the whole; the centre is the figure of the total.
    const parts = view.characters.map((c, i) => ({
      name: c.name,
      color: colorOf(i),
      value: seriesFigure(metric, c.values) ?? 0,
    }));
    const whole = parts.reduce((a, p) => a + p.value, 0);
    const total = seriesFigure(metric, view.total);
    pieDisc.style.setProperty('--pie', conicGradient(parts));
    pieDisc.setAttribute(
      'aria-label',
      parts.map((p) => `${p.name} ${whole > 0 ? Math.round((p.value / whole) * 100) : 0}%`).join('，'),
    );
    pieTotal.textContent = total === null ? '—' : countLabel(total);
    pieUnit.textContent = unit();
    pieList.replaceChildren(
      ...parts.map((p) => {
        const row = h(
          'span',
          { class: 'ov-pie-row' },
          h('i', { class: 'ov-dot' }),
          h('span', { class: 'ov-pie-name', text: p.name }),
          h('b', { text: whole > 0 ? `${Math.round((p.value / whole) * 100)}%` : '—' }),
        );
        (row.querySelector('i') as HTMLElement).style.setProperty('--c', p.color);
        return row;
      }),
    );
    // 表格: newest first; a bucket before the counters ran reads —.
    const cell = (value: number | null) => (value === null ? '—' : countLabel(value));
    const order = view.buckets.map((_, i) => view.buckets.length - 1 - i);
    tableBox.replaceChildren(
      h(
        'table',
        { class: 'admin-table ov-data', attrs: { 'aria-label': '趋势明细' } },
        h(
          'thead',
          {},
          h(
            'tr',
            {},
            h('th', { text: hourly ? '时间 UTC' : '日期 UTC', attrs: { scope: 'col' } }),
            ...view.characters.map((c) => h('th', { text: c.name, attrs: { scope: 'col' } })),
            h('th', { text: '合计', attrs: { scope: 'col' } }),
          ),
        ),
        h(
          'tbody',
          {},
          ...order.map((i) =>
            h(
              'tr',
              {},
              h('th', { text: bucketLabel(view.buckets[i]!, false), attrs: { scope: 'row' } }),
              ...view.characters.map((c) => h('td', { text: cell(c.values[i] ?? null) })),
              h('td', { class: 'is-total', text: cell(view.total[i] ?? null) }),
            ),
          ),
        ),
      ),
    );
  }
  async function loadChart() {
    if (!deps.chart || deps.chart.available?.() === false) {
      chartCard.hidden = true;
      return;
    }
    chartCard.hidden = false;
    chartCard.setAttribute('aria-busy', 'true');
    try {
      const next = await deps.chart.load(metric, range);
      if (deps.disposed()) return;
      data = next;
      paintChart(true);
    } finally {
      chartCard.removeAttribute('aria-busy');
    }
  }

  async function load() {
    const view = await deps.load();
    if (deps.disposed()) return;
    day.textContent = `UTC ${view.day}`;
    cards.replaceChildren(
      card(
        `今日回复（UTC ${view.day}）`,
        String(view.today.replies),
        `语音 ${view.today.voiceReplies} · 失败 ${view.today.failedReplies}`,
      ),
      card('今日花费（列表价）', view.today.spendMicros === null ? '—' : dollars(view.today.spendMicros)),
    );
    yesterday.replaceChildren(
      ...(view.stats
        ? [
            card(`昨日新注册（UTC ${view.stats.yesterday.day}）`, String(view.stats.yesterday.signups)),
            card('昨日活跃', String(view.stats.yesterday.active)),
            card('昨日回复', String(view.stats.yesterday.replies)),
            card('本月花费（列表价，约）', rmb(view.stats.monthListCostRmbFen)),
          ]
        : []),
    );
    const note = warningLine(view.warnings);
    warnings.setAttribute('data-tone', note ? 'warn' : 'ok');
    warnings.replaceChildren(statusBadge(note ? '需要留意' : '正常', note ? 'warn' : 'ok'), ' ', note ?? '');
    await loadChart();
  }
  return {
    load,
    /** The chart's current choices, for tests. */
    get chartState() {
      return { metric, range, kind, data };
    },
    clear() {
      cards.replaceChildren();
      yesterday.replaceChildren();
      warnings.replaceChildren();
      data = null;
      legend.replaceChildren();
      tableBox.replaceChildren();
      chartCard.hidden = true;
    },
  };
}

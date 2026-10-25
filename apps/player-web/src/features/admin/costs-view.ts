import {
  STATS_RANGES,
  type CostDay,
  type CostRow,
  type CostsView,
  type SpendDay,
  type SpendView,
  type StatsRange,
  type StatsUserType,
} from '../../../../../packages/contracts/web-stats.ts';
import { h } from '../cocreation/h.ts';
import { dollars } from './system-format.ts';
import { dollarLabel } from './ui/chart-math.ts';
import { dataTable } from './ui/data-table.ts';
import { segmented } from './ui/segmented.ts';
import { xyChart, type XyMarker, type XySeries } from './ui/xy-chart.ts';

/** Four decimals: a reply costs a fraction of a cent. */
const usd = (micros: number | null) => (micros === null ? '—' : `$${(micros / 1_000_000).toFixed(4)}`);
export const rmb = (fen: number) => `¥${(fen / 100).toFixed(2)}`;
const PHASES = { draft: '草稿', review: '审核', speech: '语音' } as const;

/** 消耗表 splits a day's spend by who the reply was for, or by text and voice. There is no 管理员: nothing links one to a player. */
export type SpendSplit = 'user' | 'kind';
export const USER_PARTS: ReadonlyArray<{ id: StatsUserType | 'unclassified'; name: string; color: string }> = [
  { id: 'guest', name: '访客', color: '#BDB5AC' },
  { id: 'registered', name: '注册', color: '#9DB8F5' },
  { id: 'daily_refill', name: '每天补充', color: '#2F7BEA' },
  { id: 'unlimited', name: '不限量', color: '#7C4DEB' },
  { id: 'test', name: '测试组', color: '#141414' },
  { id: 'unclassified', name: '未归类', color: '#E8561E' },
];
export const KIND_PARTS = [
  { id: 'text', name: '文字', color: '#BDB5AC' },
  { id: 'voice', name: '语音', color: '#141414' },
  { id: 'unclassified', name: '未归类', color: '#E8561E' },
] as const;
const toUsd = (micros: number) => micros / 1_000_000;

/**
 * The chart's series, oldest day first, in dollars. A day before the per-type counters ran has no figures (a gap on a line, an
 * empty bar). 未归类 is the spend of replies admitted before the counters, which has no frozen type.
 */
export function spendSeries(view: SpendView, split: SpendSplit) {
  const days = [...view.days].reverse();
  const part = (day: SpendDay, id: string): number | null => {
    if (day.types === null) return null;
    if (id === 'unclassified') return toUsd(day.unclassifiedMicros ?? 0);
    if (split === 'user') {
      const row = day.types.find((t) => t.userType === id);
      return toUsd((row?.textMicros ?? 0) + (row?.voiceMicros ?? 0));
    }
    return toUsd(day.types.reduce((sum, t) => sum + (id === 'text' ? t.textMicros : t.voiceMicros), 0));
  };
  const parts = split === 'user' ? USER_PARTS : KIND_PARTS;
  return {
    buckets: days.map((day) => day.day),
    series: parts.map((p) => {
      const values = days.map((day) => part(day, p.id));
      return {
        id: p.id,
        name: p.name,
        color: p.color,
        values,
        sum: values.reduce<number>((a, b) => a + (b ?? 0), 0),
      };
    }),
  };
}

/** The markers for the real price changes the server reports, by the bucket of their day; none when there are none. */
export function priceMarkers(view: SpendView, buckets: readonly string[]): XyMarker[] {
  const byIndex = new Map<number, string[]>();
  for (const change of view.priceChanges) {
    const index = buckets.indexOf(change.day);
    if (index < 0) continue;
    byIndex.set(index, [...(byIndex.get(index) ?? []), change.model]);
  }
  return [...byIndex].map(([index, models]) => ({ index, label: `${[...new Set(models)].join('、')} 调价` }));
}

/** The money text of a dollars figure on the chart hover: cents. */
const cents = (value: number) => `$${value.toFixed(2)}`;

export type CostsDeps = {
  load: (range: StatsRange) => Promise<CostsView>;
  /** 22d spend by user type with the alert line and the price changes. Absent = no chart. */
  spend?: ((range: StatsRange) => Promise<SpendView>) | undefined;
  exportCsv: (range: StatsRange) => Promise<{ csv: string; rows: number }>;
  download: (filename: string, text: string) => void;
  run: (work: () => Promise<void>) => Promise<void>;
  disposed: () => boolean;
};

/**
 * 运营 → 消耗表. This UTC month in dollars (the ¥ figure carries the rate as a tooltip), the spend per day as bars or lines with
 * an axis that scales itself and chips to compare user types or text / voice, then per UTC day and provider / model / phase the
 * calls, tokens, bytes, the list-price cost, what the budget ledger took and the replies. 导出表格 of the detail table. The alert
 * line is drawn only when it lies inside the scale; a price marker only where a real price record changed. Counts and money only.
 */
export function costsView(root: HTMLElement, deps: CostsDeps) {
  let range: StatsRange = 30,
    split: SpendSplit = 'user',
    mode: 'bar' | 'line' = 'bar',
    spend: SpendView | null = null;
  const off = new Set<string>();

  const month = h('div', { class: 'cost-cards system-section' });
  const daily = dataTable<CostDay>({
    columns: [
      { key: 'day', label: '日期（UTC）' },
      { key: 'publishedReplies', label: '成功回复', align: 'end' },
      { key: 'listCostMicros', label: '列表价合计', align: 'end', render: (row) => usd(row.listCostMicros) },
      {
        key: 'costPerReplyMicros',
        label: '每条成功回复成本',
        align: 'end',
        render: (row) => usd(row.costPerReplyMicros),
      },
      { key: 'pointsSpent', label: '消耗积分', align: 'end' },
    ],
    rowKey: (row) => row.day,
    emptyText: '这段时间还没有消耗记录。',
    caption: '消耗表（按天）',
  });
  const detail = dataTable<CostRow>({
    columns: [
      { key: 'day', label: '日期（UTC）' },
      { key: 'provider', label: '供应商' },
      { key: 'model', label: '模型' },
      { key: 'phase', label: '阶段', render: (row) => PHASES[row.phase] },
      { key: 'calls', label: '调用次数', align: 'end' },
      { key: 'inputTokens', label: '输入令牌', align: 'end' },
      { key: 'cachedInputTokens', label: '缓存命中令牌', align: 'end' },
      { key: 'outputTokens', label: '输出令牌', align: 'end' },
      { key: 'bytes', label: '字节（语音）', align: 'end' },
      { key: 'listCostMicros', label: '列表价', align: 'end', render: (row) => usd(row.listCostMicros) },
      { key: 'ledgerChargedMicros', label: '账本扣款', align: 'end', render: (row) => usd(row.ledgerChargedMicros) },
      { key: 'replies', label: '回复', align: 'end' },
    ],
    rowKey: (row) => `${row.day}|${row.provider}|${row.model}|${row.phase}`,
    emptyText: '这段时间还没有供应商调用记录。',
    caption: '消耗表（按供应商、模型、阶段）',
  });
  /** 按模型: the range added up per provider / model / phase (the board's table); the dated rows follow it. */
  type Total = Omit<CostRow, 'day'> & { key: string };
  const totals = dataTable<Total>({
    columns: [
      {
        key: 'who',
        label: '供应商 / 模型 / 阶段',
        render: (row) => `${row.provider} / ${row.model} / ${PHASES[row.phase]}`,
      },
      { key: 'calls', label: '调用', align: 'end' },
      { key: 'inputTokens', label: '输入', align: 'end' },
      { key: 'cachedInputTokens', label: '缓存', align: 'end' },
      { key: 'outputTokens', label: '输出', align: 'end' },
      { key: 'bytes', label: '语音字节', align: 'end' },
      { key: 'listCostMicros', label: '列表价', align: 'end', render: (row) => usd(row.listCostMicros) },
      { key: 'ledgerChargedMicros', label: '账本扣', align: 'end', render: (row) => usd(row.ledgerChargedMicros) },
      { key: 'replies', label: '回复', align: 'end' },
    ],
    rowKey: (row) => row.key,
    emptyText: '这段时间还没有供应商调用记录。',
    caption: '消耗表（按模型合计）',
  });

  // ---- controls ---------------------------------------------------------------------------------------------------------
  const rangeSwitch = segmented(
    '时间范围',
    STATS_RANGES.map((days) => ({ id: String(days), label: `${days}天` })),
    String(range),
    (id) => {
      range = Number(id) as StatsRange;
      void deps.run(() => load());
    },
    'm',
  );
  const refresh = h('button', { class: 'admin-secondary', text: '刷新', attrs: { type: 'button' } });
  const exportButton = h('button', { class: 'admin-secondary', text: '导出表格', attrs: { type: 'button' } });
  refresh.addEventListener('click', () => void deps.run(() => load()));
  exportButton.addEventListener('click', () => void deps.run(() => exportTable()));
  const splitSwitch = segmented(
    '拆分方式',
    [
      { id: 'user' as SpendSplit, label: '按用户' },
      { id: 'kind' as SpendSplit, label: '文字 / 语音' },
    ],
    split,
    (id) => {
      split = id;
      off.clear();
      paintChart(true);
    },
  );
  const modeSwitch = segmented(
    '图表类型',
    [
      { id: 'bar' as const, label: '柱状', icon: 'bar' as const },
      { id: 'line' as const, label: '折线', icon: 'line' as const },
    ],
    mode,
    (id) => {
      mode = id;
      paintChart(true);
    },
  );
  const chips = h('div', { class: 'cost-chips', attrs: { role: 'group', 'aria-label': '显示哪些' } });
  const alertKey = h('span', { class: 'cost-alert-key', hidden: true }, h('i'), h('span'));
  const chart = xyChart();
  const empty = h('p', { class: 'ov-empty', text: '还没有按用户的花费记录。', hidden: true });
  const chartCard = h(
    'section',
    { class: 'cost-chart', attrs: { 'aria-label': '每天花费' }, hidden: true },
    h(
      'div',
      { class: 'cost-chart-bar' },
      h('h3', { text: '每天花费' }),
      h('div', { class: 'ov-chart-tools' }, splitSwitch.root, modeSwitch.root),
    ),
    h('div', { class: 'cost-chips-row' }, chips, alertKey),
    chart.root,
    empty,
  );
  const dated = h('details', { class: 'cost-dated' }, h('summary', { text: '按天明细' }), daily.root, detail.root);
  const since = h('span', { class: 'page-kicker' });

  root.replaceChildren(
    h(
      'div',
      { class: 'page-head' },
      h('div', {}, since, h('h2', { text: '消耗表' })),
      h('div', { class: 'ov-chart-tools' }, rangeSwitch.root, exportButton, refresh),
    ),
    month,
    chartCard,
    h('section', { class: 'cost-models' }, h('h3', { text: '按模型' }), totals.root),
    dated,
  );

  // ---- the chart --------------------------------------------------------------------------------------------------------
  function paintChart(replay = false) {
    if (!spend) {
      chartCard.hidden = true;
      return;
    }
    chartCard.hidden = false;
    const built = spendSeries(spend, split);
    const known = built.series.some((s) => s.values.some((v) => v !== null));
    empty.hidden = known;
    chart.root.hidden = !known;
    const series: XySeries[] = built.series.map((s) => ({
      id: s.id,
      name: s.name,
      color: s.color,
      values: s.values,
      on: !off.has(s.id),
    }));
    const step = Math.max(1, Math.ceil(built.buckets.length / 7));
    const scale = chart.update(
      {
        mode,
        series,
        buckets: built.buckets,
        ticks: built.buckets
          .map((bucket, index) => ({ index, label: bucket.slice(5) }))
          .filter((tick) => tick.index % step === 0 || tick.index === built.buckets.length - 1),
        axisLabel: dollarLabel,
        valueLabel: cents,
        alert: spend.alertMicros === null ? null : toUsd(spend.alertMicros),
        markers: priceMarkers(spend, built.buckets),
        ariaLabel: '每天花费',
      },
      replay,
    );
    // The alert line's key sits with the chips and exists only while the line is inside the scale.
    alertKey.hidden = !scale.alertShown;
    if (scale.alertShown)
      (alertKey.querySelector('span') as HTMLElement).textContent = dollarLabel(toUsd(spend.alertMicros!));
    chips.replaceChildren(
      ...built.series.map((s) => {
        const on = !off.has(s.id);
        const chip = h(
          'button',
          { class: 'cost-chip', attrs: { type: 'button', 'aria-pressed': String(on), 'data-chip': s.id } },
          h('span', { class: 'cost-chip-dot' }),
          s.name,
          ' ',
          h('b', { text: cents(s.sum) }),
        );
        chip.style.setProperty('--c', s.color);
        chip.addEventListener('click', () => {
          if (off.has(s.id)) off.delete(s.id);
          else off.add(s.id);
          paintChart();
        });
        return chip;
      }),
    );
  }

  // ---- loading ----------------------------------------------------------------------------------------------------------
  const rate = (view: CostsView) => `按 $1 ≈ ¥${view.usdCny}`;
  const card = (label: string, value: string, sub?: string, hint?: string, tone: 'plain' | 'dark' = 'plain') =>
    h(
      'div',
      { class: `overview-card${tone === 'dark' ? ' is-dark' : ''}` },
      h('span', { class: 'overview-label', text: label }),
      h('strong', { text: value }),
      sub ? h('span', { class: 'overview-sub', text: sub, attrs: hint ? { title: hint } : {} }) : null,
    );
  function aggregate(rows: readonly CostRow[]): Total[] {
    const map = new Map<string, Total>();
    for (const { day: _day, ...row } of rows) {
      const key = `${row.provider}|${row.model}|${row.phase}`;
      const held = map.get(key);
      if (!held) map.set(key, { ...row, key });
      else {
        held.calls += row.calls;
        held.inputTokens += row.inputTokens;
        held.cachedInputTokens += row.cachedInputTokens;
        held.outputTokens += row.outputTokens;
        held.bytes += row.bytes;
        held.listCostMicros += row.listCostMicros;
        held.replies += row.replies;
        if (row.ledgerChargedMicros !== null)
          held.ledgerChargedMicros = (held.ledgerChargedMicros ?? 0) + row.ledgerChargedMicros;
      }
    }
    return [...map.values()].sort((a, b) => b.listCostMicros - a.listCostMicros);
  }
  async function load() {
    const [view, spent] = await Promise.all([
      deps.load(range),
      deps.spend ? deps.spend(range).catch(() => null) : Promise.resolve(null),
    ]);
    if (deps.disposed()) return;
    since.textContent = `UTC ${view.month.month}`;
    const m = view.month;
    month.replaceChildren(
      card('本月花费', dollars(m.listCostMicros), `≈ ${rmb(m.listCostRmbFen)}`, rate(view), 'dark'),
      card('每条回复', usd(m.costPerReplyMicros), `${m.publishedReplies} 条`),
      card('账本扣的', m.ledgerChargedMicros === null ? '—' : dollars(m.ledgerChargedMicros)),
      card('用掉的点数', String(m.pointsSpent)),
    );
    daily.setRows(view.daily);
    detail.setRows(view.rows);
    totals.setRows(aggregate(view.rows));
    spend = spent;
    paintChart(true);
  }
  async function exportTable() {
    const { csv } = await deps.exportCsv(range);
    if (!deps.disposed()) deps.download(`消耗表-最近${range}天.csv`, csv);
  }
  return {
    load,
    /** The chart's current choices, for tests. */
    get chartState() {
      return { split, mode, off: new Set(off), range };
    },
    clear() {
      month.replaceChildren();
      daily.setRows([]);
      detail.setRows([]);
      totals.setRows([]);
      spend = null;
      chartCard.hidden = true;
      chips.replaceChildren();
    },
  };
}

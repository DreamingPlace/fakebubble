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
import { exactCount, exactMoney, hoverValue } from './ui/hover-value.ts';
import { openTable, type OpenColumn } from './ui/open-table.ts';
import { segmented } from './ui/segmented.ts';
import { xyChart, type XyMarker, type XySeries } from './ui/xy-chart.ts';
import { fillStatus, pageHead, statusLine } from './ui/page-head.ts';

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
  { id: 'test', name: '测试组', color: '#2B2833' },
  { id: 'unclassified', name: '未归类', color: '#E8561E' },
];
export const KIND_PARTS = [
  { id: 'text', name: '文字', color: '#BDB5AC' },
  { id: 'voice', name: '语音', color: '#2B2833' },
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
        /** null when no day of the range has a figure for it (shown —, never $0.00). */
        sum: values.every((v) => v === null) ? null : values.reduce<number>((a, b) => a + (b ?? 0), 0),
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

/** 13,812,440 → 13.8M; 88,000 → 88K. The exact figure is the hover. */
const compact = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 1 : 2).replace(/\.?0+$/, '')}M`
    : n >= 1000
      ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, '')}K`
      : String(n);
const dash = (n: number, show: boolean) => (show ? compact(n) : '—');
const micros = (dollarsValue: number) => Math.round(dollarsValue * 1_000_000);

/**
 * 消耗表 (Usage3). Four tiles (this UTC month in dollars, the ¥ figure and the rate on hover), the spend per day as stacked bars or
 * lines (hover = the day's breakdown at full precision) with chips that switch groups on and off, 按模型 (the range added up per
 * provider / model / phase) and 按天明细, whose rows open BELOW with that day's calls. 导出表格 in the title row. The alert line
 * is drawn only when it lies inside the scale; a price marker only where a real price record changed. Counts and money only.
 */
export function costsView(root: HTMLElement, deps: CostsDeps) {
  let range: StatsRange = 30,
    split: SpendSplit = 'user',
    mode: 'bar' | 'line' = 'bar',
    spend: SpendView | null = null,
    costs: CostsView | null = null;
  const off = new Set<string>();

  const tiles = h('section', { class: 'ov-tiles cs-tiles', attrs: { 'aria-label': '本月' } });
  const tile = (label: string, value: string, sub: string, tip: string) =>
    h(
      'div',
      { class: 'ov-tile' },
      h('span', { class: 'ov-tile-label', text: label }),
      hoverValue(h('span', { class: 'ov-big', text: value }), tip),
      h('span', { class: 'ov-tile-sub', text: sub }),
    );

  // ---- 按模型 ----
  type Total = Omit<CostRow, 'day'> & { key: string };
  const modelColumns: OpenColumn<Total>[] = [
    {
      key: 'who',
      label: '供应商 / 模型 / 阶段',
      width: 'minmax(0, 2.4fr)',
      mono: true,
      cell: (r) => `${r.provider} / ${r.model} / ${PHASES[r.phase]}`,
    },
    {
      key: 'calls',
      label: '调用次数',
      align: 'end',
      mono: true,
      cell: (r) => exactCount(r.calls),
      tip: (r) => `${exactCount(r.calls)} 次 · 回复 ${exactCount(r.replies)}`,
    },
    {
      key: 'in',
      label: '输入令牌',
      align: 'end',
      mono: true,
      cell: (r) => dash(r.inputTokens, r.phase !== 'speech'),
      tip: (r) => (r.phase === 'speech' ? null : `${exactCount(r.inputTokens)} 令牌`),
    },
    {
      key: 'out',
      label: '输出令牌',
      align: 'end',
      mono: true,
      cell: (r) => dash(r.outputTokens, r.phase !== 'speech'),
      tip: (r) => (r.phase === 'speech' ? null : `${exactCount(r.outputTokens)} 令牌`),
    },
    {
      key: 'cache',
      label: '缓存命中',
      align: 'end',
      mono: true,
      cell: (r) =>
        r.phase === 'speech' || r.inputTokens === 0
          ? '—'
          : `${Math.round((r.cachedInputTokens / r.inputTokens) * 100)}%`,
      tip: (r) => (r.phase === 'speech' ? null : `${exactCount(r.cachedInputTokens)} 令牌命中缓存`),
    },
    {
      key: 'bytes',
      label: '语音字节',
      align: 'end',
      mono: true,
      cell: (r) => dash(r.bytes, r.phase === 'speech'),
      tip: (r) => (r.phase === 'speech' ? `${exactCount(r.bytes)} 字节` : null),
    },
    {
      key: 'cost',
      label: '列表价合计',
      align: 'end',
      mono: true,
      cell: (r) => dollars(r.listCostMicros),
      tip: (r) =>
        `${exactMoney(r.listCostMicros)}${r.ledgerChargedMicros === null ? '' : ` · 账本扣 ${exactMoney(r.ledgerChargedMicros)}`}`,
    },
  ];
  const totals = openTable<Total>({
    label: '消耗表（按模型合计）',
    className: 'cs-table',
    rowKey: (r) => r.key,
    columns: modelColumns,
    emptyText: '这段时间还没有供应商调用记录。',
  });

  // ---- 按天明细: a day opens its calls below ----
  type DayRow = CostDay & { ledger: number | null; calls: CostRow[] };
  const dayColumns: OpenColumn<DayRow>[] = [
    { key: 'day', label: '日期 UTC', width: '140px', mono: true, cell: (r) => r.day, tip: (r) => `${r.day} UTC` },
    {
      key: 'ok',
      label: '成功回复',
      align: 'end',
      mono: true,
      cell: (r) => exactCount(r.publishedReplies),
      tip: (r) => `${exactCount(r.publishedReplies)} 条`,
    },
    {
      key: 'list',
      label: '列表价',
      align: 'end',
      mono: true,
      cell: (r) => dollars(r.listCostMicros),
      tip: (r) => exactMoney(r.listCostMicros),
    },
    {
      key: 'ledger',
      label: '账本扣',
      align: 'end',
      mono: true,
      cell: (r) => (r.ledger === null ? '—' : dollars(r.ledger)),
      tip: (r) => (r.ledger === null ? '这一天还没有账本记录' : exactMoney(r.ledger)),
    },
    {
      key: 'pts',
      label: '消耗积分',
      align: 'end',
      mono: true,
      cell: (r) => exactCount(r.pointsSpent),
      tip: (r) => `${exactCount(r.pointsSpent)} 点`,
    },
    {
      key: 'per',
      label: '每条成功回复成本',
      align: 'end',
      mono: true,
      headTip: '列表价 ÷ 成功回复',
      cell: (r) => usd(r.costPerReplyMicros),
      tip: (r) => (r.costPerReplyMicros === null ? null : exactMoney(r.costPerReplyMicros)),
    },
  ];
  const callsOf = (row: DayRow): HTMLElement => {
    const grid = 'minmax(300px, 2.6fr) repeat(5, minmax(0, 1fr))';
    const line = (cells: Array<string | HTMLElement>, headRow = false) => {
      const node = h('div', { class: `cs-call${headRow ? ' is-head' : ''}` });
      node.style?.setProperty('--grid', grid);
      // The first column is "provider / model / phase": it may wrap, but only after a slash (never in the middle of a word).
      const named = (text: string) => {
        const span = h('span', { class: 'is-name' });
        text.split(' / ').forEach((part, k) => {
          if (k > 0) span.append(' / ', document.createElement('wbr'));
          span.append(part);
        });
        return span;
      };
      cells.forEach((c, i) => node.append(typeof c === 'string' ? (i === 0 ? named(c) : h('span', { text: c })) : c));
      return node;
    };
    const money = (m: number) => hoverValue(h('span', { text: dollars(m) }), exactMoney(m));
    return h(
      'div',
      { class: 'ot-detail cs-calls' },
      line(['供应商 / 模型 / 阶段', '调用', '输入', '输出', '语音字节', '列表价'], true),
      ...(row.calls.length
        ? row.calls.map((c) =>
            line([
              `${c.provider} / ${c.model} / ${PHASES[c.phase]}`,
              exactCount(c.calls),
              dash(c.inputTokens, c.phase !== 'speech'),
              dash(c.outputTokens, c.phase !== 'speech'),
              dash(c.bytes, c.phase === 'speech'),
              money(c.listCostMicros),
            ]),
          )
        : [h('p', { class: 'ot-empty', text: '这一天没有供应商调用记录。' })]),
    );
  };
  const daily = openTable<DayRow>({
    label: '消耗表（按天明细）',
    className: 'cs-table',
    rowKey: (r) => r.day,
    columns: dayColumns,
    detail: (row) => callsOf(row),
    emptyText: '这段时间还没有消耗记录。',
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
  const exportButton = h('button', { text: '导出表格', attrs: { type: 'button' } });
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
      { id: 'bar' as const, label: '柱状' },
      { id: 'line' as const, label: '折线' },
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
  const empty = h('p', { class: 'ovx-empty', text: '还没有按用户的花费记录。', hidden: true });
  const chartCard = h(
    'section',
    { class: 'ov-card cost-chart', attrs: { 'aria-label': '每天花费' }, hidden: true },
    h(
      'div',
      { class: 'ovx-bar' },
      h('h3', { text: '每天花费' }),
      h('div', { class: 'ovx-tools' }, splitSwitch.root, modeSwitch.root),
    ),
    h('div', { class: 'cost-chips-row' }, chips, alertKey),
    chart.root,
    empty,
  );
  const since = statusLine('UTC');
  root.replaceChildren(
    pageHead('消耗表', since, rangeSwitch.root, exportButton),
    tiles,
    chartCard,
    h(
      'section',
      { class: 'ov-card ad-tip-bounds', attrs: { 'aria-label': '按模型' } },
      h('h3', { text: '按模型' }),
      totals.root,
    ),
    h(
      'section',
      { class: 'ov-card ad-tip-bounds', attrs: { 'aria-label': '按天明细' } },
      h('h3', { text: '按天明细' }),
      daily.root,
    ),
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
        // The hover is the day's breakdown at full precision: $0.071 204.
        tipLines: (i) => {
          const visible = series.filter((s) => s.on);
          const total = visible.reduce((a, s) => a + (s.values[i] ?? 0), 0);
          const known = visible.some((s) => s.values[i] != null);
          return [
            `${built.buckets[i]} UTC${known ? ` · 合计 ${exactMoney(micros(total))}` : ''}`,
            ...(known
              ? series.map(
                  (s) =>
                    `${s.name}  ${s.values[i] == null ? '—' : exactMoney(micros(s.values[i]!))}${s.on ? '' : '（已隐藏）'}`,
                )
              : ['这一天没有按用户的记录']),
          ];
        },
      },
      replay,
    );
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
          h('b', { text: s.sum === null ? '—' : cents(s.sum) }),
        );
        chip.style.setProperty('--c', s.color);
        hoverValue(chip, s.sum === null ? '这段时间没有按用户的记录' : exactMoney(micros(s.sum)));
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
    costs = view;
    const m = view.month;
    fillStatus(since, h('span', { class: 'is-mono', text: `UTC ${m.month}` }));
    tiles.replaceChildren(
      tile(
        '本月花费',
        dollars(m.listCostMicros),
        `≈ ${rmb(m.listCostRmbFen)}`,
        `列表价 ${exactMoney(m.listCostMicros)} · 汇率 ${view.usdCny}`,
      ),
      tile(
        '每条成功回复',
        usd(m.costPerReplyMicros),
        `${exactCount(m.publishedReplies)} 条`,
        m.costPerReplyMicros === null
          ? '还没有成功回复'
          : `${exactMoney(m.costPerReplyMicros)} · ${exactCount(m.publishedReplies)} 条`,
      ),
      tile(
        '账本扣的',
        m.ledgerChargedMicros === null ? '—' : dollars(m.ledgerChargedMicros),
        '',
        m.ledgerChargedMicros === null ? '这个月还没有账本记录' : exactMoney(m.ledgerChargedMicros),
      ),
      tile('用掉的点数', exactCount(m.pointsSpent), '', `${exactCount(m.pointsSpent)} 点`),
    );
    const byDay = new Map<string, CostRow[]>();
    for (const row of view.rows) byDay.set(row.day, [...(byDay.get(row.day) ?? []), row]);
    daily.setRows(
      view.daily.map((d) => {
        const rows = byDay.get(d.day) ?? [];
        const known = rows.filter((r) => r.ledgerChargedMicros !== null);
        return {
          ...d,
          ledger: known.length ? known.reduce((a, r) => a + (r.ledgerChargedMicros ?? 0), 0) : null,
          calls: rows,
        };
      }),
    );
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
      return { split, mode, off: new Set(off), range, costs };
    },
    clear() {
      tiles.replaceChildren();
      daily.setRows([]);
      totals.setRows([]);
      spend = null;
      costs = null;
      chartCard.hidden = true;
      chips.replaceChildren();
    },
  };
}

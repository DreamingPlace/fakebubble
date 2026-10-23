import {
  STATS_RANGES,
  type CostDay,
  type CostRow,
  type CostsView,
  type StatsRange,
} from '../../../../../packages/contracts/web-stats.ts';
import { h } from '../cocreation/h.ts';
import { dataTable } from './ui/data-table.ts';
import { keyValuePanel } from './ui/key-value-panel.ts';
import { toolbar } from './ui/toolbar.ts';

/** Four decimals: a reply costs a fraction of a cent. */
const usd = (micros: number | null) => (micros === null ? '—' : `$${(micros / 1_000_000).toFixed(4)}`);
export const rmb = (fen: number) => `¥${(fen / 100).toFixed(2)}`;
const PHASES = { draft: '草稿', review: '审核', speech: '语音' } as const;

/**
 * 运营 → 消耗表. Per UTC day and provider / model / phase: calls, tokens, bytes, the list-price cost and what the budget ledger
 * took ("—" before Part 22c), the replies; per day the cost per published reply and the points spent; this UTC month in USD and
 * RMB (one fixed rate, shown on the page) and, when the month holds the day Fish Drama 3's price changes, a note. 导出表格 of the
 * detail table. Counts and money only.
 */
export function costsView(
  root: HTMLElement,
  deps: {
    load: (range: StatsRange) => Promise<CostsView>;
    exportCsv: (range: StatsRange) => Promise<{ csv: string; rows: number }>;
    download: (filename: string, text: string) => void;
    run: (work: () => Promise<void>) => Promise<void>;
    disposed: () => boolean;
  },
) {
  let range: StatsRange = 30;
  const month = h('div', { class: 'system-section' });
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
  const rate = h('p', { class: 'admin-hint' });
  const bar = toolbar({
    title: '消耗表',
    filters: [
      {
        kind: 'select',
        id: 'range',
        label: '范围',
        options: STATS_RANGES.map((days) => [String(days), `最近 ${days} 天`] as const),
      },
    ],
    actions: [
      { label: '刷新', secondary: true, run: () => void deps.run(() => load()) },
      { label: '导出表格', secondary: true, run: () => void deps.run(() => exportTable()) },
    ],
    onChange: (values) => {
      range = Number(values.range) as StatsRange;
      void deps.run(() => load());
    },
  });
  // The range select opens on 30 days, the range this view starts with.
  (bar.root.querySelector('select') as HTMLSelectElement).value = String(range);
  root.replaceChildren(
    bar.root,
    rate,
    h('p', {
      class: 'admin-hint',
      text: '列表价 = 按供应商公开价格算的花费；账本扣款 = 预算账本实际扣的上限金额（本版本之前的日子没有记录，显示“—”）。只含数量与金额，不含玩家信息。',
    }),
    month,
    daily.root,
    detail.root,
  );
  async function load() {
    const view = await deps.load(range);
    if (deps.disposed()) return;
    rate.textContent = `按 1 美元 ≈ ${view.usdCny} 元估算`;
    const m = view.month;
    month.replaceChildren(
      h('h3', { text: `本月（UTC ${m.month}）` }),
      keyValuePanel([
        ['列表价合计', `${usd(m.listCostMicros)}（约 ${rmb(m.listCostRmbFen)}）`],
        ['账本扣款合计', usd(m.ledgerChargedMicros)],
        ['成功回复', String(m.publishedReplies)],
        ['每条成功回复成本', usd(m.costPerReplyMicros)],
        ['消耗积分', String(m.pointsSpent)],
        ...(m.spansDramaPriceChange
          ? ([
              [
                '备注',
                'Fish Drama 3 的列表价在 2026-11-12 之后改变：当天及以前每百万字节 10 美元，之后 50 美元；每次调用按它发生那一天的价格计算，所以本月前后的单价不同。',
              ],
            ] as const)
          : []),
      ]),
    );
    daily.setRows(view.daily);
    detail.setRows(view.rows);
  }
  async function exportTable() {
    const { csv } = await deps.exportCsv(range);
    if (!deps.disposed()) deps.download(`消耗表-最近${range}天.csv`, csv);
  }
  return {
    load,
    clear() {
      rate.textContent = '';
      month.replaceChildren();
      daily.setRows([]);
      detail.setRows([]);
    },
  };
}

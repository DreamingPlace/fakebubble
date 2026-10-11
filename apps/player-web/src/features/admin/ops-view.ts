import type { StageLatencyDay } from '../../services/account-admin-api.ts';
import { h } from '../cocreation/h.ts';
import { dataTable } from './ui/data-table.ts';
import { toolbar } from './ui/toolbar.ts';

const ms = (p: { samples: number; p50Ms: number | null; p95Ms: number | null }) =>
  p.samples === 0 ? '—' : `${p.p50Ms}/${p.p95Ms} ms（${p.samples}）`;
const percent = (value: number | null) => (value === null ? '—' : `${Math.round(value * 100)}%`);

/** 运营数据 (owner only): the stage-latency, review-rewrite, cache and embedding counters the server already reports per UTC day. */
export function opsView(
  root: HTMLElement,
  deps: {
    load: (days: number) => Promise<StageLatencyDay[]>;
    run: (work: () => Promise<void>) => Promise<void>;
    disposed: () => boolean;
  },
) {
  let days = 14;
  const table = dataTable<StageLatencyDay>({
    columns: [
      { key: 'day', label: '日期（UTC）', sortable: true },
      {
        key: 'operations',
        label: '回复数',
        sortable: true,
        align: 'end',
        sortValue: (d) => d.operations,
        render: (d) => String(d.operations),
      },
      { key: 'textQueueWait', label: '文字排队 p50/p95', render: (d) => ms(d.textQueueWait) },
      { key: 'textStage', label: '文字阶段 p50/p95', render: (d) => ms(d.textStage) },
      { key: 'audioQueueWait', label: '语音排队 p50/p95', render: (d) => ms(d.audioQueueWait) },
      { key: 'audioStage', label: '语音阶段 p50/p95', render: (d) => ms(d.audioStage) },
      {
        key: 'review',
        label: '审核改写率',
        sortable: true,
        align: 'end',
        sortValue: (d) => d.review.rate,
        render: (d) =>
          d.review.samples ? `${percent(d.review.rate)}（${d.review.changed}/${d.review.samples}）` : '—',
      },
      {
        key: 'memoryDropped',
        label: '话题/事实丢弃',
        align: 'end',
        render: (d) => `${d.memoryDropped?.topics ?? 0}/${d.memoryDropped?.facts ?? 0}`,
      },
      { key: 'rateLimitRetries', label: '限流重试', align: 'end', render: (d) => String(d.rateLimitRetries) },
      { key: 'fallbacks', label: '回退', align: 'end', render: (d) => String(d.fallbacks) },
      {
        key: 'cache',
        label: '缓存命中 草稿/审核',
        render: (d) => `${percent(d.cache.draft.hitRatio)} / ${percent(d.cache.review.hitRatio)}`,
      },
      {
        key: 'embedding',
        label: '向量化 调用/失败/未知',
        render: (d) => `${d.embedding.calls}/${d.embedding.failures}/${d.embedding.unknowns}`,
      },
    ],
    rowKey: (d) => d.day,
    emptyText: '还没有运营数据。玩家产生回复后，每日统计会显示在这里。',
    caption: '运营数据',
  });
  const bar = toolbar({
    title: '运营数据',
    filters: [
      {
        kind: 'select',
        id: 'days',
        label: '范围',
        options: [
          ['14', '最近 14 天'],
          ['7', '最近 7 天'],
          ['31', '最近 31 天'],
        ],
      },
    ],
    actions: [{ label: '刷新', secondary: true, run: () => void deps.run(() => load()) }],
    onChange: (values) => {
      days = Number(values.days) || 14;
      void deps.run(() => load());
    },
  });
  root.replaceChildren(
    bar.root,
    h('p', {
      class: 'admin-hint',
      text: '只含数量与耗时，不含玩家内容或身份。p50/p95 按最近排名计算，括号内是样本数。“话题/事实丢弃”是回复正常送出、但话题或事实格式不合法而未存入记忆的次数。',
    }),
    table.root,
  );
  async function load() {
    const rows = await deps.load(days);
    if (!deps.disposed()) table.setRows(rows);
  }
  return { load, clear: () => table.setRows([]) };
}

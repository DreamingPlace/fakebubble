import type { StageLatencyDay } from '../../services/account-admin-api.ts';
import { h } from '../cocreation/h.ts';
import { openTable, type OpenColumn } from './ui/open-table.ts';
import { segmented } from './ui/segmented.ts';

const ms = (p: { samples: number; p50Ms: number | null; p95Ms: number | null }) =>
  p.samples === 0 ? '—' : `${p.p50Ms}/${p.p95Ms} ms（${p.samples}）`;
const seconds = (value: number | null) => (value === null ? '—' : `${(value / 1000).toFixed(1)} s`);
const percent = (value: number | null) => (value === null ? '—' : `${Math.round(value * 100)}%`);

/**
 * The stage-latency, review-rewrite, cache and embedding counters the server reports per UTC day. Since Part 22b it is the
 * 技术指标 section of 系统状态 (no longer a page of its own); `title` names it there and `show` takes rows already fetched.
 */
export function opsView(
  root: HTMLElement,
  deps: {
    load: (days: number) => Promise<StageLatencyDay[]>;
    title?: string;
    run: (work: () => Promise<void>) => Promise<void>;
    disposed: () => boolean;
  },
) {
  let days = 14;
  const stage = (label: string, pick: (d: StageLatencyDay) => { samples: number; p50Ms: number | null; p95Ms: number | null }): OpenColumn<StageLatencyDay> => ({
    key: label,
    label,
    align: 'end',
    mono: true,
    cell: (d) => ms(pick(d)),
    tip: (d) => {
      const p = pick(d);
      return p.samples === 0 ? '这一天没有样本' : `中位 ${seconds(p.p50Ms)} · 最慢 ${seconds(p.p95Ms)} · ${p.samples} 个样本`;
    },
  });
  const table = openTable<StageLatencyDay>({
    label: '运营数据',
    className: 'cs-table ops-grid',
    rowKey: (d) => d.day,
    emptyText: '还没有运营数据。玩家产生回复后，每日统计会显示在这里。',
    columns: [
      { key: 'day', label: '日期（UTC）', width: '110px', mono: true, cell: (d) => d.day },
      { key: 'operations', label: '回复数', align: 'end', mono: true, cell: (d) => String(d.operations), tip: (d) => `${d.operations.toLocaleString('en-US')} 条` },
      stage('文字排队 p50/p95', (d) => d.textQueueWait),
      stage('文字阶段 p50/p95', (d) => d.textStage),
      stage('语音排队 p50/p95', (d) => d.audioQueueWait),
      stage('语音阶段 p50/p95', (d) => d.audioStage),
      {
        key: 'review', label: '审核改写率', align: 'end', mono: true,
        cell: (d) => (d.review.samples ? `${percent(d.review.rate)}（${d.review.changed}/${d.review.samples}）` : '—'),
        tip: (d) => (d.review.samples ? `${d.review.changed} 条被改写，共 ${d.review.samples} 条审核` : null),
      },
      { key: 'memoryDropped', label: '话题/事实丢弃', align: 'end', mono: true, cell: (d) => `${d.memoryDropped?.topics ?? 0}/${d.memoryDropped?.facts ?? 0}`, tip: (d) => `话题 ${d.memoryDropped?.topics ?? 0} · 事实 ${d.memoryDropped?.facts ?? 0}` },
      { key: 'rateLimitRetries', label: '限流重试', align: 'end', mono: true, cell: (d) => String(d.rateLimitRetries) },
      { key: 'fallbacks', label: '回退', align: 'end', mono: true, cell: (d) => String(d.fallbacks) },
      {
        key: 'cache', label: '缓存命中 草稿/审核', align: 'end', mono: true,
        cell: (d) => `${percent(d.cache.draft.hitRatio)} / ${percent(d.cache.review.hitRatio)}`,
        tip: (d) => `草稿命中 ${d.cache.draft.hitTokens.toLocaleString('en-US')} 令牌 · 审核命中 ${d.cache.review.hitTokens.toLocaleString('en-US')} 令牌`,
      },
      {
        key: 'embedding', label: '向量化 调用/失败/未知', align: 'end', mono: true,
        cell: (d) => `${d.embedding.calls}/${d.embedding.failures}/${d.embedding.unknowns}`,
        tip: (d) => `调用 ${d.embedding.calls} · 失败 ${d.embedding.failures} · 未知 ${d.embedding.unknowns}`,
      },
    ],
  });
  // The range is three buttons; picking one asks again (the server call is the same one 系统状态 makes).
  const range = segmented(
    '范围',
    [
      { id: '7', label: '7天' },
      { id: '14', label: '14天' },
      { id: '31', label: '31天' },
    ],
    String(days),
    (id) => {
      days = Number(id) || 14;
      void deps.run(() => load());
    },
  );
  root.replaceChildren(h('div', { class: 'ops-bar' }, range.root), table.root);
  async function load() {
    const rows = await deps.load(days);
    if (!deps.disposed()) table.setRows(rows);
  }
  return { load, show: (rows: StageLatencyDay[]) => table.setRows(rows), clear: () => table.setRows([]) };
}

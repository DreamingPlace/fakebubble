import {
  STATS_RANGES,
  type CohortRetention,
  type PlayerStatsView,
  type StatsRange,
} from '../../../../../packages/contracts/web-stats.ts';
import { h } from '../cocreation/h.ts';
import { dataTable } from './ui/data-table.ts';
import { toolbar } from './ui/toolbar.ts';

const pair = (a: number, b: number) => `${a} / ${b}`;
const retention = (c: CohortRetention | null) =>
  c === null
    ? '—'
    : `${c.retained} / ${c.cohort}${c.cohort > 0 ? `（${Math.round((c.retained / c.cohort) * 100)}%）` : ''}`;
/** '' = a reply admitted while model choice was off. */
const modelLabel = (model: string) => (model === '' ? '未选择模型' : model);

type Tab = 'days' | 'characters' | 'models';
const TABS: ReadonlyArray<readonly [Tab, string]> = [
  ['days', '按天'],
  ['characters', '按角色'],
  ['models', '按模型'],
];

/**
 * 玩家 → 玩家统计. Plain tables of counts per UTC day (newest first, with a totals row), per character (display NAME) and per
 * chosen model, for the last 7 / 30 / 90 days, and 导出表格 of the daily table. Nothing here names a player: the server only ever
 * sends counts. The page keeps the existing table and toolbar components; its look is left to the console redesign.
 */
export function statsView(
  root: HTMLElement,
  deps: {
    load: (range: StatsRange) => Promise<PlayerStatsView>;
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
  const characters = dataTable<PlayerStatsView['byCharacter'][number]>({
    columns: [
      { key: 'name', label: '角色' },
      { key: 'published', label: '回复（成功）', align: 'end' },
      { key: 'failed', label: '回复（失败）', align: 'end' },
      { key: 'unknown', label: '回复（未知）', align: 'end' },
      { key: 'voice', label: '语音回复', align: 'end' },
    ],
    rowKey: (row) => row.name,
    emptyText: '这段时间还没有回复。',
    caption: '玩家统计（按角色）',
  });
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
  const bar = toolbar({
    title: '玩家统计',
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
  const since = h('p', { class: 'admin-hint', attrs: { role: 'status' } });
  const buttons = new Map<Tab, HTMLButtonElement>();
  const tabs = h('div', { class: 'admin-bar', attrs: { role: 'tablist', 'aria-label': '统计视图' } });
  for (const [id, label] of TABS) {
    const button = h('button', {
      class: 'admin-secondary',
      text: label,
      attrs: { type: 'button', role: 'tab', 'aria-selected': 'false' },
    });
    button.addEventListener('click', () => show(id));
    buttons.set(id, button);
    tabs.append(button);
  }
  const panels: Record<Tab, HTMLElement> = { days: days.root, characters: characters.root, models: models.root };
  function show(next: Tab) {
    tab = next;
    for (const [id, button] of buttons) button.setAttribute('aria-selected', String(id === tab));
    for (const id of Object.keys(panels) as Tab[]) panels[id].hidden = id !== tab;
  }
  root.replaceChildren(
    bar.root,
    since,
    h('p', {
      class: 'admin-hint',
      text: '只含数量，不含玩家、邮箱、昵称或聊天内容。日期按 UTC；回复按玩家发送消息的那一天统计；活跃 = 当天打开过网站，聊天人数 = 当天发过消息；留存只统计注册玩家，次日留存在第 3 天、7 日留存在第 9 天才显示（之前为“—”）。',
    }),
    tabs,
    days.root,
    characters.root,
    models.root,
  );
  show('days');
  async function load() {
    const view = await deps.load(range);
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
    characters.setRows(view.byCharacter);
    models.setRows(view.byModel);
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
      characters.setRows([]);
      models.setRows([]);
    },
  };
}

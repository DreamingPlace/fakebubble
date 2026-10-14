import type {
  ConversationsAdminClient,
  ReviewKey,
  ReviewLine,
  ReviewListRow,
  ReviewScope,
} from '../../services/conversations-admin-api.ts';
import { h } from '../cocreation/h.ts';
import { downloadText } from './preview/export.ts';
import { dataTable } from './ui/data-table.ts';
import { toolbar } from './ui/toolbar.ts';

export const conversationsCopy = {
  title: '测试对话',
  hint: '只显示匿名编号（角色名-四位编号）。不显示邮箱、昵称或账号；玩家昵称在文字里一律显示为〔昵称〕。账号或体验数据删除后，聊天文字仍以匿名编号保留 180 天。',
  empty: '还没有可查看的对话。玩家聊过天后会出现在这里。',
  deleted: '已删除',
  deletedOn: (day: string) => `已删除 · ${day} 消失`,
  live: '进行中',
  back: '返回列表',
  exportOne: '导出此对话 CSV',
  exportCharacter: '导出该角色全部对话 CSV',
  changed: '审核改动',
  failedReply: (code: string) => `回复失败 · ${code}`,
  speaker: { player: '玩家', character: '角色', proactive: '角色（主动）' } as const,
  prev: '上一页',
  next: '下一页',
  page: (page: number, pages: number, total: number) => `第 ${page} / ${pages} 页 · 共 ${total} 条`,
  exported: (name: string, lines: number) => `已导出 ${name}（${lines} 行）。`,
};

const keyOf = (row: Pick<ReviewListRow, 'characterId' | 'code' | 'archived'>): ReviewKey => ({
  characterId: row.characterId,
  code: row.code,
  archived: row.archived,
});
const same = (a: ReviewKey | null, b: ReviewKey | null) =>
  !!a && !!b && a.characterId === b.characterId && a.code === b.code && a.archived === b.archived;

/**
 * 测试对话. Read-only. A click that opens a transcript is never dropped: it goes through `runLatest` (the page's own
 * "newest waiting click wins" queue), and the work checks it is still the transcript the administrator last asked for.
 */
export function conversationsView(
  root: HTMLElement,
  deps: {
    api: Pick<ConversationsAdminClient, 'list' | 'detail' | 'export'>;
    run: (work: () => Promise<void>) => Promise<void>;
    runLatest: (work: () => Promise<void>) => void;
    status: (text: string) => void;
    disposed: () => boolean;
    save?: (filename: string, csv: string) => void;
  },
) {
  const save = deps.save ?? ((name: string, csv: string) => downloadText(name, csv, 'text/csv'));
  let characterId: string | null = null,
    scope: ReviewScope | null = null,
    listPage = 0;
  let wanted: (ReviewKey & { page: number }) | null = null;
  let open: ReviewKey | null = null;
  let pagerShown = false;

  const table = dataTable<ReviewListRow>({
    columns: [
      { key: 'label', label: '对话', sortable: true },
      {
        key: 'state',
        label: '状态',
        render: (r) => (r.archived ? conversationsCopy.deletedOn(r.expiresOn ?? '') : conversationsCopy.live),
        sortValue: (r) => (r.archived ? 1 : 0),
        sortable: true,
      },
      {
        key: 'messages',
        label: '消息数',
        align: 'end',
        sortable: true,
        sortValue: (r) => r.messages,
        render: (r) => String(r.messages),
      },
      { key: 'firstAt', label: '开始（角色当地时间）', sortable: true },
      { key: 'lastAt', label: '最近（角色当地时间）', sortable: true },
      {
        key: 'failed',
        label: '失败回复',
        align: 'end',
        sortable: true,
        sortValue: (r) => r.failed,
        render: (r) => String(r.failed),
      },
    ],
    rowKey: (r) => `${r.characterId}:${r.code}:${r.archived ? 'a' : 'l'}`,
    emptyText: conversationsCopy.empty,
    caption: conversationsCopy.title,
    openOn: 'click',
    onRowOpen: (r) => openTranscript(keyOf(r), 0),
  });
  const characterFilter = toolbar({
    title: conversationsCopy.title,
    filters: [
      { kind: 'select', id: 'character', label: '角色', options: [['', '全部角色']] },
      {
        kind: 'select',
        id: 'scope',
        label: '范围',
        options: [
          ['', '进行中和已删除'],
          ['live', '仅进行中'],
          ['archived', '仅已删除'],
        ],
      },
    ],
    actions: [{ label: '刷新', secondary: true, run: () => void deps.run(() => load()) }],
    onChange: (values) => {
      characterId = values.character || null;
      scope = values.scope === 'live' || values.scope === 'archived' ? values.scope : null;
      listPage = 0;
      void deps.run(() => load());
    },
  });
  const listArea = h(
    'div',
    { class: 'review-list' },
    characterFilter.root,
    h('p', { class: 'admin-hint', text: conversationsCopy.hint }),
    table.root,
  );
  const pager = h('div', { class: 'review-pager', hidden: true });
  const detailArea = h('div', { class: 'review-detail', hidden: true });
  root.replaceChildren(listArea, pager, detailArea);

  const setCharacters = (characters: { characterId: string; label: string }[]) => {
    const select = characterFilter.root.querySelector<HTMLSelectElement>('select');
    if (!select) return;
    const current = select.value;
    select.replaceChildren(h('option', { text: '全部角色', attrs: { value: '' } }));
    for (const c of characters) select.append(h('option', { text: c.label, attrs: { value: c.characterId } }));
    select.value = characters.some((c) => c.characterId === current) ? current : '';
  };
  async function load() {
    const result = await deps.api.list({ characterId, scope, page: listPage });
    if (deps.disposed()) return;
    setCharacters(result.characters);
    table.setRows(result.rows);
    const pages = Math.max(1, Math.ceil(result.total / result.pageSize));
    pagerShown = pages > 1;
    pager.hidden = !pagerShown;
    pager.replaceChildren(
      pagerButton(conversationsCopy.prev, listPage > 0, () => {
        listPage--;
        void deps.run(() => load());
      }),
      h('span', { text: conversationsCopy.page(listPage + 1, pages, result.total) }),
      pagerButton(conversationsCopy.next, listPage + 1 < pages, () => {
        listPage++;
        void deps.run(() => load());
      }),
    );
  }
  const pagerButton = (text: string, enabled: boolean, onClick: () => void) => {
    const button = h('button', { class: 'admin-secondary', text, attrs: { type: 'button' } });
    // The page re-enables every control after a run; data-locked keeps a boundary button off.
    if (!enabled) {
      button.disabled = true;
      button.dataset.locked = 'true';
    }
    button.addEventListener('click', onClick);
    return button;
  };

  function openTranscript(key: ReviewKey, page: number) {
    wanted = { ...key, page };
    const mine = wanted;
    deps.runLatest(async () => {
      // A newer click replaced this one while it waited: only the newest is shown.
      if (wanted !== mine || deps.disposed()) return;
      const detail = await deps.api.detail({ ...key, page });
      if (wanted !== mine || deps.disposed()) return;
      open = key;
      renderDetail(detail);
    });
  }
  const lineNode = (line: ReviewLine) => {
    const failed = line.status === 'failed';
    return h(
      'li',
      { class: `review-line is-${line.speaker}${failed ? ' is-failed' : ''}` },
      h('span', { class: 'review-time', text: line.time }),
      h('span', { class: 'review-speaker', text: conversationsCopy.speaker[line.speaker] }),
      h('span', {
        class: 'review-text',
        text: failed ? conversationsCopy.failedReply(line.errorCode ?? 'UNKNOWN') : line.text,
      }),
      line.reviewChanged ? h('span', { class: 'review-changed', text: conversationsCopy.changed }) : null,
    );
  };
  function renderDetail(detail: Awaited<ReturnType<typeof deps.api.detail>>) {
    const key = keyOf(detail);
    const pages = Math.max(1, Math.ceil(detail.total / detail.pageSize));
    const back = h('button', { class: 'admin-secondary', text: conversationsCopy.back, attrs: { type: 'button' } });
    back.addEventListener('click', () => {
      wanted = null;
      open = null;
      detailArea.hidden = true;
      listArea.hidden = false;
      pager.hidden = !pagerShown;
    });
    const exportOne = h('button', {
      class: 'admin-secondary',
      text: conversationsCopy.exportOne,
      attrs: { type: 'button' },
    });
    exportOne.addEventListener('click', () => void deps.run(() => exportCsv(key)));
    const exportAll = h('button', {
      class: 'admin-secondary',
      text: conversationsCopy.exportCharacter,
      attrs: { type: 'button' },
    });
    exportAll.addEventListener('click', () => void deps.run(() => exportCsv({ characterId: key.characterId })));
    const nav = () =>
      h(
        'div',
        { class: 'review-pager' },
        pagerButton(conversationsCopy.prev, detail.page > 0, () => openTranscript(key, detail.page - 1)),
        h('span', { text: conversationsCopy.page(detail.page + 1, pages, detail.total) }),
        pagerButton(conversationsCopy.next, detail.page + 1 < pages, () => openTranscript(key, detail.page + 1)),
      );
    detailArea.replaceChildren(
      h(
        'div',
        { class: 'admin-bar' },
        back,
        h('strong', { class: 'admin-bar-title', text: detail.label }),
        h('span', {
          class: 'review-state',
          text: detail.archived ? conversationsCopy.deletedOn(detail.expiresOn ?? '') : conversationsCopy.live,
        }),
        h('span', { class: 'admin-bar-spacer' }),
        exportOne,
        exportAll,
      ),
      nav(),
      h('ol', { class: 'review-lines' }, ...detail.lines.map(lineNode)),
      nav(),
    );
    listArea.hidden = true;
    pager.hidden = true;
    detailArea.hidden = false;
  }
  async function exportCsv(input: ReviewKey | { characterId: string }) {
    const result = await deps.api.export(input);
    if (deps.disposed()) return;
    save(result.filename, result.csv);
    deps.status(conversationsCopy.exported(result.filename, result.lines));
  }
  return {
    load,
    clear: () => {
      table.setRows([]);
      wanted = null;
      open = null;
      detailArea.replaceChildren();
      detailArea.hidden = true;
      listArea.hidden = false;
      pagerShown = false;
      pager.hidden = true;
    },
    /** For tests and the page: the transcript currently shown. */
    current: () => open,
    isOpen: (key: ReviewKey) => same(open, key),
  };
}

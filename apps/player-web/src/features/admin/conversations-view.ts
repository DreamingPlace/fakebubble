import { exactCount } from './ui/hover-value.ts';
import type {
  ConversationsAdminClient,
  ReviewKey,
  ReviewLine,
  ReviewListRow,
  ReviewScope,
} from '../../services/conversations-admin-api.ts';
import { h } from '../cocreation/h.ts';
import { downloadText } from './preview/export.ts';
import type { OwnerAdminClient } from '../../services/owner-admin-api.ts';
import { dataTable } from './ui/data-table.ts';
import { disclosureDetails } from './ui/disclosure.ts';
import type { ConfirmInPlace } from './ui/inline-confirm.ts';
import { segmented } from './ui/segmented.ts';
import { toolbar } from './ui/toolbar.ts';
import { errorLine, sentenceOf } from './ui/error-line.ts';

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
  failedReply: '这条回复没有成功',
  speaker: { player: '玩家', character: '角色', proactive: '角色（主动）' } as const,
  prev: '上一页',
  next: '下一页',
  page: (page: number, pages: number, total: number) => `第 ${page} / ${pages} 页 · 共 ${total} 条`,
  exported: (name: string, lines: number) => `已导出 ${name}（${lines} 行）。`,
  // Part 31 (owner): deleting test records for good, and closed accounts.
  deleteSelected: '删除所选…',
  deleteOne: '删除此对话…',
  confirmTitle: '删除测试对话',
  confirm: (n: number) => `永久删除 ${n} 条测试对话？聊天文字无法恢复；费用、用量和额度记录只保留数量。`,
  confirmGo: (n: number) => `永久删除 ${n} 条`,
  done: (deleted: number, skipped: number) =>
    skipped > 0 ? `已删除 ${deleted} 条；${skipped} 条还有回复进行中，没有删除。` : `已删除 ${deleted} 条。`,
  closedTitle: '已关闭账号',
  closedPolicy: '账号关闭后的聊天文字',
  closedRetention: '按保留期',
  closedImmediate: '立即',
  closedPolicyHint: '按保留期：匿名保留 180 天。立即：账号关闭时一并删除。',
  closedEmpty: '没有保留聊天文字的已关闭账号。',
  closedDelete: '删除聊天…',
  closedConfirm: (number: string) => `现在删除玩家编号 ${number} 剩余的全部聊天文字？无法恢复。`,
  closedConfirmGo: '立即删除',
  closedDone: (lines: number) => `已删除 ${lines} 行聊天文字。`,
  closedSaved: '已保存。',
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
    /** Part 31: the owner's deletions and the 已关闭账号 panel. Absent (any other administrator) = none of it is drawn. */
    owner?: Pick<OwnerAdminClient, 'deleteConversations' | 'closedRead' | 'closedPolicy' | 'closedDelete'>;
    /** Whether the signed-in administrator is the owner (read when the list loads, after sign-in). */
    isOwner?: () => boolean;
    confirm?: ConfirmInPlace;
    toast?: (text: string, tone?: 'ok' | 'info' | 'warn' | 'danger') => void;
  },
) {
  const save = deps.save ?? ((name: string, csv: string) => downloadText(name, csv, 'text/csv'));
  let characterId: string | null = null,
    scope: ReviewScope | null = null,
    listPage = 0;
  let wanted: (ReviewKey & { page: number }) | null = null;
  let open: ReviewKey | null = null;
  let pagerShown = false;
  let closedLoad: (() => Promise<void>) | null = null;

  const makeTable = (owned: boolean) =>
    dataTable<ReviewListRow>({
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
          render: (r) => exactCount(r.messages),
        },
        { key: 'firstAt', label: '开始（角色当地时间）', sortable: true },
        { key: 'lastAt', label: '最近（角色当地时间）', sortable: true },
        {
          key: 'failed',
          label: '失败回复',
          align: 'end',
          sortable: true,
          sortValue: (r) => r.failed,
          render: (r) => exactCount(r.failed),
        },
      ],
      rowKey: (r) => `${r.characterId}:${r.code}:${r.archived ? 'a' : 'l'}`,
      emptyText: conversationsCopy.empty,
      caption: conversationsCopy.title,
      openOn: 'click',
      onRowOpen: (r) => openTranscript(keyOf(r), 0),
      ...(owned && deps.owner && deps.confirm
        ? {
            bulkActions: [
              {
                label: conversationsCopy.deleteSelected,
                danger: true,
                run: (rows: ReviewListRow[]) => askDelete(rows.map(keyOf)),
              },
            ],
          }
        : {}),
    });
  // The owner's table carries the checkboxes and the delete bar; every other administrator gets the read-only one (the page decides at load).
  const plainTable = makeTable(false);
  // (built the first time the owner opens the list: no other administrator's page holds a checkbox, hidden or not)
  let ownerTable: ReturnType<typeof makeTable> | null = null;
  let table = plainTable;
  const confirmHost = h('div', { class: 'review-confirm' });
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
    onChange: (values) => {
      characterId = values.character || null;
      scope = values.scope === 'live' || values.scope === 'archived' ? values.scope : null;
      listPage = 0;
      void deps.run(() => load());
    },
  });
  const closedNode = deps.owner ? closedPanel() : null;
  if (closedNode) closedNode.hidden = true;
  const listArea = h(
    'div',
    { class: 'review-list' },
    characterFilter.root,
    h('p', { class: 'admin-hint', text: conversationsCopy.hint }),
    confirmHost,
    plainTable.root,
    closedNode,
  );
  const pager = h('div', { class: 'review-pager', hidden: true });
  const detailArea = h('div', { class: 'review-detail', hidden: true });
  root.replaceChildren(listArea, pager, detailArea);

  /** Part 31: one question naming the count, then the deletion; the list is read again either way. */
  async function askDelete(keys: ReviewKey[], afterDone?: () => void) {
    if (!deps.owner || !deps.confirm || keys.length === 0) return;
    const yes = await deps.confirm(
      {
        title: conversationsCopy.confirmTitle,
        message: conversationsCopy.confirm(keys.length),
        confirmLabel: conversationsCopy.confirmGo(keys.length),
      },
      confirmHost,
    );
    if (!yes || deps.disposed()) return;
    await deps.run(async () => {
      const result = await deps.owner!.deleteConversations(keys);
      deps.toast?.(conversationsCopy.done(result.deleted, result.skipped), result.skipped > 0 ? 'warn' : 'ok');
      afterDone?.();
      await load();
    });
  }
  function closedPanel() {
    const body = h('div', { class: 'closed-body' });
    const rowsHost = h('div', { class: 'closed-rows' });
    const hint = h('p', { class: 'admin-hint', text: conversationsCopy.closedPolicyHint });
    const state = { policy: 'retention' as 'retention' | 'immediate' };
    const pick = segmented(
      conversationsCopy.closedPolicy,
      [
        { id: 'retention', label: conversationsCopy.closedRetention },
        { id: 'immediate', label: conversationsCopy.closedImmediate },
      ] as const,
      state.policy,
      (policy) =>
        void deps.run(async () => {
          const next = await deps.owner!.closedPolicy(policy);
          state.policy = next.policy;
          deps.toast?.(conversationsCopy.closedSaved, 'ok');
          paintClosed(next);
        }),
    );
    const detailsNode = h('details', { class: 'closed-panel', attrs: { open: '' } });
    disclosureDetails(detailsNode, conversationsCopy.closedTitle);
    detailsNode.append(
      h('div', { class: 'closed-policy' }, h('span', { text: conversationsCopy.closedPolicy }), pick.root),
      hint,
      body,
    );
    body.append(rowsHost);
    const paintClosed = (view: Awaited<ReturnType<NonNullable<typeof deps.owner>['closedRead']>>) => {
      state.policy = view.policy;
      pick.set(view.policy);
      if (view.rows.length === 0) {
        rowsHost.replaceChildren(h('p', { class: 'admin-empty', text: conversationsCopy.closedEmpty }));
        return;
      }
      rowsHost.replaceChildren(
        h(
          'table',
          { class: 'admin-table closed-table', attrs: { 'aria-label': conversationsCopy.closedTitle } },
          h('thead', {}, h('tr', {}, h('th', { text: '玩家编号' }), h('th', { text: '关闭日期' }), h('th', {}))),
          h(
            'tbody',
            {},
            ...view.rows.map((row) => {
              const go = h('button', {
                class: 'admin-secondary is-danger',
                text: conversationsCopy.closedDelete,
                attrs: { type: 'button' },
              });
              const cell = h('td', { class: 'closed-act' }, go);
              go.addEventListener(
                'click',
                () =>
                  void (async () => {
                    const yes = await deps.confirm?.(
                      {
                        title: conversationsCopy.closedTitle,
                        message: conversationsCopy.closedConfirm(row.playerNumber),
                        confirmLabel: conversationsCopy.closedConfirmGo,
                      },
                      confirmHost,
                    );
                    if (!yes || deps.disposed()) return;
                    await deps.run(async () => {
                      const result = await deps.owner!.closedDelete(row.playerNumber);
                      deps.toast?.(conversationsCopy.closedDone(result.lines), 'ok');
                      paintClosed(await deps.owner!.closedRead());
                      await load();
                    });
                  })(),
              );
              return h('tr', {}, h('td', { text: row.playerNumber }), h('td', { text: row.closedOn }), cell);
            }),
          ),
        ),
      );
    };
    closedLoad = async () => paintClosed(await deps.owner!.closedRead());
    return detailsNode;
  }
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
    const owned = !!deps.owner && deps.isOwner?.() === true;
    if (owned && !ownerTable) {
      ownerTable = makeTable(true);
      plainTable.root.after(ownerTable.root);
    }
    plainTable.root.hidden = owned;
    if (ownerTable) ownerTable.root.hidden = !owned;
    if (closedNode) closedNode.hidden = !owned;
    table = owned && ownerTable ? ownerTable : plainTable;
    setCharacters(result.characters);
    table.setRows(result.rows);
    if (owned && closedLoad) await closedLoad().catch(() => undefined);
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
      failed
        ? errorLine(line.errorCode, {
            class: 'review-text',
            sentence: `${conversationsCopy.failedReply}：${sentenceOf(line.errorCode, '原因未知')}`,
          })
        : h('span', { class: 'review-text', text: line.text }),
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
        ...(deps.owner && deps.confirm && deps.isOwner?.() === true
          ? [
              (() => {
                const del = h('button', {
                  class: 'admin-secondary is-danger',
                  text: conversationsCopy.deleteOne,
                  attrs: { type: 'button' },
                });
                del.addEventListener('click', () => void askDelete([key], () => back.click()));
                return del;
              })(),
            ]
          : []),
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
      plainTable.setRows([]);
      ownerTable?.setRows([]);
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

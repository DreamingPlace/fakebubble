/**
 * Part 37c-1: 角色 → 网络梗. The internet-meme dictionary (shipped data, CC BY 4.0): search, filters, one switch per entry; 开启所选 /
 * 关闭所选 for what is ticked. The meanings are shared; how each character USES an entry (会用 / 只懂 / 不碰) is set in 角色工作台 → 说话档案.
 *
 * Part 37c-1b: the page is an EDITABLE LIBRARY (the shipped entries, re-curated, + the owner's own) and a 待审 queue.
 *   词库: category and source on every row; filters for category, source, 默认关闭 and 已删除; 添加词条, 编辑 (meaning and category of any
 *   entry, 恢复原文 for a shipped one), the switch (the owner's switch overrides the shipped default both ways), 删除 (his own entries for
 *   good after a confirm; shipped ones go to 已删除 and can be restored there), 上传导入 (everything goes to 待审), 导出.
 *   待审: suggestions to approve (通过) or refuse (不要) one by one or in bulk. Nothing enters the library without this page.
 * Every change is live for the next reply (no 草稿 / 发布). Explanatory text only beside the irreversible delete; hover tips elsewhere.
 */
import {
  MEME_PAGE_SIZE,
  MEME_SOURCES,
  MEME_SOURCE_LABELS,
  type MemeEntryView,
  type MemeListView,
  type MemeSource,
  type MemeState,
} from '../../../../../packages/contracts/web-memes.ts';
import { h } from '../cocreation/h.ts';
import type { MakeExport } from './export/export-dialog.ts';
import { entryDrawer } from './memes/entry-drawer.ts';
import { importDrawer } from './memes/import-drawer.ts';
import { categoryOrderLabel, codeOf, count, requestIds, sourceLabel, type MemesDeps } from './memes/memes-shared.ts';
import { queuePanel } from './memes/queue-panel.ts';
import { dataTable } from './ui/data-table.ts';
import { errorLine } from './ui/error-line.ts';
import { hoverValue } from './ui/hover-value.ts';
import { pageHead, statusLine } from './ui/page-head.ts';
import { segmented } from './ui/segmented.ts';
import { adminConnection, INTERRUPTED_LINE, isInterrupted } from '../../services/admin-connection.ts';

type Deps = MemesDeps & {
  /** Part 57: the page's 导出 button (without it there is none). */
  makeExport?: MakeExport | undefined;
};

export function memesView(root: HTMLElement, deps: Deps) {
  let view: MemeListView | null = null;
  let query = '';
  let year: number | null = null;
  let tag: string | null = null;
  let category: string | null = null;
  let source: MemeSource | null = null;
  let state: MemeState = 'all';
  let page = 1;
  let tab: 'library' | 'queue' = 'library';
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** The newest list request: an older answer arriving later never paints over a newer one. */
  let ticket = 0;
  const ids = requestIds(deps.newRequestId);

  const status = statusLine();
  const error = h('p', { class: 'mm-error', attrs: { role: 'alert' }, hidden: true });
  const showError = (caught: unknown) => {
    error.replaceChildren(errorLine(codeOf(caught)));
    error.hidden = false;
  };
  const confirmHost = h('div', { class: 'mm-confirm-host' });

  // ---- the filters ------------------------------------------------------------------------------------------------------------
  const search = h('input', {
    attrs: { type: 'search', 'aria-label': '搜索词、释义或标签', placeholder: '搜索词、释义或标签' },
  });
  const categorySelect = h('select', { attrs: { 'aria-label': '分类' } });
  const sourceSelect = h('select', { attrs: { 'aria-label': '来源' } });
  sourceSelect.append(h('option', { text: '全部来源', attrs: { value: '' } }));
  for (const value of MEME_SOURCES)
    sourceSelect.append(h('option', { text: MEME_SOURCE_LABELS[value], attrs: { value } }));
  const yearSelect = h('select', { attrs: { 'aria-label': '年份' } });
  const tagSelect = h('select', { attrs: { 'aria-label': '标签' } });
  const stateSelect = h('select', { attrs: { 'aria-label': '状态' } });
  const stateOption = (value: MemeState, text: string) => h('option', { text, attrs: { value } });
  const fillStates = () =>
    stateSelect.replaceChildren(
      stateOption('all', '全部'),
      stateOption('on', '已开启'),
      stateOption('off', '已关闭'),
      stateOption('default-off', view ? `默认关闭（${count(view.defaultOff)}）` : '默认关闭'),
      stateOption('deleted', view ? `已删除（${count(view.deleted)}）` : '已删除'),
    );
  fillStates();
  stateSelect.value = state;
  const field = (label: string, input: HTMLElement) =>
    h('label', { class: 'admin-filter' }, h('span', { text: label }), input);
  const addButton = h('button', { class: 'admin-primary', text: '添加词条', attrs: { type: 'button' } });
  const importButton = h('button', { class: 'admin-secondary', text: '上传导入', attrs: { type: 'button' } });
  hoverValue(addButton, '自己加一个词；它直接进词库，默认开启');
  hoverValue(importButton, '上传 CSV 或 .xlsx，通过检查的行先进待审');
  const bar = h(
    'div',
    { class: 'admin-bar mm-bar', attrs: { role: 'toolbar', 'aria-label': '筛选' } },
    field('搜索', search),
    field('分类', categorySelect),
    field('来源', sourceSelect),
    field('年份', yearSelect),
    field('标签', tagSelect),
    field('状态', stateSelect),
  );

  // ---- the tables -------------------------------------------------------------------------------------------------------------
  const switchFor = (entry: MemeEntryView) => {
    const sw = h('button', {
      class: 'mm-switch',
      text: entry.enabled ? '已开启' : '已关闭',
      attrs: {
        type: 'button',
        role: 'switch',
        'aria-checked': String(entry.enabled),
        'aria-label': `开启「${entry.term}」`,
      },
    });
    sw.disabled = !deps.canEdit();
    hoverValue(sw, entry.enabled ? '开着：玩家的话里出现它时会被识别' : '关着：不会被识别');
    sw.addEventListener('click', () => void apply([entry.key], !entry.enabled));
    return sw;
  };
  const termCell = (row: MemeEntryView) => {
    const cell = h('span', { class: 'mm-termcell' }, h('strong', { class: 'mm-term', text: row.term }));
    // A shipped entry that ships off (dropped in the re-curation, or an everyday word) keeps its badge whatever the switch says now.
    if (row.defaultOff && !row.deleted)
      cell.append(
        hoverValue(
          h('span', { class: 'mm-default-off', text: '默认关闭' }),
          '自带时就是关着的（不常用，或是日常用语）；可以手动开启',
        ),
      );
    if (row.edited)
      cell.append(
        hoverValue(
          h('span', { class: 'mm-default-off mm-edited', text: '已改' }),
          '释义或分类改过；编辑里可以恢复原文',
        ),
      );
    return cell;
  };
  const baseColumns = [
    { key: 'term', label: '词', render: termCell },
    {
      key: 'meaning',
      label: '释义',
      render: (row: MemeEntryView) => h('span', { class: 'mm-meaning', text: row.meaning }),
    },
    {
      key: 'year',
      label: '年份',
      sortable: true,
      sortValue: (row: MemeEntryView) => row.year,
      render: (row: MemeEntryView) => (row.year === null ? '—' : String(row.year)),
    },
    {
      key: 'tags',
      label: '标签',
      render: (row: MemeEntryView) =>
        h('span', { class: 'mm-tags' }, ...row.tags.map((t) => h('span', { class: 'mm-tag', text: t }))),
    },
    {
      key: 'category',
      label: '分类',
      render: (row: MemeEntryView) => h('span', { class: 'mm-category', text: row.category }),
    },
    {
      key: 'source',
      label: '来源',
      render: (row: MemeEntryView) =>
        h('span', { class: `mm-source mm-source-${row.source}`, text: sourceLabel(row.source) }),
    },
  ];
  const actionButton = (text: string, tip: string, danger: boolean, run: () => void) => {
    const button = h('button', {
      class: danger ? 'admin-secondary mm-danger' : 'admin-secondary',
      text,
      attrs: { type: 'button' },
    });
    button.disabled = !deps.canEdit();
    hoverValue(button, tip);
    button.addEventListener('click', run);
    return button;
  };
  const libraryTable = dataTable<MemeEntryView>({
    columns: [
      ...baseColumns,
      { key: 'enabled', label: '开关', render: (row) => switchFor(row) },
      {
        key: 'actions',
        label: '',
        render: (row) =>
          h(
            'span',
            { class: 'mm-row-actions' },
            actionButton('编辑', '改释义和分类', false, () => entries.openEdit(row)),
            actionButton(
              '删除',
              row.source === 'builtin' ? '移到已删除，可以恢复' : '永久删除你自己加的词',
              true,
              () => void remove([row]),
            ),
          ),
      },
    ],
    rowKey: (row) => row.key,
    emptyText: '没有符合的词条。',
    caption: '网络梗',
    bulkActions: [
      {
        label: '开启所选',
        run: (rows) =>
          apply(
            rows.map((r) => r.key),
            true,
          ),
      },
      {
        label: '关闭所选',
        run: (rows) =>
          apply(
            rows.map((r) => r.key),
            false,
          ),
      },
      { label: '删除所选', danger: true, run: (rows) => remove(rows) },
    ],
  });
  const deletedTable = dataTable<MemeEntryView>({
    columns: [
      ...baseColumns,
      {
        key: 'actions',
        label: '',
        render: (row) =>
          h(
            'span',
            { class: 'mm-row-actions' },
            actionButton('恢复', '放回词库，开关和修改都还在', false, () => void restore([row])),
          ),
      },
    ],
    rowKey: (row) => row.key,
    emptyText: '已删除里没有词条。',
    caption: '已删除',
    bulkActions: [{ label: '恢复所选', run: (rows) => restore(rows) }],
  });
  const prev = h('button', { class: 'admin-secondary', text: '上一页', attrs: { type: 'button' } });
  const next = h('button', { class: 'admin-secondary', text: '下一页', attrs: { type: 'button' } });
  const pageNote = h('span', { class: 'mm-page' });
  const pager = h('div', { class: 'mm-pager' }, prev, pageNote, next);

  const queue = queuePanel(deps, {
    onChanged: async (message) => {
      await fetchList();
      await queue.load();
      deps.toast(message);
    },
  });

  // ---- the drawers --------------------------------------------------------------------------------------------------------------
  // (the drawers live in their own host: the page's `replaceChildren` below would otherwise wipe them)
  const drawerHost = h('div', { class: 'mm-drawers' });
  const entries = entryDrawer(drawerHost, deps, {
    onSaved: async (message, key) => {
      query = key;
      state = 'all';
      category = source = null;
      syncControls();
      page = 1;
      await fetchList();
      deps.toast(message);
    },
    onShowExisting: (key, deleted) => {
      query = key;
      state = deleted ? 'deleted' : 'all';
      category = source = year = tag = null;
      syncControls();
      showTab('library');
      refilter();
    },
  });
  const imports = importDrawer(drawerHost, deps, {
    onQueued: async (queued) => {
      await fetchList();
      showTab('queue');
      deps.toast(queued > 0 ? `已放入待审 ${count(queued)} 条` : '没有新的行放入待审');
    },
  });
  addButton.addEventListener('click', () => entries.openAdd());
  importButton.addEventListener('click', () => imports.open());

  // ---- painting -----------------------------------------------------------------------------------------------------------------
  const syncControls = () => {
    search.value = query;
    stateSelect.value = state;
    categorySelect.value = category ?? '';
    sourceSelect.value = source ?? '';
    yearSelect.value = year === null ? '' : String(year);
    tagSelect.value = tag ?? '';
  };
  const fillSelects = () => {
    if (!view) return;
    categorySelect.replaceChildren(
      h('option', { text: '全部分类', attrs: { value: '' } }),
      ...view.categories.map((c) =>
        h('option', { text: categoryOrderLabel(c.category, c.count), attrs: { value: c.category } }),
      ),
    );
    yearSelect.replaceChildren(
      h('option', { text: '全部年份', attrs: { value: '' } }),
      ...view.years.map((y) => h('option', { text: String(y), attrs: { value: String(y) } })),
    );
    tagSelect.replaceChildren(
      h('option', { text: '全部标签', attrs: { value: '' } }),
      ...view.tags.map((t) => h('option', { text: `${t.tag}（${count(t.count)}）`, attrs: { value: t.tag } })),
    );
    // A tag typed into 搜索 still finds every tag; the list holds the most used ones.
    fillStates();
    syncControls();
  };
  const fillStatus = (v: MemeListView) => {
    status.replaceChildren(
      h('span', { text: `共 ${count(v.total)} 条` }),
      h('i', { class: 'head-sep', attrs: { 'aria-hidden': 'true' } }),
      h('span', { class: 'mm-on', text: `已开启 ${count(v.on)} 条` }),
      h('i', { class: 'head-sep', attrs: { 'aria-hidden': 'true' } }),
      h('span', { class: v.pending > 0 ? 'mm-pending' : '', text: `待审 ${count(v.pending)} 条` }),
    );
  };
  const paint = () => {
    if (!view) return;
    fillStatus(view);
    const inDeleted = state === 'deleted';
    libraryTable.root.hidden = inDeleted;
    deletedTable.root.hidden = !inDeleted;
    (inDeleted ? deletedTable : libraryTable).setRows(view.entries);
    pageNote.textContent = `第 ${view.page} / ${view.pages} 页 · 符合 ${count(view.matching)} 条（每页 ${MEME_PAGE_SIZE} 条）`;
    prev.disabled = view.page <= 1;
    next.disabled = view.page >= view.pages;
    pager.hidden = view.pages <= 1;
  };

  async function fetchList() {
    const mine = ++ticket;
    try {
      const got = await deps.api.memesList({ query, year, tag, state, page, category, source });
      if (deps.disposed() || mine !== ticket) return;
      view = got;
      page = got.page;
      error.hidden = true;
      fillSelects();
      paint();
    } catch (caught) {
      if (deps.disposed() || mine !== ticket) return;
      showError(caught);
    }
  }
  /** Run one owner write under a request id kept until its answer is seen, then reload. */
  async function write(signature: string, run: (id: string) => Promise<unknown>, message: string) {
    if (!deps.canEdit()) return;
    try {
      await run(ids.of(signature));
      ids.done(signature);
      adminConnection.forget(`memes-write:${signature}`);
      libraryTable.clearSelection();
      deletedTable.clearSelection();
      await fetchList();
      deps.toast(message);
    } catch (caught) {
      if (deps.disposed()) return;
      // Part 59: not a failed switch but an interruption (Access / challenge / expired session): the request id is kept, and the
      // same write is sent again by itself after re-authentication (it cannot apply twice).
      if (isInterrupted(caught)) {
        error.replaceChildren(INTERRUPTED_LINE);
        error.hidden = false;
        adminConnection.retryAfterReauth(`memes-write:${signature}`, () => write(signature, run, message));
        return;
      }
      showError(caught);
    }
  }
  const apply = (keys: readonly string[], enabled: boolean) =>
    keys.length === 0
      ? Promise.resolve()
      : write(
          `set:${enabled ? 1 : 0}:${[...keys].sort().join('|')}`,
          (id) => deps.api.memesSet(id, keys, enabled),
          enabled ? '已开启' : '已关闭',
        );
  const restore = (rows: readonly MemeEntryView[]) =>
    write(
      `restore:${rows
        .map((r) => r.key)
        .sort()
        .join('|')}`,
      (id) =>
        deps.api.memesRestore(
          id,
          rows.map((r) => r.key),
        ),
      '已恢复',
    );
  async function remove(rows: readonly MemeEntryView[]) {
    if (!deps.canEdit() || rows.length === 0) return;
    const own = rows.filter((row) => row.source !== 'builtin');
    if (own.length > 0) {
      // The one place the page explains itself: a permanent delete cannot be undone.
      const message =
        own.length === rows.length
          ? rows.length === 1
            ? `「${rows[0]!.term}」是你自己添加的，删除后无法找回。`
            : `所选 ${count(rows.length)} 条都是你自己添加的，删除后无法找回。`
          : `所选 ${count(rows.length)} 条里有 ${count(own.length)} 条是你自己添加的，删除后无法找回；其余的会进入「已删除」，可以恢复。`;
      const ok = await deps.confirm({ title: '永久删除', message, confirmLabel: '永久删除' }, confirmHost);
      if (!ok) return;
    }
    await write(
      `delete:${rows
        .map((r) => r.key)
        .sort()
        .join('|')}`,
      (id) =>
        deps.api.memesDelete(
          id,
          rows.map((r) => r.key),
        ),
      own.length === rows.length ? '已删除' : '已删除；自带的在「已删除」里可以恢复',
    );
  }

  const refilter = () => {
    page = 1;
    void fetchList();
  };
  search.addEventListener('input', () => {
    query = search.value;
    if (timer) clearTimeout(timer);
    timer = setTimeout(refilter, 250);
  });
  categorySelect.addEventListener('change', () => {
    category = categorySelect.value === '' ? null : categorySelect.value;
    refilter();
  });
  sourceSelect.addEventListener('change', () => {
    source = sourceSelect.value === '' ? null : (sourceSelect.value as MemeSource);
    refilter();
  });
  yearSelect.addEventListener('change', () => {
    year = yearSelect.value === '' ? null : Number(yearSelect.value);
    refilter();
  });
  tagSelect.addEventListener('change', () => {
    tag = tagSelect.value === '' ? null : tagSelect.value;
    refilter();
  });
  stateSelect.addEventListener('change', () => {
    state = stateSelect.value as MemeState;
    refilter();
  });
  prev.addEventListener('click', () => {
    page = Math.max(1, page - 1);
    void fetchList();
  });
  next.addEventListener('click', () => {
    page += 1;
    void fetchList();
  });
  hoverValue(search, '词、释义、分类和标签都会被搜到');
  hoverValue(categorySelect, '只看一个分类');
  hoverValue(sourceSelect, '自带、手动添加、上传，以及之后的梗雷达、玩家聊天');
  hoverValue(stateSelect, '默认关闭：自带时就是关着的；已删除：可以在那里恢复');

  // ---- the two tabs -------------------------------------------------------------------------------------------------------------
  const libraryPanel = h(
    'div',
    { class: 'mm-panel', attrs: { 'data-mm-panel': 'library' } },
    bar,
    confirmHost,
    error,
    libraryTable.root,
    deletedTable.root,
    pager,
  );
  const queuePane = h('div', { class: 'mm-panel', hidden: true, attrs: { 'data-mm-panel': 'queue' } }, queue.root);
  const tabs = segmented<'library' | 'queue'>(
    '网络梗视图',
    [
      { id: 'library', label: '词库' },
      { id: 'queue', label: '待审' },
    ],
    'library',
    (id) => showTab(id),
    'm',
  );
  function showTab(next: 'library' | 'queue') {
    tab = next;
    tabs.set(next);
    libraryPanel.hidden = next !== 'library';
    queuePane.hidden = next !== 'queue';
    for (const pane of [libraryPanel, queuePane]) pane.classList.toggle('mm-panel-in', !pane.hidden);
    if (next === 'queue') void queue.load();
  }

  // Part 57: 导出 respects everything on screen (the whole library, not one page): search, category, source, year, tag, state.
  const exportButton = deps.makeExport?.(() => [
    {
      id: 'memes',
      label: '网络梗',
      kind: 'memes',
      range: 'none',
      filters: () => ({ query, year, tag, state, category, source }),
    },
  ]);
  // 添加词条 is the page's one solid button; 上传导入 and 导出 sit beside it in the title row.
  root.replaceChildren(
    pageHead('网络梗', status, importButton, addButton, exportButton),
    tabs.root,
    libraryPanel,
    queuePane,
    drawerHost,
  );
  deletedTable.root.hidden = true;
  return {
    // (the shell's own `run` already wraps a page load: a nested one would be skipped as busy)
    load: async () => {
      await fetchList();
      if (tab === 'queue') await queue.load();
    },
    clear() {
      if (timer) clearTimeout(timer);
      ticket++;
      view = null;
      ids.clear();
      queue.clear();
      entries.close();
      imports.close();
    },
  };
}

/**
 * Part 37c-1: 角色 → 网络梗. The internet-meme dictionary (shipped data, CC BY 4.0): search, year, tag, state; one switch per entry;
 * 开启所选 / 关闭所选 for what is ticked; a count of the entries that are on. An entry is ON until it is switched off. The meanings
 * are shared; how each character USES an entry (会用 / 只懂 / 不碰) is set in 角色工作台 → 说话档案. No explanation lines: hover tips only.
 */
import { MEME_PAGE_SIZE, type MemeEntryView, type MemeListView } from '../../../../../packages/contracts/web-memes.ts';
import type { CastAdminClient } from '../../services/cast-admin-api.ts';
import { h } from '../cocreation/h.ts';
import { dataTable } from './ui/data-table.ts';
import { errorLine } from './ui/error-line.ts';
import { hoverValue } from './ui/hover-value.ts';
import { pageHead, statusLine } from './ui/page-head.ts';

type Deps = {
  api: Pick<CastAdminClient, 'memesList' | 'memesSet'>;
  canEdit: () => boolean;
  newRequestId: () => string;
  disposed: () => boolean;
  toast: (text: string) => void;
};
const codeOf = (error: unknown) =>
  error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : '';
const count = (n: number) => n.toLocaleString('en-US');

export function memesView(root: HTMLElement, deps: Deps) {
  let view: MemeListView | null = null;
  let query = '';
  let year: number | null = null;
  let tag: string | null = null;
  let state: 'all' | 'on' | 'off' = 'all';
  let page = 1;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** The newest list request: an older answer arriving later never paints over a newer one. */
  let ticket = 0;
  /** A switch whose answer was never seen is retried under the SAME request id, so it can never apply twice. */
  const pending = new Map<string, string>();

  const status = statusLine();
  const error = h('p', { class: 'mm-error', attrs: { role: 'alert' }, hidden: true });
  const showError = (caught: unknown) => {
    error.replaceChildren(errorLine(codeOf(caught)));
    error.hidden = false;
  };

  const search = h('input', {
    attrs: { type: 'search', 'aria-label': '搜索词、释义或标签', placeholder: '搜索词、释义或标签' },
  });
  const yearSelect = h('select', { attrs: { 'aria-label': '年份' } });
  const tagSelect = h('select', { attrs: { 'aria-label': '标签' } });
  const stateSelect = h('select', { attrs: { 'aria-label': '状态' } });
  for (const [value, text] of [
    ['all', '全部'],
    ['on', '已开启'],
    ['off', '已关闭'],
  ] as const)
    stateSelect.append(h('option', { text, attrs: { value } }));
  const field = (label: string, input: HTMLElement) =>
    h('label', { class: 'admin-filter' }, h('span', { text: label }), input);
  const bar = h(
    'div',
    { class: 'admin-bar mm-bar', attrs: { role: 'toolbar', 'aria-label': '筛选' } },
    field('搜索', search),
    field('年份', yearSelect),
    field('标签', tagSelect),
    field('状态', stateSelect),
  );

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
    sw.addEventListener('click', () => void apply([entry.key], !entry.enabled));
    return sw;
  };
  const table = dataTable<MemeEntryView>({
    columns: [
      { key: 'term', label: '词', render: (row) => h('strong', { class: 'mm-term', text: row.term }) },
      { key: 'meaning', label: '释义', render: (row) => h('span', { class: 'mm-meaning', text: row.meaning }) },
      { key: 'year', label: '年份', sortable: true, sortValue: (row) => row.year },
      {
        key: 'tags',
        label: '标签',
        render: (row) =>
          h('span', { class: 'mm-tags' }, ...row.tags.map((t) => h('span', { class: 'mm-tag', text: t }))),
      },
      { key: 'enabled', label: '开关', render: (row) => switchFor(row) },
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
    ],
  });
  const prev = h('button', { class: 'admin-secondary', text: '上一页', attrs: { type: 'button' } });
  const next = h('button', { class: 'admin-secondary', text: '下一页', attrs: { type: 'button' } });
  const pageNote = h('span', { class: 'mm-page' });
  const pager = h('div', { class: 'mm-pager' }, prev, pageNote, next);

  const fillSelects = () => {
    if (!view) return;
    const keep = [yearSelect.value, tagSelect.value];
    yearSelect.replaceChildren(
      h('option', { text: '全部年份', attrs: { value: '' } }),
      ...view.years.map((y) => h('option', { text: String(y), attrs: { value: String(y) } })),
    );
    tagSelect.replaceChildren(
      h('option', { text: '全部标签', attrs: { value: '' } }),
      ...view.tags.map((t) => h('option', { text: `${t.tag}（${count(t.count)}）`, attrs: { value: t.tag } })),
    );
    // A tag typed into 搜索 still finds every tag; the list holds the most used ones.
    yearSelect.value = keep[0] ?? '';
    tagSelect.value = keep[1] ?? '';
  };
  const paint = () => {
    if (!view) return;
    fillStatus(view);
    table.setRows(view.entries);
    pageNote.textContent = `第 ${view.page} / ${view.pages} 页 · 符合 ${count(view.matching)} 条（每页 ${MEME_PAGE_SIZE} 条）`;
    prev.disabled = view.page <= 1;
    next.disabled = view.page >= view.pages;
    pager.hidden = view.pages <= 1;
  };
  const fillStatus = (v: MemeListView) => {
    status.replaceChildren(
      h('span', { text: `共 ${count(v.total)} 条` }),
      h('i', { class: 'head-sep', attrs: { 'aria-hidden': 'true' } }),
      h('span', { class: 'mm-on', text: `已开启 ${count(v.on)} 条` }),
    );
  };

  async function fetchList() {
    const mine = ++ticket;
    try {
      const got = await deps.api.memesList({ query, year, tag, state, page });
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
  async function apply(keys: readonly string[], enabled: boolean) {
    if (!deps.canEdit() || keys.length === 0) return;
    const sig = `${enabled ? 1 : 0}:${[...keys].sort().join('|')}`;
    if (!pending.has(sig)) pending.set(sig, deps.newRequestId());
    try {
      await deps.api.memesSet(pending.get(sig)!, keys, enabled);
      pending.delete(sig);
      table.clearSelection();
      await fetchList();
      deps.toast(enabled ? '已开启' : '已关闭');
    } catch (caught) {
      if (deps.disposed()) return;
      showError(caught);
    }
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
  yearSelect.addEventListener('change', () => {
    year = yearSelect.value === '' ? null : Number(yearSelect.value);
    refilter();
  });
  tagSelect.addEventListener('change', () => {
    tag = tagSelect.value === '' ? null : tagSelect.value;
    refilter();
  });
  stateSelect.addEventListener('change', () => {
    state = stateSelect.value as typeof state;
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
  hoverValue(search, '词、释义和标签都会被搜到');

  root.replaceChildren(pageHead('网络梗', status), bar, error, table.root, pager);
  return {
    // (the shell's own `run` already wraps a page load: a nested one would be skipped as busy)
    load: () => fetchList(),
    clear() {
      if (timer) clearTimeout(timer);
      ticket++;
      view = null;
      pending.clear();
    },
  };
}

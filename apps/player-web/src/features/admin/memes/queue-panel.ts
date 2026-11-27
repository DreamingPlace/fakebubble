import {
  MEME_MEANING_MAX,
  MEME_TERM_MAX,
  type MemeQueueItem,
  type MemeQueueView,
} from '../../../../../../packages/contracts/web-memes.ts';
import { h } from '../../cocreation/h.ts';
import { dataTable } from '../ui/data-table.ts';
import { errorLine } from '../ui/error-line.ts';
import { hoverValue } from '../ui/hover-value.ts';
import { categorySelect, codeOf, count, day, requestIds, sourceLabel, type MemesDeps } from './memes-shared.ts';

type Hooks = {
  /** The queue changed (items approved or dismissed): the page reloads its counts and its list. */
  onChanged: (message: string) => Promise<void> | void;
};
type Edit = { term: string; meaning: string; category: string };

/**
 * 待审: what an upload (now) and the automatic sources 梗雷达 / 玩家聊天 (Part 37c-2) suggest. Nothing in here is in the library yet.
 * Each item: the term and the meaning (both editable before approving), the category, the source and the date; when the term already
 * exists the current entry and the new version stand side by side. 通过 puts it into the library, ON; 不要 dismisses it (an automatic
 * source never suggests the same term again). Tick several rows for the bulk buttons.
 */
export function queuePanel(deps: MemesDeps, hooks: Hooks) {
  let view: MemeQueueView = { items: [], pending: 0 };
  /** What the owner typed into a row, by the queue's own term. Kept across repaints of the same list. */
  const edits = new Map<string, Edit>();
  const ids = requestIds(deps.newRequestId);
  let busy = false;
  let ticket = 0;

  const error = h('p', { class: 'mm-error', attrs: { role: 'alert' }, hidden: true });
  const editOf = (item: MemeQueueItem): Edit => {
    let edit = edits.get(item.term);
    if (!edit) {
      edit = { term: item.term, meaning: item.meaning, category: item.category };
      edits.set(item.term, edit);
    }
    return edit;
  };

  const contentCell = (item: MemeQueueItem) => {
    const edit = editOf(item);
    const term = h('input', {
      class: 'mm-q-term',
      attrs: { type: 'text', 'aria-label': `词：${item.term}`, maxlength: String(MEME_TERM_MAX * 2) },
    });
    term.value = edit.term;
    term.disabled = !deps.canEdit();
    term.addEventListener('input', () => (edit.term = term.value));
    const meaning = h('textarea', {
      class: 'mm-q-meaning',
      attrs: { rows: '2', 'aria-label': `释义：${item.term}`, maxlength: String(MEME_MEANING_MAX * 2) },
    });
    meaning.value = edit.meaning;
    meaning.disabled = !deps.canEdit();
    meaning.addEventListener('input', () => (edit.meaning = meaning.value));
    const category = categorySelect(edit.category, `分类：${item.term}`);
    category.classList.add('mm-q-category');
    category.disabled = !deps.canEdit();
    category.addEventListener('change', () => (edit.category = category.value));
    hoverValue(term, '通过前可以改词');
    hoverValue(meaning, '通过前可以改释义');
    // The label row of the new version carries 曾删除 when the owner deleted this term once.
    const label = h(
      'div',
      { class: 'mm-compare-head' },
      h('b', { text: item.existing || item.wasDeleted ? '新' : '建议' }),
    );
    if (item.wasDeleted)
      label.append(
        hoverValue(
          h('span', { class: 'mm-chip mm-chip-revive', text: '曾删除' }),
          '你删除过这个词；通过后它会回到词库',
        ),
      );
    const mine = h('div', { class: 'mm-compare-side mm-compare-new mm-q-edit' }, label, term, category, meaning);
    if (!item.existing) return h('div', { class: 'mm-q-content' }, mine);
    return h(
      'div',
      { class: 'mm-q-content mm-compare' },
      h(
        'div',
        { class: 'mm-compare-side' },
        h('b', { text: '现有' }),
        h('p', { text: item.existing.meaning }),
        h('i', {
          text: `${item.existing.category} · ${sourceLabel(item.existing.source)}${item.existing.enabled ? '' : ' · 已关闭'}`,
        }),
      ),
      mine,
    );
  };

  async function act(label: string, run: (id: string) => Promise<unknown>, signature: string) {
    if (busy || !deps.canEdit()) return;
    busy = true;
    error.hidden = true;
    try {
      await run(ids.of(signature));
      ids.done(signature);
      await hooks.onChanged(label);
    } catch (caught) {
      if (deps.disposed()) return;
      error.replaceChildren(errorLine(codeOf(caught)));
      error.hidden = false;
    } finally {
      busy = false;
    }
  }
  const payload = (items: readonly MemeQueueItem[]) =>
    items.map((item) => {
      const edit = editOf(item);
      const term = edit.term.trim();
      return {
        term: item.term,
        ...(term !== item.term ? { newTerm: term } : {}),
        meaning: edit.meaning.trim(),
        category: edit.category,
      };
    });
  const approve = (items: readonly MemeQueueItem[]) =>
    act(
      items.length === 1 ? '已通过，已加入词库' : `已通过 ${items.length} 条`,
      (id) => deps.api.memesApprove(id, payload(items)),
      `approve:${JSON.stringify(payload(items))}`,
    );
  const dismiss = (items: readonly MemeQueueItem[]) =>
    act(
      items.length === 1 ? '已不要' : `已不要 ${items.length} 条`,
      (id) =>
        deps.api.memesDismiss(
          id,
          items.map((item) => item.term),
        ),
      `dismiss:${items.map((item) => item.term).join('|')}`,
    );

  const table = dataTable<MemeQueueItem>({
    columns: [
      {
        key: 'content',
        label: '词与释义',
        render: (item) => contentCell(item),
      },
      {
        key: 'source',
        label: '来源',
        render: (item) => h('span', { class: 'mm-source', text: sourceLabel(item.source) }),
      },
      {
        key: 'date',
        label: '日期',
        sortable: true,
        sortValue: (item) => item.createdAt,
        render: (item) => {
          const cell = h('span', { class: 'mm-date', text: day(item.createdAt) });
          // Part 37c-2 supplies links and a player count (never a player or a message); they show here when present.
          if (item.playerCount !== null)
            cell.append(h('span', { class: 'mm-muted', text: ` · ${count(item.playerCount)} 人说过` }));
          for (const link of item.links.slice(0, 2)) cell.append(h('i', { class: 'mm-muted', text: ` · ${link}` }));
          return cell;
        },
      },
      {
        key: 'actions',
        label: '',
        render: (item) => {
          const yes = h('button', { class: 'admin-primary', text: '通过', attrs: { type: 'button' } });
          const no = h('button', { class: 'admin-secondary', text: '不要', attrs: { type: 'button' } });
          yes.disabled = no.disabled = !deps.canEdit();
          hoverValue(yes, '加入词库并开启');
          hoverValue(no, '丢掉它；以后自动来源不会再推荐这个词');
          yes.addEventListener('click', () => void approve([item]));
          no.addEventListener('click', () => void dismiss([item]));
          return h('span', { class: 'mm-q-actions' }, yes, no);
        },
      },
    ],
    rowKey: (item) => item.term,
    emptyText: '没有待审的词。',
    caption: '待审',
    bulkActions: [
      { label: '通过所选', run: (rows) => approve(rows) },
      { label: '不要所选', run: (rows) => dismiss(rows) },
    ],
  });
  const root = h('div', { class: 'mm-queue' }, error, table.root);

  return {
    root,
    pending: () => view.pending,
    async load() {
      const mine = ++ticket;
      try {
        const got = await deps.api.memesQueue();
        if (deps.disposed() || mine !== ticket) return null;
        view = got;
        const live = new Set(got.items.map((item) => item.term));
        for (const key of [...edits.keys()]) if (!live.has(key)) edits.delete(key);
        error.hidden = true;
        table.clearSelection();
        table.setRows(got.items);
        return got;
      } catch (caught) {
        if (deps.disposed() || mine !== ticket) return null;
        error.replaceChildren(errorLine(codeOf(caught)));
        error.hidden = false;
        return null;
      }
    },
    clear() {
      ticket++;
      edits.clear();
      ids.clear();
      view = { items: [], pending: 0 };
    },
  };
}

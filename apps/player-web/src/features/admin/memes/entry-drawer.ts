import { MEME_MEANING_MAX, MEME_TERM_MAX, type MemeEntryView } from '../../../../../../packages/contracts/web-memes.ts';
import { h, length } from '../../cocreation/h.ts';
import { drawer } from '../ui/drawer.ts';
import { errorLine } from '../ui/error-line.ts';
import { hoverValue } from '../ui/hover-value.ts';
import { categorySelect, codeOf, detailOf, requestIds, sourceLabel, type MemesDeps } from './memes-shared.ts';

type Hooks = {
  /** After a save: the page reloads its list (and shows the toast). */
  onSaved: (message: string, key: string) => Promise<void> | void;
  /** A refused duplicate: take the owner to the entry that is already there (`deleted` = it is in 已删除). */
  onShowExisting: (key: string, deleted: boolean) => void;
};

/**
 * 添加 / 编辑 an entry, in the page's drawer. Add: term (≤ 40), meaning (≤ 200), category (the five), year (optional); the entry starts ON.
 * Edit: the meaning and the category of ANY entry; a shipped entry keeps its shipped text behind the edit (恢复原文 puts it back).
 * A duplicate term is refused with a link to the entry that is already there. No explanation lines: hover tips only.
 */
export function entryDrawer(parent: HTMLElement, deps: MemesDeps, hooks: Hooks) {
  const panel = drawer(parent, { title: '添加词条' });
  const ids = requestIds(deps.newRequestId);
  let busy = false;

  function open(title: string, build: () => HTMLElement) {
    ids.clear();
    panel.setTitle(title);
    panel.body.replaceChildren(build());
    panel.open();
  }
  const counter = (input: HTMLInputElement | HTMLTextAreaElement, max: number) => {
    const note = h('span', { class: 'mm-count' });
    const update = () => {
      const n = length(input.value);
      note.textContent = `${n} / ${max}`;
      note.classList.toggle('mm-count-over', n > max);
    };
    input.addEventListener('input', update);
    update();
    return note;
  };
  const field = (label: string, control: HTMLElement, note?: HTMLElement) =>
    h('label', { class: 'mm-field' }, h('span', { class: 'mm-field-label', text: label }), control, note);

  function form(options: {
    entry: MemeEntryView | null;
    submit: (values: { term: string; meaning: string; category: string; year: number | null }) => Promise<void>;
  }) {
    const entry = options.entry;
    const term = h('input', { attrs: { type: 'text', 'aria-label': '词', autocomplete: 'off' } });
    if (entry) {
      term.value = entry.term;
      term.readOnly = true;
    }
    const meaning = h('textarea', { attrs: { rows: '4', 'aria-label': '释义' } });
    meaning.value = entry?.meaning ?? '';
    const category = categorySelect(entry?.category ?? null, '分类');
    const year = h('input', { attrs: { type: 'text', inputmode: 'numeric', 'aria-label': '年份', maxlength: '4' } });
    const error = h('div', { class: 'mm-error', attrs: { role: 'alert' }, hidden: true });
    const save = h('button', { class: 'admin-primary', text: '保存', attrs: { type: 'button' } });
    const cancel = h('button', { class: 'admin-secondary', text: '取消', attrs: { type: 'button' } });
    cancel.addEventListener('click', () => panel.close());
    hoverValue(meaning, '一句话讲清它是什么意思、什么时候说');
    if (!entry) hoverValue(term, '最多 40 个字，不能和词库里已有的词重复');
    hoverValue(category, '决定它在词库里归哪一类');
    const rows: (Node | null)[] = [
      field('词', term, entry ? undefined : counter(term, MEME_TERM_MAX)),
      field('释义', meaning, counter(meaning, MEME_MEANING_MAX)),
      field('分类', category),
      entry ? null : field('年份（可不填）', year),
      entry ? h('p', { class: 'mm-field-meta', text: `来源：${sourceLabel(entry.source)}` }) : null,
    ];
    const fail = (caught: unknown) => {
      if (deps.disposed()) return;
      error.replaceChildren(errorLine(codeOf(caught)));
      if (codeOf(caught) === 'MEME_DUPLICATE') {
        const detail = detailOf(caught);
        const link = h('button', { class: 'mm-link', text: '查看已有的这一条', attrs: { type: 'button' } });
        link.addEventListener('click', () => {
          panel.close();
          hooks.onShowExisting(
            typeof detail.key === 'string' ? detail.key : term.value.trim(),
            detail.deleted === true,
          );
        });
        error.append(link);
      }
      error.hidden = false;
    };
    const actions = h('div', { class: 'mm-form-actions' }, cancel, save);
    if (entry?.original) {
      const original = h('button', { class: 'admin-secondary', text: '恢复原文', attrs: { type: 'button' } });
      hoverValue(original, `改回自带的释义和分类：${entry.original.category}`);
      original.addEventListener('click', async () => {
        if (busy) return;
        busy = true;
        try {
          const signature = `restore:${entry.key}`;
          await deps.api.memesRestoreOriginal(ids.of(signature), [entry.key]);
          ids.done(signature);
          panel.close();
          await hooks.onSaved('已恢复原文', entry.key);
        } catch (caught) {
          fail(caught);
        } finally {
          busy = false;
        }
      });
      actions.prepend(original);
    }
    save.addEventListener('click', async () => {
      if (busy || !deps.canEdit()) return;
      busy = true;
      error.hidden = true;
      try {
        const y = year.value.trim();
        await options.submit({
          term: term.value.trim(),
          meaning: meaning.value.trim(),
          category: category.value,
          year: y === '' || !/^\d{4}$/u.test(y) ? null : Number(y),
        });
      } catch (caught) {
        fail(caught);
      } finally {
        busy = false;
      }
    });
    queueMicrotask(() => (entry ? meaning : term).focus());
    return h('div', { class: 'mm-form' }, ...rows, error, actions);
  }

  return {
    openAdd() {
      if (!deps.canEdit()) return;
      open('添加词条', () =>
        form({
          entry: null,
          submit: async (values) => {
            const signature = `add:${values.term}:${values.meaning}:${values.category}:${values.year}`;
            await deps.api.memesAdd(ids.of(signature), values);
            ids.done(signature);
            panel.close();
            await hooks.onSaved('已添加', values.term);
          },
        }),
      );
    },
    openEdit(entry: MemeEntryView) {
      if (!deps.canEdit()) return;
      open(`编辑「${entry.term}」`, () =>
        form({
          entry,
          submit: async (values) => {
            const signature = `edit:${entry.key}:${values.meaning}:${values.category}`;
            await deps.api.memesEdit(ids.of(signature), {
              key: entry.key,
              meaning: values.meaning,
              category: values.category,
            });
            ids.done(signature);
            panel.close();
            await hooks.onSaved('已保存', entry.key);
          },
        }),
      );
    },
    close: () => panel.close(),
    dispose() {
      panel.dispose();
    },
    isOpen: () => panel.isOpen(),
  };
}

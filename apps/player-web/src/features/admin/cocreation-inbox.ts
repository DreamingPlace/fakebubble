/**
 * 共创收件箱: administrators read the ideas players leave for the official characters, pick what is useful, and add
 * it to the character's draft with the existing draft save. Nothing here publishes anything, calls a provider or
 * reviews text; every player string is rendered with textContent only.
 */
import {
  COCREATION_FIELD_LABELS,
  COCREATION_LIMITS,
  COCREATION_TARGET_FIELDS,
  cocreationCard,
  cocreationPrompt,
  type CocreationTargetField,
} from '../../../../../packages/contracts/cocreation-cards.ts';
import {
  ADOPT_ERROR_TEXT,
  ADOPT_FIELDS,
  CocreationAdoptError,
  adoptIntoTemplate,
  suggestAdoptDraft,
  type AdoptDraft,
  type AdoptField,
} from '../../../../../packages/contracts/cocreation-adopt.ts';
import type {
  InboxAnswer,
  InboxCursor,
  InboxDetail,
  InboxFilter,
  InboxItem,
  InboxStatus,
  CocreationAdminClient,
} from '../../services/cocreation-admin-api.ts';
import type { CharacterAdminClient } from '../../services/character-admin-api.ts';
import { characterAdminError } from './character-workbench.ts';
import { h } from '../cocreation/h.ts';

type Deps = {
  api: Pick<CocreationAdminClient, 'list' | 'detail' | 'setStatus' | 'star' | 'note' | 'adopt'>;
  characters: Pick<CharacterAdminClient, 'list' | 'detail' | 'save'>;
  /** cocreation.manage (or the owner): status, star, note and adopting. Reading needs only cocreation.read. */
  canManage: () => boolean;
  run: (work: () => Promise<void>) => Promise<void>;
  status: (text: string) => void;
  disposed: () => boolean;
  /** The unread badge in the character workbench follows every change of status. */
  onChanged?: () => void;
  copy?: (text: string) => Promise<void>;
};

const STATUS_LABEL: Record<InboxStatus, string> = { new: '新', processed: '已处理', archived: '已归档' };
const when = (ms: number) => new Date(ms).toLocaleString('zh-CN', { hour12: false });
const preview = (text: string) => ([...text].length > 48 ? `${[...text].slice(0, 48).join('')}…` : text);
const isField = (node: unknown) => {
  const tag = (node as { tagName?: string } | null)?.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    (node as { isContentEditable?: boolean })?.isContentEditable === true
  );
};

export function cocreationInbox(root: HTMLElement, deps: Deps) {
  let filter: InboxFilter = { characterId: null, status: null, starred: false, query: '' };
  let items: InboxItem[] = [];
  let next: InboxCursor | null = null;
  let names: Record<string, string> = {};
  let active = -1;
  let detail: InboxDetail | null = null;
  let loadingDetail: string | null = null;
  const selected = new Set<string>();
  let adopting: { ordinal: number } | null = null;
  let adoptError = '';
  let gone = false;
  let activated = false;

  const nameOf = (id: string) => names[id] ?? id;

  // ---- static frame ---------------------------------------------------------------------------------------------
  const characterSelect = h('select', { attrs: { id: 'cc-filter-character', 'aria-label': '角色' } });
  const statusSelect = h('select', { attrs: { id: 'cc-filter-status', 'aria-label': '状态' } });
  for (const [value, label] of [
    ['', '全部状态'],
    ['new', '新'],
    ['processed', '已处理'],
    ['archived', '已归档'],
  ] as const) {
    const option = h('option', { text: label, attrs: { value } });
    statusSelect.append(option);
  }
  const starred = h('input', { attrs: { type: 'checkbox', id: 'cc-filter-starred' } });
  const query = h('input', {
    attrs: {
      type: 'search',
      id: 'cc-filter-query',
      maxlength: '100',
      placeholder: '搜索玩家写的内容或备注',
      'aria-label': '搜索',
    },
  });
  const refresh = h('button', { text: '刷新', attrs: { type: 'button', class: 'cc-refresh' } });
  const selectAll = h('button', { text: '全选本页', attrs: { type: 'button' }, class: 'cc-select-all' });
  const archiveSelected = h('button', { text: '归档所选', attrs: { type: 'button' }, class: 'cc-archive-selected' });
  const bulk = h('div', { class: 'cc-bulk' }, selectAll, archiveSelected);
  const list = h('ul', { class: 'cc-list', attrs: { 'aria-label': '共创列表' } });
  const more = h('button', { text: '更多', attrs: { type: 'button' }, class: 'cc-more', hidden: true });
  const empty = h('p', { class: 'cc-empty', text: '还没有玩家的想法。' });
  const pane = h('section', { class: 'cc-detail', attrs: { 'aria-live': 'polite' } });
  root.replaceChildren(
    h('h2', { text: '共创收件箱' }),
    h('p', {
      text: '玩家为官方角色写下的想法。这里只读、摘取和改写：自动不会进入角色，“加入草稿”也只写草稿，仍须预览并发布。快捷键：j / k 切换，e 归档，s 星标。',
    }),
    h(
      'div',
      { class: 'cc-toolbar' },
      h('label', { text: '角色' }, characterSelect),
      h('label', { text: '状态' }, statusSelect),
      h('label', { class: 'cc-star-filter' }, starred, '只看星标'),
      h('label', { text: '搜索' }, query),
      refresh,
    ),
    bulk,
    empty,
    list,
    more,
    pane,
  );

  // ---- list -----------------------------------------------------------------------------------------------------
  const renderFilters = () => {
    characterSelect.replaceChildren(
      h('option', { text: '全部角色', attrs: { value: '' } }),
      ...Object.entries(names).map(([id, name]) => h('option', { text: name, attrs: { value: id } })),
    );
    characterSelect.value = filter.characterId ?? '';
  };
  const renderList = () => {
    empty.hidden = items.length > 0;
    empty.textContent =
      filter.query || filter.status || filter.starred || filter.characterId
        ? '没有符合条件的想法。'
        : '还没有玩家的想法。';
    more.hidden = next === null;
    bulk.hidden = !deps.canManage() || items.length === 0;
    archiveSelected.disabled = selected.size === 0;
    archiveSelected.textContent = selected.size ? `归档所选（${selected.size}）` : '归档所选';
    list.replaceChildren(
      ...items.map((item, index) => {
        const check = h('input', {
          attrs: { type: 'checkbox', 'aria-label': `选择 ${item.pseudonym} 的想法` },
        });
        check.checked = selected.has(item.id);
        check.hidden = !deps.canManage();
        check.addEventListener('change', () => {
          if (check.checked) selected.add(item.id);
          else selected.delete(item.id);
          renderList();
        });
        const open = h(
          'button',
          { class: 'cc-row-open', attrs: { type: 'button', 'aria-current': String(index === active) } },
          h(
            'span',
            { class: 'cc-row-head' },
            h('strong', { text: nameOf(item.characterId) }),
            h('span', { class: 'cc-pseudonym', text: item.pseudonym }),
            h('time', { text: when(item.createdAt) }),
            h('span', { text: `${item.answerCount} 条` }),
          ),
          h('span', { class: 'cc-first', text: preview(item.firstLine) }),
          h(
            'span',
            { class: 'cc-chips' },
            h('span', { class: `cc-chip cc-chip-${item.status}`, text: STATUS_LABEL[item.status] }),
            item.starred ? h('span', { class: 'cc-chip cc-chip-star', text: '★' }) : null,
            item.hasNote ? h('span', { class: 'cc-chip', text: '有备注' }) : null,
            item.adoptedCount > 0
              ? h('span', { class: 'cc-chip', text: `已采用 ${item.adoptedCount}/${item.answerCount}` })
              : null,
          ),
        );
        open.addEventListener('click', () => select(index));
        const row = h(
          'li',
          { class: `cc-row${index === active ? ' is-active' : ''}`, attrs: { 'data-id': item.id } },
          check,
          open,
        );
        return row;
      }),
    );
  };

  const load = async (cursor: InboxCursor | null = null) => {
    try {
      names = Object.fromEntries((await deps.characters.list()).characters.map((c) => [c.characterId, c.displayName]));
    } catch {
      /* A reader without character access sees ids instead of names. */
    }
    const result = await deps.api.list(filter, cursor);
    if (gone || deps.disposed()) return;
    items = cursor ? [...items, ...result.items] : result.items;
    next = result.next;
    if (!cursor) {
      selected.clear();
      active = items.length ? Math.min(Math.max(active, 0), items.length - 1) : -1;
    }
    renderFilters();
    renderList();
    if (active >= 0) await openDetail(items[active]!.id);
    else {
      detail = null;
      renderDetail();
    }
  };

  const openDetail = async (id: string) => {
    if (detail?.id === id && !adopting) return;
    loadingDetail = id;
    const result = await deps.api.detail(id);
    if (gone || deps.disposed() || loadingDetail !== id) return;
    detail = result;
    adopting = null;
    adoptError = '';
    renderDetail();
  };
  /** j / k and clicks move immediately; the detail follows, even when another request was busy meanwhile. */
  let pumping = false;
  const pump = async () => {
    if (pumping) return;
    pumping = true;
    try {
      while (!gone && !deps.disposed()) {
        const wanted = items[active];
        if (!wanted || detail?.id === wanted.id) break;
        let ran = false;
        await deps.run(async () => {
          ran = true;
          await openDetail(wanted.id);
        });
        // Busy: try again shortly. Ran but failed (the page shows why): stop instead of asking again and again.
        if (!ran) await new Promise((resolve) => setTimeout(resolve, 30));
        else if (items[active]?.id === wanted.id) break;
      }
    } finally {
      pumping = false;
    }
  };
  const select = (index: number) => {
    if (index < 0 || index >= items.length) return;
    active = index;
    renderList();
    void pump();
  };

  // ---- detail ---------------------------------------------------------------------------------------------------
  const patchItem = (id: string, change: Partial<InboxItem>) => {
    items = items.map((item) => (item.id === id ? { ...item, ...change } : item));
  };
  const changed = () => deps.onChanged?.();

  const setStatus = (ids: string[], status: InboxStatus) =>
    deps.run(async () => {
      await deps.api.setStatus(ids, status);
      for (const id of ids) patchItem(id, { status });
      if (detail && ids.includes(detail.id)) detail = { ...detail, status };
      for (const id of ids) selected.delete(id);
      // A filtered list drops what no longer matches; the cursor moves to a neighbour.
      if (filter.status && filter.status !== status) {
        const current = items[active]?.id;
        items = items.filter((item) => !ids.includes(item.id));
        active = items.length ? Math.max(0, Math.min(active, items.length - 1)) : -1;
        if (current && ids.includes(current)) detail = null;
      }
      renderList();
      renderDetail();
      if (active >= 0 && detail?.id !== items[active]?.id) void pump();
      changed();
      deps.status(
        ids.length > 1 ? `已把 ${ids.length} 条标为${STATUS_LABEL[status]}。` : `已标为${STATUS_LABEL[status]}。`,
      );
    });
  const toggleStar = (current: InboxDetail) =>
    deps.run(async () => {
      await deps.api.star(current.id, !current.starred);
      detail = { ...current, starred: !current.starred };
      patchItem(current.id, { starred: !current.starred });
      renderList();
      renderDetail();
    });

  const copyText = (text: string) =>
    deps.run(async () => {
      try {
        await (deps.copy ?? ((value: string) => navigator.clipboard.writeText(value)))(text);
        deps.status('已复制。');
      } catch {
        deps.status('复制没有成功，请手动选取文字。');
      }
    });

  const plain = (answer: InboxAnswer, character: string) =>
    answer.kind === 'text'
      ? answer.text
      : [`玩家：${answer.player}`, ...answer.replies.map((reply) => `${character}：${reply}`)].join('\n');

  const bubbles = (answer: InboxAnswer, character: string) => {
    if (answer.kind === 'text') return h('p', { class: 'cc-answer-text', text: answer.text });
    return h(
      'div',
      { class: 'cc-chat' },
      h('div', { class: 'message-row outgoing' }, h('p', { class: 'text-bubble', text: answer.player })),
      ...answer.replies.map((reply) =>
        h(
          'div',
          { class: 'message-row incoming' },
          h('span', {
            class: 'avatar message-avatar',
            text: [...character][0] ?? '',
            attrs: { 'aria-hidden': 'true' },
          }),
          h('p', { class: 'text-bubble incoming-text', text: reply }),
        ),
      ),
    );
  };

  const adoptEditor = (current: InboxDetail, answer: InboxAnswer) => {
    const character = nameOf(current.characterId);
    const suggested: AdoptField = answer.targetField === 'free' ? 'persona' : (answer.targetField as AdoptField);
    const source = answer.kind === 'text' ? { text: answer.text } : { player: answer.player, replies: answer.replies };
    const form = h('form', { class: 'cc-adopt', attrs: { 'aria-label': '加入草稿' } });
    const field = h('select', { attrs: { 'aria-label': '加入到哪个字段' } });
    for (const value of ADOPT_FIELDS)
      field.append(h('option', { text: COCREATION_FIELD_LABELS[value], attrs: { value } }));
    field.value = suggested;
    const text = h('textarea', { attrs: { rows: '4', 'aria-label': '要加入的内容' } });
    const situation = h('input', { attrs: { type: 'text', 'aria-label': '情境', maxlength: '100' } });
    const player = h('input', {
      attrs: { type: 'text', 'aria-label': '玩家说', maxlength: String(COCREATION_LIMITS.dialoguePlayer) },
    });
    const replyOne = h('input', {
      attrs: { type: 'text', 'aria-label': `${character}回复一`, maxlength: String(COCREATION_LIMITS.dialogueReply) },
    });
    const replyTwo = h('input', {
      attrs: {
        type: 'text',
        'aria-label': `${character}回复二（可选）`,
        maxlength: String(COCREATION_LIMITS.dialogueReply),
      },
    });
    const example = h(
      'div',
      { class: 'cc-example' },
      h('label', { text: '情境' }, situation),
      h('label', { text: '玩家说' }, player),
      h('label', { text: `${character}回复` }, replyOne),
      h('label', { text: '再回一句（可选）' }, replyTwo),
    );
    const error = h('p', { class: 'cc-adopt-error', attrs: { role: 'alert' }, hidden: true });
    const save = h('button', { text: '保存到草稿', attrs: { type: 'submit' }, class: 'cc-adopt-save' });
    const cancel = h('button', { text: '取消', attrs: { type: 'button' }, class: 'cc-adopt-cancel' });
    const where = h('p', { class: 'cc-adopt-help' });

    const fill = (value: AdoptField) => {
      const draft = suggestAdoptDraft(value, source, character);
      if (draft.field === 'dialogueExamples') {
        situation.value = draft.situation;
        player.value = draft.player;
        replyOne.value = draft.reply[0] ?? '';
        replyTwo.value = draft.reply[1] ?? '';
      } else text.value = draft.text;
    };
    const layout = () => {
      const isExample = field.value === 'dialogueExamples';
      example.hidden = !isExample;
      text.hidden = isExample;
      where.textContent =
        field.value === 'persona'
          ? '会作为新的一段追加到人设文字末尾。'
          : isExample
            ? '会作为一条 {情境、玩家说、角色回复} 追加到对话示例。'
            : '会追加到该字段（文字接在后面，列表增加一项）。';
    };
    fill(suggested);
    layout();
    field.addEventListener('change', () => {
      fill(field.value as AdoptField);
      layout();
    });
    const draftInput = (): AdoptDraft =>
      field.value === 'dialogueExamples'
        ? {
            field: 'dialogueExamples',
            situation: situation.value,
            player: player.value,
            reply: [replyOne.value, replyTwo.value].filter((reply) => reply.trim() !== ''),
          }
        : { field: field.value as Exclude<AdoptField, 'dialogueExamples'>, text: text.value };
    const fail = (message: string) => {
      adoptError = message;
      error.textContent = message;
      error.hidden = message === '';
    };
    error.textContent = adoptError;
    error.hidden = adoptError === '';

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void deps.run(async () => {
        fail('');
        const input = draftInput();
        try {
          const target = await deps.characters.detail(current.characterId);
          const base = target.draft?.profile ?? target.published?.profile;
          if (!base) {
            fail('这个角色还没有可编辑的版本，请先在角色资料中创建草稿。');
            return;
          }
          const profile = structuredClone(base);
          // No draft yet: start one from the published version, one version ahead, exactly as the workbench does.
          if (!target.draft) profile.template.version = target.published!.version + 1;
          profile.template = adoptIntoTemplate(profile.template, input);
          const saved = await deps.characters.save(current.characterId, target.draft?.revision ?? null, profile);
          try {
            await deps.api.adopt(current.id, answer.ordinal);
          } catch {
            fail(`草稿已保存（修订 ${saved.revision}），但没能把这条标为“已采用”。请勿重复加入；可稍后刷新核对。`);
            return;
          }
          const stamp = Date.now();
          detail = {
            ...current,
            status: 'processed',
            answers: current.answers.map((entry) =>
              entry.ordinal === answer.ordinal ? { ...entry, adoptedAt: stamp } : entry,
            ),
          };
          patchItem(current.id, {
            status: 'processed',
            adoptedCount: detail.answers.filter((a) => a.adoptedAt !== null).length,
          });
          adopting = null;
          adoptError = '';
          renderList();
          renderDetail();
          changed();
          deps.status(`已加入草稿（修订 ${saved.revision}）。尚未发布：请在“角色资料”里预览，确认后再发布。`);
        } catch (caught) {
          if (caught instanceof CocreationAdoptError) fail(ADOPT_ERROR_TEXT[caught.code] ?? '内容不符合要求。');
          else fail(characterAdminError(caught) ?? '保存草稿没有成功，请核对后重试；本次没有标记为已采用。');
        }
      });
    });
    cancel.addEventListener('click', () => {
      adopting = null;
      adoptError = '';
      renderDetail();
    });
    form.append(
      h('label', { text: '加入到' }, field),
      where,
      text,
      example,
      error,
      h('div', { class: 'cc-adopt-actions' }, cancel, save),
    );
    return form;
  };

  const renderDetail = () => {
    if (!detail) {
      pane.replaceChildren();
      pane.hidden = true;
      return;
    }
    pane.hidden = false;
    const current = detail;
    const character = nameOf(current.characterId);
    const manage = deps.canManage();
    const star = h('button', {
      class: 'cc-star',
      text: current.starred ? '★ 已星标' : '☆ 星标',
      attrs: { type: 'button', 'aria-pressed': String(current.starred) },
    });
    star.disabled = !manage;
    star.addEventListener('click', () => void toggleStar(current));
    const statusButtons = (['processed', 'archived', 'new'] as const)
      .filter((status) => status !== current.status)
      .map((status) => {
        const button = h('button', {
          class: `cc-set-${status}`,
          text: status === 'processed' ? '标为已处理' : status === 'archived' ? '归档' : '恢复为新',
          attrs: { type: 'button' },
        });
        button.disabled = !manage;
        button.addEventListener('click', () => void setStatus([current.id], status));
        return button;
      });
    const note = h('textarea', {
      class: 'cc-note',
      attrs: { rows: '3', maxlength: String(COCREATION_LIMITS.note), 'aria-label': '管理员备注（玩家看不到）' },
    });
    note.value = current.adminNote ?? '';
    note.disabled = !manage;
    const saveNote = h('button', { text: '保存备注', attrs: { type: 'button' }, class: 'cc-save-note' });
    saveNote.disabled = !manage;
    saveNote.addEventListener(
      'click',
      () =>
        void deps.run(async () => {
          const saved = await deps.api.note(current.id, note.value);
          detail = { ...current, adminNote: saved };
          patchItem(current.id, { hasNote: saved !== null });
          renderList();
          deps.status(saved === null ? '备注已清空。' : '备注已保存。');
        }),
    );

    const groups = COCREATION_TARGET_FIELDS.map((field) => ({
      field,
      answers: current.answers.filter((answer) => answer.targetField === field),
    })).filter((group) => group.answers.length > 0);

    pane.replaceChildren(
      h(
        'header',
        { class: 'cc-detail-head' },
        h('h3', { text: `${character} · ${current.pseudonym}` }),
        h('p', {
          text: `${when(current.createdAt)}${current.batch ? ` · 邀请批次：${current.batch}` : ''} · ${STATUS_LABEL[current.status]}${current.processedAt ? `（${when(current.processedAt)}）` : ''}`,
        }),
        h('div', { class: 'cc-detail-actions' }, star, ...statusButtons),
      ),
      ...groups.map((group) =>
        h(
          'section',
          { class: 'cc-group', attrs: { 'data-field': group.field } },
          h('h4', { text: COCREATION_FIELD_LABELS[group.field as CocreationTargetField] }),
          ...group.answers.map((answer) => {
            const card = cocreationCard(answer.cardId);
            const copy = h('button', { text: '复制', attrs: { type: 'button' }, class: 'cc-copy' });
            copy.addEventListener('click', () => void copyText(plain(answer, character)));
            const add = h('button', { text: '加入草稿', attrs: { type: 'button' }, class: 'cc-adopt-open' });
            add.disabled = !manage;
            add.addEventListener('click', () => {
              adopting = { ordinal: answer.ordinal };
              adoptError = '';
              renderDetail();
            });
            return h(
              'article',
              { class: 'cc-answer', attrs: { 'data-ordinal': String(answer.ordinal) } },
              h('p', { class: 'cc-card-prompt', text: card ? cocreationPrompt(card, character) : answer.cardId }),
              bubbles(answer, character),
              h(
                'div',
                { class: 'cc-answer-actions' },
                copy,
                add,
                answer.adoptedAt !== null ? h('span', { class: 'cc-chip cc-chip-adopted', text: '已采用' }) : null,
              ),
              adopting?.ordinal === answer.ordinal ? adoptEditor(current, answer) : null,
            );
          }),
        ),
      ),
      h('div', { class: 'cc-note-box' }, h('label', { text: '管理员备注（玩家看不到）' }, note), saveNote),
    );
  };

  // ---- events ---------------------------------------------------------------------------------------------------
  const reload = () => {
    adopting = null;
    void deps.run(() => load());
  };
  characterSelect.addEventListener('change', () => {
    filter = { ...filter, characterId: characterSelect.value || null };
    reload();
  });
  statusSelect.addEventListener('change', () => {
    filter = { ...filter, status: (statusSelect.value || null) as InboxStatus | null };
    reload();
  });
  starred.addEventListener('change', () => {
    filter = { ...filter, starred: starred.checked };
    reload();
  });
  const search = () => {
    filter = { ...filter, query: query.value };
    reload();
  };
  query.addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key === 'Enter') {
      event.preventDefault();
      search();
    }
  });
  query.addEventListener('change', search);
  refresh.addEventListener('click', reload);
  more.addEventListener('click', () => {
    if (next) void deps.run(() => load(next));
  });
  selectAll.addEventListener('click', () => {
    for (const item of items) selected.add(item.id);
    renderList();
  });
  archiveSelected.addEventListener('click', () => {
    if (selected.size) void setStatus([...selected], 'archived');
  });

  const onKey = (event: Event) => {
    const e = event as KeyboardEvent;
    if (!activated || gone || e.ctrlKey || e.metaKey || e.altKey || isField(e.target)) return;
    if (e.key === 'j') select(Math.min(items.length - 1, active + 1));
    else if (e.key === 'k') select(Math.max(0, active - 1));
    else if (e.key === 'e' && detail && deps.canManage() && detail.status !== 'archived')
      void setStatus([detail.id], 'archived');
    else if (e.key === 's' && detail && deps.canManage()) void toggleStar(detail);
    else return;
    e.preventDefault?.();
  };
  // Held on to, so disposing still works after the page (or a test) has replaced the global document.
  const doc = document;
  doc.addEventListener('keydown', onKey);

  return {
    load,
    /** Keyboard shortcuts only listen while the inbox is the visible page. */
    activate: () => {
      activated = true;
    },
    deactivate: () => {
      activated = false;
    },
    clear: () => {
      items = [];
      detail = null;
      next = null;
      active = -1;
      selected.clear();
      adopting = null;
      renderList();
      renderDetail();
    },
    dispose: () => {
      gone = true;
      doc.removeEventListener('keydown', onKey);
    },
    /** Current selection, for tests and the page's busy state. */
    snapshot: () => ({ items, active, detail }),
  };
}

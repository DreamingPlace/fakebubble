/**
 * 共创收件箱: administrators read the ideas players leave for the official characters, pick what is useful, and add
 * it to the character's draft with the existing draft save. Nothing here publishes anything, calls a provider or
 * reviews text; every player string is rendered with textContent only.
 */
import { dateTimeText } from './system-format.ts';
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
import { exactCount, hoverValue } from './ui/hover-value.ts';
import { fillStatus, pageHead } from './ui/page-head.ts';
import { dot } from './cast/cast-ui.ts';
import { rosterColours } from './ui/character-colour.ts';

type Deps = {
  api: Pick<CocreationAdminClient, 'list' | 'detail' | 'setStatus' | 'star' | 'note' | 'adopt'> &
    Partial<Pick<CocreationAdminClient, 'unadopt' | 'addToCastStory'>>;
  /** Part 24c: the revision of the cast draft the administrator is looking at (cast.read); without it 加入关系与故事 is not shown. */
  castRevision?: () => Promise<number>;
  /** cast.edit (or the owner): without it 加入关系与故事 is disabled. Default: allowed. */
  canEditCast?: () => boolean;
  characters: Pick<CharacterAdminClient, 'list' | 'detail' | 'save'>;
  /** cocreation.manage (or the owner): status, star, note and adopting. Reading needs only cocreation.read. */
  canManage: () => boolean;
  /** characters.edit for this role (or the owner): without it 加入草稿 is not shown at all. Default: shown. */
  canEditCharacter?: (characterId: string) => boolean;
  run: (work: () => Promise<void>) => Promise<void>;
  status: (text: string) => void;
  disposed: () => boolean;
  /** The unread badge in the character workbench follows every change of status. */
  onChanged?: () => void;
  copy?: (text: string) => Promise<void>;
  /** The points a player gets when a note is adopted (积分发放 → 共创积分); shown as 采用 +N when known. */
  adoptPoints?: () => Promise<number | null>;
};

type Template = { persona?: string; authorCanon?: { settings?: Record<string, unknown> } } & Record<string, unknown>;
const STATUS_LABEL: Record<InboxStatus, string> = { new: '新', processed: '已处理', archived: '已归档' };
const when = (ms: number) => dateTimeText(ms);
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
  let loadingMore = false;
  /** Which answer's field the right-hand pane shows, and the adoption just saved (its link to 角色工作台). */
  let viewing: number | null = null;
  let saved: { ordinal: number; revision: number } | null = null;
  const drafts = new Map<string, Promise<Template | null>>();
  let adoptPoints: number | null | undefined;

  const nameOf = (id: string) => names[id] ?? id;
  /** The dot of a character: the same colour as in 角色工作台 and 关系与故事. */
  const colourOf = () => rosterColours(Object.keys(names));

  // ---- static frame ---------------------------------------------------------------------------------------------
  // Filters are chips, not dropdowns: one pressed chip per group (角色, 状态), a 只看星标 toggle, and the search field.
  const characterChips = h('div', { class: 'cc-chip-row', attrs: { role: 'group', 'aria-label': '角色' } });
  const statusChips = h('div', { class: 'cc-chip-row', attrs: { role: 'group', 'aria-label': '状态' } });
  const starChip = h('button', {
    class: 'cc-filter-chip cc-star-filter',
    text: '★ 只看星标',
    attrs: { type: 'button', 'aria-pressed': 'false' },
  });
  const query = h('input', {
    attrs: {
      type: 'search',
      id: 'cc-filter-query',
      maxlength: '100',
      placeholder: '搜索玩家写的内容或备注',
      'aria-label': '搜索',
    },
  });
  // The bulk bar (Part 24b-4): shown while rows are ticked, every action written out.
  // Bulk select lives in the title row (Inbox3): while cards are ticked it replaces the counts.
  const bulkCount = h('b', { class: 'cc-bulk-count' });
  const processSelected = h('button', { class: 'cc-process-selected', attrs: { type: 'button' } });
  const archiveSelected = h('button', {
    text: '归档所选',
    attrs: { type: 'button' },
    class: 'cc-archive-selected',
    hidden: true,
  });
  const clearSelected = h('button', { class: 'cc-clear-selected', text: '取消选择', attrs: { type: 'button' } });
  const bulk = h(
    'div',
    { class: 'cc-bulk', attrs: { role: 'group', 'aria-label': '批量处理' }, hidden: true },
    bulkCount,
    processSelected,
    archiveSelected,
    clearSelected,
  );
  const counts = h('span', { class: 'head-status cc-counts' });
  // Cards in a fixed grid, three to a row; the detail of the open card is a full-width row under ITS row.
  const list = h('ul', { class: 'cc-list', attrs: { 'aria-label': '共创列表' } });
  const empty = h('p', { class: 'cc-empty', text: '还没有玩家的想法。' });
  const pane = h('section', { class: 'cc-detail', attrs: { 'aria-live': 'polite' } });
  const listColumn = h(
    'div',
    { class: 'cc-list-column' },
    h('div', { class: 'cc-toolbar' }, characterChips, h('div', { class: 'cc-chip-row' }, statusChips, starChip, query)),
    empty,
    list,
  );
  root.replaceChildren(pageHead('共创收件箱', counts, bulk), h('div', { class: 'cc-layout' }, listColumn));

  // ---- list -----------------------------------------------------------------------------------------------------
  const chip = (label: string, on: boolean, pick: () => void, count?: number, lead?: Node) => {
    const node = h('button', {
      class: 'cc-filter-chip',
      attrs: { type: 'button', 'aria-pressed': String(on) },
    });
    if (lead) node.append(lead);
    node.append(count ? `${label} ${count}` : label);
    node.addEventListener('click', pick);
    return node;
  };
  /** The notes still new, per character: the number after a character's name (of what is loaded). */
  const newPer = () => {
    const found = new Map<string, number>();
    for (const item of items) if (item.status === 'new') found.set(item.characterId, (found.get(item.characterId) ?? 0) + 1);
    return found;
  };
  const renderFilters = () => {
    const fresh = newPer();
    characterChips.replaceChildren(
      chip('全部角色', filter.characterId === null, () => pickFilter({ characterId: null })),
      ...Object.entries(names).map(([id, name]) =>
        chip(name, filter.characterId === id, () => pickFilter({ characterId: id }), fresh.get(id), dot(colourOf()(id), 8)),
      ),
    );
    statusChips.replaceChildren(
      chip('全部', filter.status === null, () => pickFilter({ status: null })),
      ...(['new', 'processed', 'archived'] as const).map((status) =>
        chip(STATUS_LABEL[status], filter.status === status, () => pickFilter({ status })),
      ),
    );
    starChip.setAttribute('aria-pressed', String(filter.starred));
  };
  const ROW = 3;
  const renderList = () => {
    empty.hidden = items.length > 0;
    empty.textContent =
      filter.query || filter.status || filter.starred || filter.characterId
        ? '没有符合条件的想法。'
        : '还没有玩家的想法。';
    const manage = deps.canManage();
    archiveSelected.hidden = !manage || selected.size === 0;
    bulk.hidden = archiveSelected.hidden;
    counts.hidden = !bulk.hidden;
    archiveSelected.textContent = `归档所选（${selected.size}）`;
    processSelected.textContent = `标为已处理（${selected.size}）`;
    bulkCount.textContent = `已选 ${selected.size} 条`;
    fillStatus(
      counts,
      h('span', {}, '新 ', h('b', { class: 'is-mono', text: String(items.filter((i) => i.status === 'new').length) })),
      h('span', {}, '星标 ', h('b', { class: 'is-mono', text: String(items.filter((i) => i.starred).length) })),
    );
    const colour = colourOf();
    const nodes: HTMLElement[] = [];
    items.forEach((item, index) => {
      const check = h('input', {
        class: 'cc-check',
        attrs: { type: 'checkbox', 'aria-label': `选择 ${item.pseudonym} 的想法` },
      });
      check.checked = selected.has(item.id);
      check.hidden = !manage;
      check.addEventListener('change', () => {
        if (check.checked) selected.add(item.id);
        else selected.delete(item.id);
        renderList();
      });
      const time = h('time', { class: 'cc-when' }, `${when(item.createdAt).slice(5, 16)}`);
      hoverValue(time, when(item.createdAt));
      // One fixed card: who | the text, fading out at the foot | how many, star, state. It never grows.
      const open = h(
        'button',
        { class: 'cc-row-open', attrs: { type: 'button', 'aria-current': String(index === active), 'aria-expanded': String(index === active) } },
        h(
          'span',
          { class: 'cc-who' },
          h('span', { class: 'cc-name' }, dot(colour(item.characterId), 8), h('strong', { text: whoOf(item) })),
          h('span', { class: 'cc-pseudonym', text: item.pseudonym }),
          time,
        ),
        h('span', { class: 'cc-text' }, h('span', { class: 'cc-first', text: item.firstLine })),
        h(
          'span',
          { class: 'cc-chips' },
          item.kind === 'memo' ? h('span', { class: 'cc-chip cc-chip-memo', text: '留言条' }) : null,
          item.kind === 'pair' ? h('span', { class: 'cc-chip cc-chip-pair', text: '关系与故事' }) : null,
          h('span', { class: 'cc-count', text: `${item.answerCount} 条` }),
          item.adoptedCount > 0 ? h('span', { class: 'cc-chip', text: `已采用 ${item.adoptedCount}/${item.answerCount}` }) : null,
          h('span', { class: 'cc-spacer' }),
          item.starred ? h('span', { class: 'cc-chip cc-chip-star', text: '★', attrs: { role: 'img', 'aria-label': '已星标' } }) : null,
          h('span', { class: `cc-chip cc-state cc-chip-${item.status}`, text: STATUS_LABEL[item.status] }),
        ),
      );
      open.addEventListener('click', () => {
        // The open card closes on a second click; any other card opens its own detail under its row.
        if (index === active) {
          active = -1;
          renderList();
          renderDetail();
        } else select(index);
      });
      nodes.push(
        h(
          'li',
          {
            class: `cc-row${index === active ? ' is-active' : ''}${selected.has(item.id) ? ' is-selected' : ''}`,
            attrs: { 'data-id': item.id },
          },
          check,
          open,
        ),
      );
      // The detail opens directly under the row of the open card, over the full width.
      const endsRow = index % ROW === ROW - 1 || index === items.length - 1;
      if (endsRow && active >= 0 && Math.floor(active / ROW) === Math.floor(index / ROW))
        nodes.push(h('li', { class: 'cc-detail-row' }, pane));
    });
    list.replaceChildren(...nodes);
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
    viewing = null;
    saved = null;
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

  const adoptEditor = (current: InboxDetail, answer: InboxAnswer, onField: (field: AdoptField) => void) => {
    const character = nameOf(current.characterId);
    const suggested: AdoptField = answer.targetField === 'free' ? 'persona' : (answer.targetField as AdoptField);
    const source = answer.kind === 'text' ? { text: answer.text } : { player: answer.player, replies: answer.replies };
    const form = h('form', { class: 'cc-adopt', attrs: { 'aria-label': '加入草稿' } });
    // The new text is amber: it is not in the draft yet.
    form.dataset.dirty = 'true';
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
    const save = h('button', { text: '保存草稿', attrs: { type: 'submit' }, class: 'cc-adopt-save' });
    const cancel = h('button', { text: '撤回', attrs: { type: 'button' }, class: 'cc-adopt-cancel' });
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
      onField(field.value as AdoptField);
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
          const saved_ = await deps.characters.save(current.characterId, target.draft?.revision ?? null, profile);
          try {
            await deps.api.adopt(current.id, answer.ordinal);
          } catch {
            fail(`草稿已保存（修订 ${saved_.revision}），但没能把这条标为“已采用”。请勿重复加入；可稍后刷新核对。`);
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
          saved = { ordinal: answer.ordinal, revision: saved_.revision };
          drafts.delete(current.characterId);
          renderList();
          renderDetail();
          changed();
          deps.status(`已加入草稿（修订 ${saved_.revision}）。尚未发布：请在“角色资料”里预览，确认后再发布。`);
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

  /** The character's CURRENT draft template (the published one while there is no draft), fetched once per open detail. */
  const templateOf = (characterId: string): Promise<Template | null> => {
    let found = drafts.get(characterId);
    if (!found) {
      found = deps.characters
        .detail(characterId)
        .then((target) => ((target.draft?.profile ?? target.published?.profile)?.template as unknown as Template) ?? null)
        .catch(() => null);
      drafts.set(characterId, found);
    }
    return found;
  };
  /** The value of one field as the draft holds it: text, a list of lines, or dialogue pairs. */
  const fieldValue = (template: Template | null, field: AdoptField): Node => {
    if (!template) return h('p', { class: 'cc-target-empty', text: '读不到这个角色的草稿。' });
    const raw = field === 'persona' ? template.persona : template.authorCanon?.settings?.[field];
    if (raw === undefined || raw === null || raw === '') return h('p', { class: 'cc-target-empty', text: '（还没有内容）' });
    if (typeof raw === 'string') return h('p', { class: 'cc-target-text', text: raw });
    if (Array.isArray(raw) && raw.every((entry) => typeof entry === 'string'))
      return h('ul', { class: 'cc-target-list' }, ...(raw as string[]).map((line) => h('li', { text: line })));
    if (Array.isArray(raw))
      return h(
        'div',
        { class: 'cc-target-pairs' },
        ...raw.map((entry) => {
          const e = entry as { situation?: unknown; player?: unknown; reply?: unknown };
          const replies = Array.isArray(e.reply) ? e.reply : [];
          return h(
            'div',
            { class: 'cc-target-pair' },
            h('span', { class: 'cc-pair-situation', text: String(e.situation ?? '') }),
            h('span', { text: `玩家：${String(e.player ?? '')}` }),
            ...replies.map((reply) => h('span', { text: String(reply) })),
          );
        }),
      );
    return h('p', { class: 'cc-target-text', text: JSON.stringify(raw) });
  };

  /** Right-hand pane: the target field of that character's DRAFT; the amber editor appends the suggestion there. */
  const targetPane = (current: InboxDetail): HTMLElement => {
    const pane_ = h('div', { class: 'cc-target' });
    if (current.kind === 'memo') {
      pane_.hidden = true;
      return pane_;
    }
    const character = nameOf(current.characterId);
    if (current.kind === 'pair') {
      const adopted = current.answers.some((answer) => answer.adoptedAt !== null);
      pane_.append(
        h('div', { class: 'cc-target-head' }, dot(colourOf()(current.characterId), 8), h('b', { text: `${whoOf(current)} · 新故事` }), h('span', { class: 'cc-chip cc-chip-draft', text: '草稿' }), h('span', { class: 'cc-spacer' }), h('span', { class: 'cc-target-where', text: '在关系与故事里发布' })),
        h('p', { class: 'cc-target-text', text: adopted ? '已存成关系与故事的草稿故事。' : '这条会作为新故事存进关系与故事的草稿，参与者是这两位。' }),
      );
      if (adopted) pane_.append(h('a', { class: 'cc-go', text: '去关系与故事发布 →', attrs: { href: '#/cast' } }));
      return pane_;
    }
    const picked = current.answers.find((answer) => answer.ordinal === viewing) ?? current.answers[0];
    if (!picked) return pane_;
    let field: AdoptField = picked.targetField === 'free' ? 'persona' : (picked.targetField as AdoptField);
    const label = h('b', { class: 'cc-target-label' });
    const value = h('div', { class: 'cc-target-value' });
    const paintField = () => {
      label.textContent = `${character} · ${COCREATION_FIELD_LABELS[field]}`;
      value.replaceChildren(h('p', { class: 'cc-target-empty', text: '…' }));
      void templateOf(current.characterId).then((template) => {
        if (!gone && !deps.disposed()) value.replaceChildren(fieldValue(template, field));
      });
    };
    const points = h('span', { class: 'cc-chip cc-chip-points', hidden: true });
    if (deps.adoptPoints) {
      const show = (n: number | null) => {
        if (n === null) return;
        points.textContent = `采用 +${n}`;
        points.hidden = false;
        hoverValue(points, '采用后玩家得到的积分，在积分发放里改');
      };
      if (adoptPoints !== undefined) show(adoptPoints);
      else void deps.adoptPoints().then((n) => { adoptPoints = n; show(n); }).catch(() => {});
    }
    pane_.append(
      h('div', { class: 'cc-target-head' }, dot(colourOf()(current.characterId), 8), label, h('span', { class: 'cc-chip cc-chip-draft', text: '草稿' }), h('span', { class: 'cc-spacer' }), points, h('span', { class: 'cc-target-where', text: '在角色工作台里发布' })),
      value,
    );
    if (adopting?.ordinal === picked.ordinal) {
      pane_.append(adoptEditor(current, picked, (next) => { field = next; paintField(); }));
    }
    if (saved && saved.ordinal === picked.ordinal && picked.adoptedAt !== null)
      pane_.append(
        h(
          'div',
          { class: 'cc-saved' },
          h('b', { text: `已存进角色草稿（修订 ${saved.revision}），这条标为已处理` }),
          h('a', { class: 'cc-go', text: '去角色工作台发布 →', attrs: { href: `#/characters/${current.characterId}` } }),
        ),
      );
    paintField();
    return pane_;
  };

  const renderDetail = () => {
    if (!detail || active < 0) {
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

    const groups = COCREATION_TARGET_FIELDS.map((field) => ({
      field,
      answers: current.answers.filter((answer) => answer.targetField === field),
    })).filter((group) => group.answers.length > 0);

    const left = h(
      'div',
      { class: 'cc-left' },
      ...groups.map((group) =>
        h(
          'section',
          { class: 'cc-group', attrs: { 'data-field': group.field } },
          h('h4', { text: COCREATION_FIELD_LABELS[group.field as CocreationTargetField] }),
          ...group.answers.map((answer) => {
            const card = cocreationCard(answer.cardId);
            const copy = h('button', { text: '复制', attrs: { type: 'button' }, class: 'cc-copy' });
            copy.addEventListener('click', () => void copyText(plain(answer, character)));
            const add = h('button', { text: '+ 加入草稿 →', attrs: { type: 'button' }, class: 'cc-adopt-open' });
            add.disabled = !manage || adopting?.ordinal === answer.ordinal;
            add.addEventListener('click', () => {
              adopting = { ordinal: answer.ordinal };
              viewing = answer.ordinal;
              adoptError = '';
              renderDetail();
            });
            // Part 24c: a pair note goes to the cast draft as a story; a memo is for the team and has no adoption at all.
            const story = h('button', { text: '+ 加入关系与故事 →', attrs: { type: 'button' }, class: 'cc-adopt-story' });
            story.disabled = !manage || (deps.canEditCast ? !deps.canEditCast() : false);
            story.addEventListener('click', () => void addStory(current, answer.ordinal));
            const undo = h('button', { text: '取消采用', attrs: { type: 'button' }, class: 'cc-unadopt' });
            undo.disabled = !manage;
            undo.addEventListener('click', () => void unadopt(current, answer.ordinal));
            return h(
              'article',
              { class: 'cc-answer', attrs: { 'data-ordinal': String(answer.ordinal) } },
              h('p', {
                class: 'cc-card-prompt',
                text:
                  current.kind === 'memo'
                    ? '给制作组的留言条'
                    : current.kind === 'pair'
                      ? `${nameOf(current.characterId)}和${nameOf(current.partnerId ?? '')}之间的故事`
                      : card
                        ? cocreationPrompt(card, character)
                        : answer.cardId,
              }),
              bubbles(answer, character),
              h(
                'div',
                { class: 'cc-answer-actions' },
                copy,
                current.kind === 'memo'
                  ? null
                  : current.kind === 'pair'
                    ? deps.castRevision
                      ? story
                      : null
                    : deps.canEditCharacter && !deps.canEditCharacter(current.characterId)
                      ? null
                      : add,
                answer.adoptedAt !== null ? h('span', { class: 'cc-chip cc-chip-adopted', text: '已采用' }) : null,
                answer.adoptedAt !== null && current.kind !== 'memo' ? undo : null,
              ),
            );
          }),
        ),
      ),
    );

    pane.replaceChildren(
      h(
        'header',
        { class: 'cc-detail-head' },
        h('h3', {}, dot(colourOf()(current.characterId), 10), `${whoOf(current)} · ${current.pseudonym}`),
        h('p', {
          text: `${when(current.createdAt)}${current.batch ? ` · 邀请批次：${current.batch}` : ''} · ${STATUS_LABEL[current.status]}${current.processedAt ? `（${when(current.processedAt)}）` : ''}`,
        }),
        h('div', { class: 'cc-detail-actions' }, star, ...statusButtons),
      ),
      h('div', { class: `cc-detail-grid${current.kind === 'memo' ? ' is-single' : ''}` }, left, targetPane(current)),
    );
  };

  /** Who a note is about: a character, both characters of a pair, or the production team. */
  function whoOf(entry: { kind?: InboxItem['kind']; characterId: string; partnerId?: string | null }) {
    if (entry.kind === 'memo') return '制作组';
    if (entry.kind === 'pair') return `${nameOf(entry.characterId)} × ${nameOf(entry.partnerId ?? '')}`;
    return nameOf(entry.characterId);
  }
  /** 加入关系与故事: reads the cast draft's revision, then adds the story to THAT revision (a draft that moved on is refused). */
  async function addStory(current: InboxDetail, ordinal: number) {
    if (!deps.castRevision || !deps.api.addToCastStory) return;
    await deps.run(async () => {
      const revision = await deps.castRevision!();
      await deps.api.addToCastStory!(current.id, ordinal, revision);
      stampAdopted(current, ordinal, Date.now());
      deps.status('已加入世界设定草稿的「关系与故事」（未发布）。');
    });
  }
  async function unadopt(current: InboxDetail, ordinal: number) {
    if (!deps.api.unadopt) return;
    await deps.run(async () => {
      await deps.api.unadopt!(current.id, ordinal);
      stampAdopted(current, ordinal, null);
      deps.status('已取消采用标记（已发的点数不收回）。');
    });
  }
  function stampAdopted(current: InboxDetail, ordinal: number, stamp: number | null) {
    if (!detail || detail.id !== current.id) return;
    detail = {
      ...detail,
      status: 'processed',
      answers: detail.answers.map((entry) => (entry.ordinal === ordinal ? { ...entry, adoptedAt: stamp } : entry)),
    };
    patchItem(current.id, {
      status: 'processed',
      adoptedCount: detail.answers.filter((entry) => entry.adoptedAt !== null).length,
    });
    renderList();
    renderDetail();
    deps.onChanged?.();
  }

  // ---- events ---------------------------------------------------------------------------------------------------
  const reload = () => {
    adopting = null;
    void deps.run(() => load());
  };
  const pickFilter = (change: Partial<InboxFilter>) => {
    filter = { ...filter, ...change };
    reload();
  };
  starChip.addEventListener('click', () => pickFilter({ starred: !filter.starred }));
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
  // There is no 更多 button: the next page is read when the list is scrolled to its end.
  list.addEventListener('scroll', () => {
    const box = list as unknown as { scrollTop: number; clientHeight: number; scrollHeight: number };
    if (next && !loadingMore && box.scrollTop + box.clientHeight >= box.scrollHeight - 120) {
      loadingMore = true;
      void deps.run(() => load(next)).finally(() => (loadingMore = false));
    }
  });
  archiveSelected.addEventListener('click', () => {
    if (selected.size) void setStatus([...selected], 'archived');
  });
  processSelected.addEventListener('click', () => {
    if (selected.size) void setStatus([...selected], 'processed');
  });
  clearSelected.addEventListener('click', () => {
    selected.clear();
    renderList();
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
  // The page scrolls (no inner list): the next page is read when the window reaches the end of the cards.
  const onWindowScroll = () => {
    const root_ = document.documentElement;
    if (!activated || !next || loadingMore || typeof window === 'undefined') return;
    if (window.innerHeight + window.scrollY >= root_.scrollHeight - 240) {
      loadingMore = true;
      void deps.run(() => load(next)).finally(() => (loadingMore = false));
    }
  };
  globalThis.window?.addEventListener?.('scroll', onWindowScroll, { passive: true });
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
    /** Filters the list to one character (the badge link); the next load() applies it. */
    showCharacter: (characterId: string | null) => {
      filter = { ...filter, characterId };
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
      globalThis.window?.removeEventListener?.('scroll', onWindowScroll);
    },
    /** Current selection, for tests and the page's busy state. */
    snapshot: () => ({ items, active, detail }),
  };
}

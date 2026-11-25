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
import { cocreationTheme } from '../../../../../packages/contracts/cocreation-wordings.ts';
import {
  ADOPT_ERROR_TEXT,
  ADOPT_FIELDS,
  type AdoptField,
  type AdoptTarget,
} from '../../../../../packages/contracts/cocreation-adopt.ts';
import { SPEECH_PROFILE_ERROR_TEXT } from '../../../../../packages/contracts/speech-profile.ts';
import { RELATION_ADOPT_ERROR_TEXT } from '../../../../../packages/contracts/cocreation-relations.ts';
import {
  DAILY_LIFE_LABEL,
  DAY_PART_LABELS,
  DAY_PROMPT,
  dayPartOf,
} from '../../../../../packages/contracts/cocreation-day.ts';
import { draftBox, withField, type DraftBox as Mounted } from './cocreation-draft-box.ts';
import {
  OTHERS_UNREADABLE_TEXT,
  independence,
  independenceSentences,
  type OthersReader,
} from './speech-profile/profile-draft.ts';
import type {
  InboxAnswer,
  InboxCursor,
  InboxDetail,
  InboxFilter,
  InboxItem,
  InboxStatus,
  CocreationAdminClient,
} from '../../services/cocreation-admin-api.ts';
import type { CharacterAdminClient, CharacterProfile } from '../../services/character-admin-api.ts';
import { characterAdminError } from './character-workbench.ts';
import { disclosureChevron } from './ui/disclosure.ts';
import { h } from '../cocreation/h.ts';
import { exactCount, hoverValue } from './ui/hover-value.ts';
import { fillStatus, pageHead } from './ui/page-head.ts';
import { dot } from './cast/cast-ui.ts';
import { rosterColours } from './ui/character-colour.ts';
import { consoleOrder } from './ui/console-order.ts';
import { segmented } from './ui/segmented.ts';
import { relationPanel } from './cocreation-relation-panel.ts';
import { relationsView } from './cocreation-relations-view.ts';
import { wordingsView } from './cocreation-wordings-view.ts';
import type {
  CocreationRelationsClient,
  CocreationWordingsClient,
  RelationDetail,
} from '../../services/cocreation-admin-api.ts';

type Deps = {
  api: Pick<CocreationAdminClient, 'list' | 'detail' | 'setStatus' | 'star' | 'note' | 'adopt'> &
    Partial<Pick<CocreationAdminClient, 'unadopt' | 'addToCastStory' | 'adoptAnswers'>>;
  /** Part 24c: whether the cast draft can be read (cast.read); without it 加入关系与故事 is not shown. The revision itself is never sent (Part 55). */
  castRevision?: () => Promise<number>;
  /** cast.edit (or the owner): without it 加入关系与故事 is disabled. Default: allowed. */
  canEditCast?: () => boolean;
  characters: Pick<CharacterAdminClient, 'list' | 'detail' | 'save'>;
  /**
   * Part 37b: the independence check against the other characters' cards and samples. With it, 加入草稿 into 说话风格, 对话风格 or
   * 对话示例 (what the 核心卡 / 说话样本 are made of) is blocked for a line another character already has, and asks twice for a close one.
   */
  others?: OthersReader;
  /** Part 37b: opens the 说话档案 adopt box for a note (the page's shared box). Absent = no 加入说话档案 button. */
  adoptProfile?: (input: {
    characterId: string;
    player: string;
    reply: string;
    onSaved?: (revision: number) => void | Promise<void>;
  }) => void;
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
  /** Part 39: relation notes (two to eight characters): the panel in the detail and the view 玩家眼中的关系. Absent = neither exists. */
  relations?: Pick<CocreationRelationsClient, 'detail' | 'stats' | 'adopt' | 'reject' | 'exclude' | 'tidy'>;
  /** Part 39b: 题目, the wording pool of the themes (a third view of this page). Absent = no such view. */
  wordings?: Pick<CocreationWordingsClient, 'list' | 'add' | 'edit' | 'toggle' | 'remove' | 'estimate' | 'generate'> &
    Partial<Pick<CocreationWordingsClient, 'setEnabled'>>;
  /** Part 55: how long a processed card takes to leave the list, in ms (a short motion). 0 or absent = at once. */
  leaveMs?: number;
  /** A fresh request id (adoption, 整理, 生成); default: crypto.randomUUID. */
  newId?: () => string;
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
  // Part 55: the list opens on 新: what is processed leaves it (and is found again under 已处理 / 已归档 / 全部).
  let filter: InboxFilter = { characterId: null, status: 'new', starred: false, query: '' };
  let items: InboxItem[] = [];
  let next: InboxCursor | null = null;
  let names: Record<string, string> = {};
  /** The characters of the filter chips in the console's order (首页顺序). */
  let orderIds: string[] = [];
  let active = -1;
  let detail: InboxDetail | null = null;
  let loadingDetail: string | null = null;
  const selected = new Set<string>();
  let adoptError = '';
  let gone = false;
  let activated = false;
  let loadingMore = false;
  /** Which answer's field the right-hand pane shows, and the adoption just saved (its link to 角色工作台). */
  let viewing: number | null = null;
  let saved: { ordinal: number; revision: number } | null = null;
  const drafts = new Map<string, Promise<Target | null>>();
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
  const adoptSelected = h('button', { class: 'cc-adopt-selected', attrs: { type: 'button' }, hidden: true });
  const selectAll = h('button', {
    class: 'cc-select-all',
    text: '全选',
    attrs: { type: 'button', 'aria-label': '选择列表里的全部想法' },
    hidden: true,
  });
  /** Part 55: what could not be adopted, named per item (never silent); stays until closed. */
  const reportList = h('ul', { class: 'cc-report-list' });
  const reportClose = h('button', { class: 'cc-report-close', text: '知道了', attrs: { type: 'button' } });
  const report = h(
    'div',
    { class: 'cc-adopt-report', attrs: { role: 'alert' }, hidden: true },
    h('b', { class: 'cc-report-title' }),
    reportList,
    reportClose,
  );
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
    ...(deps.api.adoptAnswers ? [adoptSelected] : []),
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
    h(
      'div',
      { class: 'cc-toolbar' },
      characterChips,
      h('div', { class: 'cc-chip-row' }, statusChips, starChip, ...(deps.api.adoptAnswers ? [selectAll] : []), query),
    ),
    report,
    empty,
    list,
  );
  const layout = h('div', { class: 'cc-layout' }, listColumn);
  // Part 39: 玩家眼中的关系 is a second view of this page (only when the page has the relation client).
  const viewHost = h('div', { class: 'cr-view', hidden: true });
  const wordingsHost = h('div', { class: 'cw-view', hidden: true });
  let showing: 'inbox' | 'relations' | 'wordings' = 'inbox';
  const viewStatus = h('span', { class: 'head-status', hidden: true });
  const relations = deps.relations
    ? relationsView(viewHost, { api: deps.relations, nameOf: (id) => nameOf(id), colour: (id) => colourOf()(id) })
    : null;
  const wordings = deps.wordings
    ? wordingsView(wordingsHost, {
        api: deps.wordings,
        nameOf: (id) => nameOf(id),
        colour: (id) => colourOf()(id),
        canManage: deps.canManage,
        newId: () => deps.newId?.() ?? globalThis.crypto.randomUUID(),
        status: deps.status,
      })
    : null;
  const switcher =
    relations || wordings
      ? segmented(
          '视图',
          [
            { id: 'inbox' as const, label: '投稿' },
            ...(relations ? [{ id: 'relations' as const, label: '玩家眼中的关系' }] : []),
            ...(wordings ? [{ id: 'wordings' as const, label: '题目' }] : []),
          ],
          'inbox',
          (id) => {
            showing = id;
            layout.hidden = id !== 'inbox';
            viewHost.hidden = id !== 'relations';
            wordingsHost.hidden = id !== 'wordings';
            counts.hidden = id !== 'inbox' || !bulk.hidden;
            viewStatus.hidden = id === 'inbox';
            if (id === 'relations' && relations)
              void deps.run(async () => {
                await relations.load();
                viewStatus.textContent = relations.status.textContent ?? '';
              });
            if (id === 'wordings' && wordings)
              void deps.run(async () => {
                await wordings.load();
                viewStatus.textContent = wordings.status.textContent ?? '';
              });
          },
        )
      : null;
  root.replaceChildren(
    pageHead('共创收件箱', switcher?.root, viewStatus, counts, bulk),
    layout,
    ...(relations ? [viewHost] : []),
    ...(wordings ? [wordingsHost] : []),
  );

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
    for (const item of items)
      if (item.status === 'new') found.set(item.characterId, (found.get(item.characterId) ?? 0) + 1);
    return found;
  };
  const renderFilters = () => {
    const fresh = newPer();
    characterChips.replaceChildren(
      chip('全部角色', filter.characterId === null, () => pickFilter({ characterId: null })),
      ...orderIds.map((id) =>
        chip(
          nameOf(id),
          filter.characterId === id,
          () => pickFilter({ characterId: id }),
          fresh.get(id),
          dot(colourOf()(id), 8),
        ),
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
    adoptSelected.hidden = archiveSelected.hidden || !deps.api.adoptAnswers;
    selectAll.hidden = !manage || !deps.api.adoptAnswers || items.length === 0;
    selectAll.textContent = items.length > 0 && items.every((item) => selected.has(item.id)) ? '取消全选' : '全选';
    adoptSelected.textContent = `采纳所选（${selected.size}）`;
    bulk.hidden = archiveSelected.hidden || showing !== 'inbox';
    counts.hidden = !bulk.hidden || showing !== 'inbox';
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
        {
          class: 'cc-row-open',
          attrs: {
            type: 'button',
            'aria-current': String(index === active),
            'aria-expanded': String(index === active),
          },
        },
        h(
          'span',
          { class: 'cc-who' },
          h(
            'span',
            { class: 'cc-name' },
            disclosureChevron(),
            dot(colour(item.characterId), 8),
            h('strong', { text: whoOf(item) }),
          ),
          h('span', { class: 'cc-pseudonym', text: item.pseudonym }),
          time,
        ),
        h('span', { class: 'cc-text' }, h('span', { class: 'cc-first', text: item.firstLine })),
        h(
          'span',
          { class: 'cc-chips' },
          item.kind === 'memo' ? h('span', { class: 'cc-chip cc-chip-memo', text: '留言条' }) : null,
          item.kind === 'pair' ? h('span', { class: 'cc-chip cc-chip-pair', text: '关系与故事' }) : null,
          item.kind === 'pair' && item.decision === 'adopted'
            ? h('span', { class: 'cc-chip cc-chip-adopted', text: '已采纳' })
            : null,
          item.kind === 'pair' && item.decision === 'rejected' ? h('span', { class: 'cc-chip', text: '不采纳' }) : null,
          item.kind === 'pair' && item.excluded ? h('span', { class: 'cc-chip', text: '不计入' }) : null,
          h('span', { class: 'cc-count', text: `${item.answerCount} 条` }),
          item.adoptedCount > 0
            ? h('span', { class: 'cc-chip', text: `已采用 ${item.adoptedCount}/${item.answerCount}` })
            : null,
          h('span', { class: 'cc-spacer' }),
          item.starred
            ? h('span', { class: 'cc-chip cc-chip-star', text: '★', attrs: { role: 'img', 'aria-label': '已星标' } })
            : null,
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
      // Part 39: the console's order (首页顺序), not this administrator's sidebar order.
      const listed = (await deps.characters.list()).characters;
      const order = await (deps.characters as { homeOrder?: () => Promise<string[]> }).homeOrder?.().catch(() => []);
      const roster = consoleOrder(listed, order ?? []);
      names = Object.fromEntries(roster.map((c) => [c.characterId, c.displayName]));
      orderIds = roster.map((c) => c.characterId);
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
    if (detail?.id === id) return;
    loadingDetail = id;
    const result = await deps.api.detail(id);
    if (gone || deps.disposed() || loadingDetail !== id) return;
    if (detail) discardBoxes(detail.id);
    detail = result;
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
      renderList();
      renderDetail();
      void leaveList(ids);
      changed();
      deps.status(
        ids.length > 1 ? `已把 ${ids.length} 条标为${STATUS_LABEL[status]}。` : `已标为${STATUS_LABEL[status]}。`,
      );
    });

  // ---- Part 55: a processed card leaves the list at once, with a short motion; the next one moves up and opens ------------
  const reducedMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
  const matchesFilter = (item: InboxItem) => filter.status === null || item.status === filter.status;
  async function leaveList(ids: string[]) {
    const leaving = items.filter((item) => ids.includes(item.id) && !matchesFilter(item)).map((item) => item.id);
    if (leaving.length === 0) return;
    const ms = reducedMotion() ? 0 : (deps.leaveMs ?? 0);
    if (ms > 0) {
      for (const id of leaving) list.querySelector?.(`[data-id="${id}"]`)?.classList.add('is-leaving');
      await new Promise((resolve) => setTimeout(resolve, ms));
      if (gone || deps.disposed()) return;
    }
    const openId = items[active]?.id;
    const index = active;
    items = items.filter((item) => !leaving.includes(item.id));
    for (const id of leaving) selected.delete(id);
    if (openId && !leaving.includes(openId)) active = items.findIndex((item) => item.id === openId);
    else {
      detail = null;
      active = items.length ? Math.max(0, Math.min(index, items.length - 1)) : -1;
    }
    renderFilters();
    renderList();
    renderDetail();
    if (active >= 0 && detail?.id !== items[active]?.id) void pump();
  }
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

  /**
   * The character's CURRENT draft (the published version while there is no draft), read once per open note. Its revision is what a
   * saved draft is compared against: a draft that moved on in the meantime is refused by the existing compare-and-swap save.
   */
  type Target = {
    template: Template;
    base: CharacterProfile;
    revision: number | null;
    publishedVersion: number | null;
  };
  const templateOf = (characterId: string): Promise<Target | null> => {
    let found = drafts.get(characterId);
    if (!found) {
      found = deps.characters
        .detail(characterId)
        .then((target) => {
          const base = target.draft?.profile ?? target.published?.profile;
          if (!base) return null;
          return {
            template: base.template as unknown as Template,
            base,
            revision: target.draft?.revision ?? null,
            publishedVersion: target.published?.version ?? null,
          };
        })
        .catch(() => null);
      drafts.set(characterId, found);
    }
    return found;
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
        h(
          'div',
          { class: 'cc-target-head' },
          dot(colourOf()(current.characterId), 8),
          h('b', { text: `${whoOf(current)} · 新故事` }),
          h('span', { class: 'cc-chip cc-chip-draft', text: '草稿' }),
          h('span', { class: 'cc-spacer' }),
          h('span', { class: 'cc-target-where', text: '在关系与故事里发布' }),
        ),
        h('p', {
          class: 'cc-target-text',
          text: adopted ? '已存成关系与故事的草稿故事。' : '这条会作为新故事存进关系与故事的草稿，参与者是这两位。',
        }),
      );
      if (adopted) pane_.append(h('a', { class: 'cc-go', text: '去关系与故事发布 →', attrs: { href: '#/cast' } }));
      return pane_;
    }
    const picked = current.answers.find((answer) => answer.ordinal === viewing) ?? current.answers[0];
    if (!picked) return pane_;
    const choiceKey = `${current.id}:${picked.ordinal}`;
    const field: AdoptTarget = fieldOf(current, picked);
    const dayPart = dayPartOf(picked.cardId);
    const label = h('b', {
      class: 'cc-target-label',
      text: `${character} · ${field === 'dailyLife' ? `${DAILY_LIFE_LABEL} · ${DAY_PART_LABELS[dayPart!]}` : COCREATION_FIELD_LABELS[field]}`,
    });
    const points = h('span', { class: 'cc-chip cc-chip-points', hidden: true });
    if (deps.adoptPoints) {
      const show = (n: number | null) => {
        if (n === null) return;
        points.textContent = `采用 +${n}`;
        points.hidden = false;
        hoverValue(points, '采用后玩家得到的积分，在积分发放里改');
      };
      if (adoptPoints !== undefined) show(adoptPoints);
      else
        void deps
          .adoptPoints()
          .then((n) => {
            adoptPoints = n;
            show(n);
          })
          .catch(() => {});
    }
    pane_.append(
      h(
        'div',
        { class: 'cc-target-head' },
        dot(colourOf()(current.characterId), 8),
        label,
        h('span', { class: 'cc-chip cc-chip-draft', text: '草稿' }),
        h('span', { class: 'cc-spacer' }),
        points,
        h('span', { class: 'cc-target-where', text: '在角色工作台里发布' }),
      ),
    );
    // A free-form note can go to any field: the picker is a compact select above the box, only then.
    if (picked.targetField === 'free' && !dayPart) {
      const pick = h('select', { attrs: { 'aria-label': '加入到哪个字段' } });
      for (const value of ADOPT_FIELDS)
        pick.append(h('option', { text: COCREATION_FIELD_LABELS[value], attrs: { value } }));
      pick.value = field;
      pick.addEventListener('change', () => {
        chosen.set(choiceKey, pick.value as AdoptField);
        // Another field is another box: the note is not in it yet, so 加入草稿 is available again. The boxes this note had are
        // dropped (their unsaved text with them), so the note can never end up in the draft twice.
        inserted.delete(choiceKey);
        for (const key of [...boxes.keys()]) if (key.startsWith(`${choiceKey}:`)) boxes.delete(key);
        adoptError = '';
        renderDetail();
      });
      pane_.append(pick);
    }
    const mayEdit = deps.canManage() && (!deps.canEditCharacter || deps.canEditCharacter(current.characterId));
    const holder = h('div', { class: 'cc-draft-box' }, h('p', { class: 'cc-target-empty', text: '…' }));
    const error = h('p', { class: 'cc-adopt-error', attrs: { role: 'alert' }, hidden: adoptError === '' });
    error.textContent = adoptError;
    const cancel = h('button', { text: '撤回', attrs: { type: 'button' }, class: 'cc-adopt-cancel' });
    const save = h('button', { text: '保存草稿', attrs: { type: 'button' }, class: 'cc-adopt-save' });
    const lock = (button: HTMLButtonElement, off: boolean) => {
      button.disabled = off;
      button.dataset.locked = String(off);
    };
    lock(cancel, true);
    lock(save, true);
    const entry = boxFor(current, picked, field);
    void entry.ready.then((box) => {
      if (gone || deps.disposed()) return;
      if (!box) {
        holder.replaceChildren(h('p', { class: 'cc-target-empty', text: '读不到这个角色的草稿。' }));
        return;
      }
      holder.replaceChildren(box.root);
      const sync = () => {
        const off = !mayEdit || !box.dirty();
        lock(cancel, off);
        lock(save, off);
      };
      entry.onEdit = sync;
      sync();
    });
    cancel.addEventListener('click', () => {
      discardBoxes(current.id);
      adoptError = '';
      renderDetail();
    });
    save.addEventListener('click', () => void saveField(current, picked, field));
    pane_.append(holder, error);
    if (mayEdit) pane_.append(h('div', { class: 'cc-adopt-actions' }, cancel, save));
    if (saved && saved.ordinal === picked.ordinal && picked.adoptedAt !== null)
      pane_.append(
        h(
          'div',
          { class: 'cc-saved' },
          h('b', { text: `已存进角色草稿 ${saved.revision}，这条标为已处理` }),
          h('a', {
            class: 'cc-go',
            text: '去角色工作台发布 →',
            attrs: { href: `#/characters/${current.characterId}` },
          }),
        ),
      );
    return pane_;
  };

  // ---- the draft box: one per (note, answer, field), kept while the detail re-renders so that nothing typed is lost ----
  type BoxEntry = { ready: Promise<Mounted | null>; box: Mounted | null; inserted: boolean; onEdit: () => void };
  const boxes = new Map<string, BoxEntry>();
  const chosen = new Map<string, AdoptField>();
  const boxKey = (id: string, ordinal: number, field: AdoptTarget) => `${id}:${ordinal}:${field}`;
  function boxFor(current: InboxDetail, answer: InboxAnswer, field: AdoptTarget): BoxEntry {
    const key = boxKey(current.id, answer.ordinal, field);
    let entry = boxes.get(key);
    if (!entry) {
      const made: BoxEntry = { ready: Promise.resolve(null), box: null, inserted: false, onEdit: () => {} };
      const source =
        answer.kind === 'text' ? { text: answer.text } : { player: answer.player, replies: answer.replies };
      made.ready = templateOf(current.characterId).then((target) => {
        if (!target) return null;
        made.box = draftBox({
          template: target.template,
          field,
          ...(dayPartOf(answer.cardId) ? { part: dayPartOf(answer.cardId)! } : {}),
          source,
          character: nameOf(current.characterId),
          readOnly: !deps.canManage() || (deps.canEditCharacter ? !deps.canEditCharacter(current.characterId) : false),
          onEdit: () => made.onEdit(),
        });
        return made.box;
      });
      boxes.set(key, made);
      entry = made;
    }
    return entry;
  }
  /** Drops every box of one note (撤回, a saved draft, another note opened): the next paint reads the draft again. */
  function discardBoxes(id: string) {
    for (const key of [...boxes.keys()]) if (key.startsWith(`${id}:`)) boxes.delete(key);
    for (const key of [...chosen.keys()]) if (key.startsWith(`${id}:`)) chosen.delete(key);
    for (const key of [...inserted]) if (key.startsWith(`${id}:`)) inserted.delete(key);
    const target = detail?.characterId;
    if (target) drafts.delete(target);
  }
  function forgetBoxes() {
    relationCache.clear();
    boxes.clear();
    chosen.clear();
    inserted.clear();
    drafts.clear();
  }
  /** Notes whose text was put into a box and not saved yet: their 加入草稿 stays locked (the draft would carry them twice). */
  const inserted = new Set<string>();
  const fieldOf = (current: InboxDetail, answer: InboxAnswer): AdoptTarget =>
    (dayPartOf(answer.cardId) ? ('dailyLife' as const) : undefined) ??
    chosen.get(`${current.id}:${answer.ordinal}`) ??
    (answer.targetField === 'free' ? 'persona' : (answer.targetField as AdoptField));

  const showAdoptError = (message: string) => {
    adoptError = message;
    const node = pane.querySelector?.('.cc-adopt-error') as HTMLElement | null;
    if (node) {
      node.textContent = message;
      node.hidden = message === '';
    }
  };

  /** 加入草稿: the note goes INTO the text the right side shows (at the caret, else at the end), never into a new box. */
  async function insertNote(current: InboxDetail, answer: InboxAnswer) {
    if (answer.adoptedAt !== null || inserted.has(`${current.id}:${answer.ordinal}`)) return;
    const wasViewing = viewing;
    viewing = answer.ordinal;
    adoptError = '';
    if (wasViewing !== answer.ordinal) renderDetail();
    const field = fieldOf(current, answer);
    const entry = boxFor(current, answer, field);
    const box = await entry.ready;
    if (gone || deps.disposed() || detail?.id !== current.id) return;
    if (!box) {
      showAdoptError('这个角色还没有可编辑的版本，请先在角色工作台中创建草稿。');
      return;
    }
    if (!box.insert()) {
      showAdoptError(ADOPT_ERROR_TEXT.ADOPT_FIELD_SHAPE_UNSUPPORTED!);
      return;
    }
    entry.inserted = true;
    inserted.add(`${current.id}:${answer.ordinal}`);
    entry.onEdit();
    // Only the button changes: the box (and the caret in it) must not be rebuilt.
    const button = pane.querySelector?.(
      `[data-ordinal="${answer.ordinal}"] .cc-adopt-open`,
    ) as HTMLButtonElement | null;
    if (button) {
      button.disabled = true;
      button.dataset.locked = 'true';
    }
  }

  /** The fields that make up the 说话档案 (the independence check applies to them). */
  const PROFILE_FIELDS = new Set<AdoptField>(['speechStyle', 'dialogueStyle', 'dialogueExamples']);
  let closeWarned = '';
  /** 保存草稿: the field's new value goes through the existing draft save (compare-and-swap on the revision the box was read at). */
  async function saveField(current: InboxDetail, answer: InboxAnswer, field: AdoptTarget) {
    const entry = boxes.get(boxKey(current.id, answer.ordinal, field));
    const box = entry?.box;
    if (!entry || !box) return;
    const fail = showAdoptError;
    void deps.run(async () => {
      fail('');
      const result = box.result();
      if (!result.ok) {
        fail(result.error);
        return;
      }
      // A note was put in, and nothing readable is left of the field: there is nothing to add.
      if (
        entry.inserted &&
        (result.value === undefined || (typeof result.value === 'string' && result.value.trim() === ''))
      ) {
        fail(ADOPT_ERROR_TEXT.ADOPT_TEXT_REQUIRED!);
        return;
      }
      try {
        const target = await templateOf(current.characterId);
        if (!target) {
          fail('这个角色还没有可编辑的版本，请先在角色工作台中创建草稿。');
          return;
        }
        const profile = structuredClone(target.base);
        // No draft yet: start one from the published version, one version ahead, exactly as the workbench does.
        if (target.revision === null && target.publishedVersion !== null)
          (profile.template as { version: number }).version = target.publishedVersion + 1;
        profile.template = withField(profile.template, field, result.value, dayPartOf(answer.cardId) ?? undefined);
        if (deps.others && field !== 'dailyLife' && PROFILE_FIELDS.has(field)) {
          let verdict;
          try {
            verdict = await independence(deps.others, current.characterId, target.base.template, profile.template);
          } catch {
            fail(OTHERS_UNREADABLE_TEXT);
            return;
          }
          const sentences = independenceSentences(verdict, (id) => nameOf(id)).join('；');
          if (verdict.level === 'block') {
            fail(`这句话和别的角色太像了，不能保存。${sentences}`);
            return;
          }
          const sig = `${current.id}:${answer.ordinal}:${field}:${JSON.stringify(result.value)}`;
          if (verdict.level === 'warn' && closeWarned !== sig) {
            closeWarned = sig;
            fail(`和别的角色有点接近：${sentences}。再点一次保存草稿才会存。`);
            return;
          }
          closeWarned = '';
        }
        const saved_ = await deps.characters.save(current.characterId, target.revision, profile);
        deps.others?.forget();
        const adoptedNow = entry.inserted;
        if (adoptedNow) {
          try {
            await deps.api.adopt(current.id, answer.ordinal);
          } catch {
            fail(`草稿 ${saved_.revision} 已保存，但没能把这条标为“已采用”。请勿重复加入；可稍后刷新核对。`);
            discardBoxes(current.id);
            return;
          }
        }
        const stamp = Date.now();
        discardBoxes(current.id);
        if (adoptedNow) {
          detail = {
            ...current,
            status: 'processed',
            answers: current.answers.map((e) => (e.ordinal === answer.ordinal ? { ...e, adoptedAt: stamp } : e)),
          };
          patchItem(current.id, {
            status: 'processed',
            adoptedCount: detail.answers.filter((a) => a.adoptedAt !== null).length,
          });
          saved = { ordinal: answer.ordinal, revision: saved_.revision };
        }
        adoptError = '';
        renderList();
        renderDetail();
        if (adoptedNow) changed();
        deps.status(
          adoptedNow
            ? `已加入草稿 ${saved_.revision}。尚未发布：请在“角色工作台”里预览，确认后再发布。`
            : `草稿 ${saved_.revision} 已保存。尚未发布。`,
        );
      } catch (caught) {
        fail(characterAdminError(caught) ?? '保存草稿没有成功，请核对后重试；本次没有标记为已采用。');
      }
    });
  }

  /** characters.edit for this note's character (or the owner): without it 采纳 is not shown. */
  const canEditHere = (current: InboxDetail) =>
    deps.canManage() && (!deps.canEditCharacter || deps.canEditCharacter(current.characterId));
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

    // Part 55: 采纳全部 - every answer of this card that is not adopted yet, each into its own destination.
    const open = current.answers.filter((answer) => answer.adoptedAt === null);
    const adoptAll =
      deps.api.adoptAnswers &&
      current.kind !== 'memo' &&
      current.kind !== 'pair' &&
      canEditHere(current) &&
      open.length > 1
        ? (() => {
            const all = h('button', {
              text: `采纳全部（${open.length}）`,
              attrs: { type: 'button' },
              class: 'cc-adopt-all',
            });
            all.disabled = !manage;
            all.dataset.locked = String(all.disabled);
            all.addEventListener(
              'click',
              () =>
                void adoptNow(
                  current,
                  open.map((answer) => answer.ordinal),
                ),
            );
            return all;
          })()
        : null;

    // Part 47: the parts of 「一天」 form their own group (stored as 自由发挥, but they are adopted into 一天的安排).
    const groups: { field: string; label: string; answers: InboxAnswer[] }[] = [
      ...COCREATION_TARGET_FIELDS.map((field) => ({
        field: field as string,
        label: COCREATION_FIELD_LABELS[field],
        answers: current.answers.filter((answer) => answer.targetField === field && !dayPartOf(answer.cardId)),
      })),
      {
        field: 'dailyLife',
        label: DAILY_LIFE_LABEL,
        answers: current.answers.filter((answer) => dayPartOf(answer.cardId)),
      },
    ].filter((group) => group.answers.length > 0);

    const left = h(
      'div',
      { class: 'cc-left' },
      ...groups.map((group) =>
        h(
          'section',
          { class: 'cc-group', attrs: { 'data-field': group.field } },
          h('h4', { text: group.label }),
          ...group.answers.map((answer) => {
            const card = cocreationCard(answer.cardId);
            const copy = h('button', { text: '复制', attrs: { type: 'button' }, class: 'cc-copy' });
            copy.addEventListener('click', () => void copyText(plain(answer, character)));
            const add = h('button', { text: '+ 加入草稿 →', attrs: { type: 'button' }, class: 'cc-adopt-open' });
            // Part 24b-6, round 4: a note that is already adopted cannot be added again (the draft would carry it twice) until 取消采用.
            add.disabled = !manage || answer.adoptedAt !== null || inserted.has(`${current.id}:${answer.ordinal}`);
            // The page's busy pass re-enables every control it finds; an adopted note stays locked until 取消采用.
            add.dataset.locked = String(add.disabled);
            add.addEventListener('click', () => void insertNote(current, answer));
            // Part 24c: a pair note goes to the cast draft as a story; a memo is for the team and has no adoption at all.
            const story = h('button', {
              text: '+ 加入关系与故事 →',
              attrs: { type: 'button' },
              class: 'cc-adopt-story',
            });
            story.disabled = !manage || (deps.canEditCast ? !deps.canEditCast() : false) || answer.adoptedAt !== null;
            story.dataset.locked = String(story.disabled);
            story.addEventListener('click', () => void addStory(current, answer.ordinal));
            // Part 37b: the same note into the 说话档案 (核心卡 + a field, or 说话样本 + a situation) through the shared adopt box.
            const profile = h('button', {
              text: '+ 加入说话档案 →',
              attrs: { type: 'button' },
              class: 'cc-adopt-profile',
            });
            profile.disabled = !manage || answer.adoptedAt !== null || inserted.has(`${current.id}:${answer.ordinal}`);
            profile.dataset.locked = String(profile.disabled);
            profile.addEventListener('click', () => {
              deps.adoptProfile?.({
                characterId: current.characterId,
                player: answer.kind === 'text' ? '' : answer.player,
                reply: answer.kind === 'text' ? answer.text : answer.replies.join('\n'),
                onSaved: async () => {
                  await deps.api.adopt(current.id, answer.ordinal);
                  stampAdopted(current, answer.ordinal, Date.now());
                },
              });
            });
            const now = h('button', { text: '采纳', attrs: { type: 'button' }, class: 'cc-adopt-now' });
            now.disabled = !manage || answer.adoptedAt !== null || inserted.has(`${current.id}:${answer.ordinal}`);
            now.dataset.locked = String(now.disabled);
            now.addEventListener('click', () => void adoptNow(current, [answer.ordinal]));
            const undo = h('button', { text: '取消采用', attrs: { type: 'button' }, class: 'cc-unadopt' });
            undo.disabled = !manage;
            undo.addEventListener('click', () => void unadopt(current, answer.ordinal));
            return h(
              'article',
              { class: 'cc-answer', attrs: { 'data-ordinal': String(answer.ordinal) } },
              current.kind === 'memo' || current.kind === 'pair' || card
                ? h('p', {
                    class: 'cc-card-prompt',
                    text:
                      current.kind === 'memo'
                        ? '给制作组的留言条'
                        : current.kind === 'pair'
                          ? `${nameOf(current.characterId)}和${nameOf(current.partnerId ?? '')}之间的故事`
                          : dayPartOf(answer.cardId)
                            ? `${DAY_PROMPT.replaceAll('{name}', character)} · ${DAY_PART_LABELS[dayPartOf(answer.cardId)!]}`
                            : // Part 39b: a theme answer shows its theme AND the exact question the player was shown.
                              cocreationTheme(answer.cardId)
                              ? `${cocreationTheme(answer.cardId)!.label} · ${answer.wording ?? cocreationPrompt(card!, character)}`
                              : card
                                ? cocreationPrompt(card, character)
                                : '',
                  })
                : null,
              bubbles(answer, character),
              h(
                'div',
                { class: 'cc-answer-actions' },
                copy,
                deps.api.adoptAnswers && current.kind !== 'memo' && current.kind !== 'pair' && canEditHere(current)
                  ? now
                  : null,
                current.kind === 'memo'
                  ? null
                  : current.kind === 'pair'
                    ? deps.castRevision
                      ? story
                      : null
                    : deps.canEditCharacter && !deps.canEditCharacter(current.characterId)
                      ? null
                      : add,
                current.kind === 'memo' || current.kind === 'pair' || !deps.adoptProfile || dayPartOf(answer.cardId)
                  ? null
                  : deps.canEditCharacter && !deps.canEditCharacter(current.characterId)
                    ? null
                    : profile,
                answer.adoptedAt !== null ? h('span', { class: 'cc-chip cc-chip-adopted', text: '已采用' }) : null,
                answer.adoptedAt !== null && current.kind !== 'memo' ? undo : null,
              ),
            );
          }),
        ),
      ),
    );

    const relational = !!deps.relations && current.kind === 'pair';
    pane.replaceChildren(
      h(
        'header',
        { class: 'cc-detail-head' },
        h(
          'h3',
          {},
          dot(colourOf()(current.characterId), 10),
          `${whoOf(items.find((entry) => entry.id === current.id) ?? current)} · ${current.pseudonym}`,
        ),
        h('p', {
          text: `${when(current.createdAt)}${current.batch ? ` · 邀请批次：${current.batch}` : ''} · ${STATUS_LABEL[current.status]}${current.processedAt ? `（${when(current.processedAt)}）` : ''}`,
        }),
        h('div', { class: 'cc-detail-actions' }, adoptAll ?? null, star, ...statusButtons),
      ),
      relational
        ? h('div', { class: 'cc-detail-grid is-single' }, relationBody(current))
        : h(
            'div',
            { class: `cc-detail-grid${current.kind === 'memo' ? ' is-single' : ''}` },
            left,
            targetPane(current),
          ),
    );
  };

  // ---- Part 39: a relation note (two to eight characters) ---------------------------------------------------------------------
  const relationCache = new Map<string, RelationDetail>();
  const newId = () => deps.newId?.() ?? globalThis.crypto.randomUUID();
  const relationBody = (current: InboxDetail): HTMLElement => {
    const host = h('div', { class: 'cr-host' }, h('p', { class: 'cc-target-empty', text: '…' }));
    const show = (found: RelationDetail) => {
      host.replaceChildren(
        relationPanel(found, {
          api: deps.relations!,
          nameOf,
          colour: colourOf(),
          canManage: deps.canManage,
          canEditCast: () => (deps.canEditCast ? deps.canEditCast() : true),
          run: deps.run,
          status: deps.status,
          newId,
          changed: (patch) => {
            const settled =
              patch.decision === 'adopted' ? 'processed' : patch.decision === 'rejected' ? 'archived' : null;
            relationCache.set(current.id, { ...(relationCache.get(current.id) ?? found), ...patch } as RelationDetail);
            patchItem(current.id, { ...patch, ...(settled ? { status: settled } : {}) });
            if (settled && detail?.id === current.id) detail = { ...detail, status: settled };
            renderList();
            if (settled) renderDetail();
            if (settled) void leaveList([current.id]);
            changed();
          },
        }),
      );
    };
    const cached = relationCache.get(current.id);
    if (cached) show(cached);
    else
      void deps
        .relations!.detail(current.id)
        .then((found) => {
          relationCache.set(current.id, found);
          if (!gone && !deps.disposed() && detail?.id === current.id) show(found);
        })
        .catch((caught) => {
          host.replaceChildren(
            h('p', { class: 'cc-adopt-error', text: characterAdminError(caught) ?? '读不到这条投稿的内容。' }),
          );
        });
    return host;
  };

  /** Who a note is about: a character, both characters of a pair, or the production team. */
  function whoOf(entry: { kind?: InboxItem['kind']; characterId: string; partnerId?: string | null }) {
    if (entry.kind === 'memo') return '制作组';
    if (entry.kind === 'pair') {
      const members = (entry as { memberIds?: string[] }).memberIds;
      if (members && members.length > 0) return members.map(nameOf).join(' × ');
      return `${nameOf(entry.characterId)} × ${nameOf(entry.partnerId ?? '')}`;
    }
    return nameOf(entry.characterId);
  }
  /** 加入关系与故事: the server adds the story to the cast draft at its current revision. */
  async function addStory(current: InboxDetail, ordinal: number) {
    if (!deps.castRevision || !deps.api.addToCastStory) return;
    if (current.answers.find((entry) => entry.ordinal === ordinal)?.adoptedAt) return;
    await deps.run(async () => {
      // Part 55: no revision is sent; the server writes the story at the draft's current revision.
      await deps.api.addToCastStory!(current.id, ordinal);
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
    void leaveList([current.id]);
    deps.onChanged?.();
  }

  // ---- Part 55: 采纳 (one answer, every answer of a card, or every ticked card) ---------------------------------------------
  /** The sentence for a refusal named by the server (never the code; a field both sides changed is named). */
  const sentenceOf = (code: string, fields?: string[]) => {
    if (code === 'DRAFT_FIELD_CONFLICT' && fields?.length)
      return `「${fields.join('」「')}」在草稿和正式版本里都改过，请先在角色工作台里核对。`;
    return (
      ADOPT_ERROR_TEXT[code] ??
      SPEECH_PROFILE_ERROR_TEXT[code] ??
      RELATION_ADOPT_ERROR_TEXT[code] ??
      characterAdminError({ code }) ??
      '没有采纳成功，请稍后重试。'
    );
  };
  const showReport = (title: string, lines: string[]) => {
    (report.querySelector('.cc-report-title') as HTMLElement).textContent = title;
    reportList.replaceChildren(...lines.map((line) => h('li', { text: line })));
    report.hidden = lines.length === 0;
  };
  reportClose.addEventListener('click', () => {
    report.hidden = true;
  });
  /** Where the administrator sent an answer by the picker above the box; none = the default of its card (decided by the server). */
  const destinationFor = (current: InboxDetail, answer: InboxAnswer) => {
    const picked = chosen.get(`${current.id}:${answer.ordinal}`);
    return picked ? { destination: { field: picked as string } } : {};
  };
  const where = (item: { id: string; ordinal: number }) => {
    const found = items.find((entry) => entry.id === item.id);
    return found
      ? `${found.pseudonym} · ${whoOf(found)}${found.answerCount > 1 ? ` · 第 ${item.ordinal + 1} 条` : ''}`
      : '这一条';
  };
  /** Sends the answers (in requests of at most 100) and settles what the server said, item by item. */
  async function adoptAnswers(entries: { id: string; ordinal: number; destination?: { field: string } }[]) {
    const results: import('../../services/cocreation-admin-api.ts').AdoptResult[] = [];
    for (let at = 0; at < entries.length; at += 100)
      results.push(...(await deps.api.adoptAnswers!(entries.slice(at, at + 100))).results);
    const stamp = Date.now();
    const settled = new Set<string>();
    for (const id of new Set(results.map((result) => result.id))) {
      const mine = results.filter((result) => result.id === id);
      const okCount = mine.filter((result) => result.ok).length;
      if (okCount === 0) continue;
      settled.add(id);
      const item = items.find((entry) => entry.id === id);
      relationCache.delete(id);
      patchItem(id, {
        status: 'processed',
        adoptedCount: Math.max(item?.adoptedCount ?? 0, okCount),
        ...(item?.kind === 'pair' ? { decision: 'adopted' as const } : {}),
      });
      if (detail?.id === id)
        detail = {
          ...detail,
          status: 'processed',
          answers: detail.answers.map((answer) =>
            mine.some((result) => result.ok && result.ordinal === answer.ordinal) && answer.adoptedAt === null
              ? { ...answer, adoptedAt: stamp }
              : answer,
          ),
        };
    }
    const failed = results.filter((result) => !result.ok);
    return { results, settled: [...settled], failed };
  }
  const finishAdopt = (outcome: Awaited<ReturnType<typeof adoptAnswers>>, extra: string[] = []) => {
    const done = outcome.results.filter((result) => result.ok && result.duplicate !== true).length;
    const lines = [
      ...outcome.failed.map((result) => `${where(result)}：${sentenceOf(result.code ?? '', result.fields)}`),
      ...extra,
    ];
    for (const id of outcome.settled) selected.delete(id);
    showReport(lines.length === 1 ? '有 1 条没有采纳' : `有 ${lines.length} 条没有采纳`, lines);
    renderList();
    renderDetail();
    changed();
    deps.status(
      done > 0
        ? `已采纳 ${done} 条，写进草稿，玩家的积分已发。尚未发布：请到角色工作台或关系与故事里整理后发布。`
        : lines.length
          ? '没有采纳成功，原因在上面列出。'
          : '这些已经采纳过了。',
    );
    void leaveList(outcome.settled);
  };
  /** 采纳 on one answer, or on every answer of the open card that is not adopted yet. */
  const adoptNow = (current: InboxDetail, ordinals: number[]) =>
    deps.run(async () => {
      if (!deps.api.adoptAnswers) return;
      report.hidden = true;
      const entries = ordinals.flatMap((ordinal) => {
        const answer = current.answers.find((entry) => entry.ordinal === ordinal);
        return answer && answer.adoptedAt === null
          ? [{ id: current.id, ordinal, ...destinationFor(current, answer) }]
          : [];
      });
      if (entries.length === 0) return;
      try {
        finishAdopt(await adoptAnswers(entries));
      } catch (caught) {
        showReport('没有采纳成功', [characterAdminError(caught) ?? '没有采纳成功，请稍后重试。']);
      }
    });
  /** 采纳所选: every answer of every ticked card, each into its own destination; a relation note into 关系与故事. */
  const adoptTicked = () =>
    deps.run(async () => {
      if (!deps.api.adoptAnswers || selected.size === 0) return;
      report.hidden = true;
      const picked = items.filter((item) => selected.has(item.id));
      const memos = picked.filter((item) => item.kind === 'memo');
      const entries = picked
        .filter((item) => item.kind !== 'memo')
        .flatMap((item) =>
          Array.from({ length: item.kind === 'pair' ? 1 : item.answerCount }, (_, ordinal) => ({
            id: item.id,
            ordinal,
          })),
        );
      const extra = memos.map((item) => `${where({ id: item.id, ordinal: 0 })}：${sentenceOf('ADOPT_MEMO')}`);
      for (const item of memos) selected.delete(item.id);
      if (entries.length === 0) {
        finishAdopt({ results: [], settled: [], failed: [] }, extra);
        return;
      }
      try {
        finishAdopt(await adoptAnswers(entries), extra);
      } catch (caught) {
        showReport('没有采纳成功', [characterAdminError(caught) ?? '没有采纳成功，请稍后重试。']);
      }
    });
  adoptSelected.addEventListener('click', () => void adoptTicked());
  selectAll.addEventListener('click', () => {
    if (items.every((item) => selected.has(item.id))) selected.clear();
    else for (const item of items) selected.add(item.id);
    renderList();
  });

  // ---- events ---------------------------------------------------------------------------------------------------
  const reload = () => {
    forgetBoxes();
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
    /** Which status the list opens on (default 新; null = 全部); the next load() applies it. */
    showStatus: (status: InboxStatus | null) => {
      filter = { ...filter, status };
    },
    clear: () => {
      items = [];
      detail = null;
      next = null;
      active = -1;
      selected.clear();
      forgetBoxes();
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

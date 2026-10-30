import {
  CAST_BODY_LIMIT,
  CAST_LIMITS,
  type CastDoc,
  type CastFileProblem,
  type CastIssue,
} from '../../../../../../packages/contracts/web-cast.ts';
import type { CastAdminPermission } from '../../../../../../packages/contracts/web-admin-permissions.ts';
import {
  castIssues,
  type CastAdminClient,
  type CastCompilePreviewResult,
  type CastImportPreview,
  type CastVersion,
} from '../../../services/cast-admin-api.ts';
import { InviteLocalApiError } from '../../../services/invite-local-api.ts';
import { browserDownload } from '../invite-tiers-view.ts';
import { h } from '../../cocreation/h.ts';
import type { ConfirmInPlace } from '../ui/inline-confirm.ts';
import { dateTimeText } from '../system-format.ts';
import { castGrid, pairPanel, type GridState } from './cast-grid.ts';
import { nameCard, seesPanel } from './cast-character.ts';
import { ISSUE_LABEL, blankCharacter, changeCount, humanIssue, nameOf } from './cast-model.ts';
import { groupsPanel, storyPanel, worldPanel, type StoryState } from './cast-stories.ts';
import { lock, svgNode, type CastCtx, type Region } from './cast-ui.ts';
import { hoverValue } from '../ui/hover-value.ts';
import { fillStatus, pageHead } from '../ui/page-head.ts';
import { unsavedText } from '../ui/unsaved.ts';
import { rosterColours } from '../ui/character-colour.ts';
import type { CharacterAdminClient } from '../../../services/character-admin-api.ts';

export type CastViewHost = {
  api: CastAdminClient | null;
  can: (permission: CastAdminPermission) => boolean;
  run: (work: () => Promise<void>) => Promise<void>;
  status: (text: string) => void;
  /** The question opens in place, inside the host it is given (no dialog). */
  confirm: ConfirmInPlace;
  toast: (text: string, tone?: 'ok' | 'info' | 'warn' | 'danger') => void;
  disposed: () => boolean;
  /**
   * The character API of 角色工作台: its roster is the fixed grid of this page (and deals the colours). Without it the grid is the
   * cast's own characters.
   */
  characters?: Pick<CharacterAdminClient, 'list' | 'save'> | null;
  canCreateCharacter?: () => boolean;
  /** Hands a file to the browser (导出文件); replaced in tests. */
  download?: (filename: string, text: string, type?: string) => void;
};

/** The issue as a person reads it: what is wrong, and where (a name or a title, never an id). */
const issueText = (doc: CastDoc, issue: CastIssue) => {
  const { where } = humanIssue(doc, issue.path);
  return `${ISSUE_LABEL[issue.code] ?? issue.code}${where ? `（${where}）` : ''}`;
};
/** The issues grouped by the character they are about (the rest under 其他), in a box that scrolls by itself. */
function issueBox(doc: CastDoc, issues: readonly CastIssue[]) {
  const groups = new Map<string, string[]>();
  for (const issue of issues) {
    const who = humanIssue(doc, issue.path).who ?? '其他';
    groups.set(who, [...(groups.get(who) ?? []), issueText(doc, issue)]);
  }
  return h(
    'div',
    { class: 'cs-issues' },
    ...[...groups].map(([who, lines]) =>
      h(
        'section',
        { class: 'cs-issue-group' },
        h('h4', { text: who }),
        h('ul', {}, ...lines.map((text) => h('li', { text }))),
      ),
    ),
  );
}
/** Problems the server already put in words (the cast file import), grouped by the character they are about. */
function problemBox(problems: readonly CastFileProblem[]) {
  const groups = new Map<string, string[]>();
  for (const problem of problems) {
    const who = problem.who ?? '其他';
    groups.set(who, [...(groups.get(who) ?? []), problem.text]);
  }
  return h(
    'div',
    { class: 'cs-issues' },
    ...[...groups].map(([who, lines]) =>
      h(
        'section',
        { class: 'cs-issue-group' },
        h('h4', { text: who }),
        h('ul', {}, ...lines.map((text) => h('li', { text }))),
      ),
    ),
  );
}
const isEmptyDraft = (doc: CastDoc) =>
  !doc.characters.length &&
  !doc.people.length &&
  !doc.groups.length &&
  !doc.stories.length &&
  !doc.memes.length &&
  !Object.keys(doc.ratings).length &&
  !doc.directions.length;

/**
 * 关系与故事 (Part 24b-2) on the 24a cast API. One working copy of the draft is edited in place; 保存草稿 sends all of it with the
 * revision it was read at (compare-and-swap). When someone else saved first, the newer draft is read aside and shown as a
 * conflict while everything typed stays in its fields until the administrator picks one side. Publishing and rolling back need
 * cast.publish, editing needs cast.edit; a control the administrator may not use is not drawn at all.
 */
export function castView(root: HTMLElement, host: CastViewHost) {
  const state = {
    doc: null as CastDoc | null,
    /** The draft as last read or saved: what "not saved yet" (amber) is measured against. */
    base: null as CastDoc | null,
    revision: 0,
    dirty: false,
    /** The draft on the server had nothing in it (so 从旧资料导入 is still possible). */
    serverEmpty: false,
    versions: [] as CastVersion[],
    latest: null as number | null,
    publishIssues: [] as CastIssue[],
    warnings: 0,
    saveIssues: [] as CastIssue[],
    conflict: null as { revision: number; doc: CastDoc } | null,
    pending: null as { revision: number; json: string; requestId: string } | null,
    sees: null as CastCompilePreviewResult | null,
    seesLoading: false,
    seesFailed: false,
    /** Characters that are in the working copy but not on the server's draft yet: there is nothing to compile for them. */
    fresh: new Set<string>(),
    pair: null as GridState['pair'],
    hover: null as GridState['hover'],
    sel: null as string | null,
    lit: null as string[] | null,
    group: null as string | null,
    groupsAll: false,
    story: null as number | null,
    person: null as string | null,
    /** The version whose line is open under the 整页版本 strip. */
    openVersion: null as number | null,
    /** The workbench roster (角色工作台): the fixed grid, with each display name. */
    roster: [] as string[],
    rosterNames: new Map<string, string>(),
    /** A chosen cast file and what importing it would do; the server saved nothing yet. */
    importing: null as { file: unknown; preview: CastImportPreview; requestId: string } | null,
  };
  let disposed = false;
  const gone = () => disposed || host.disposed();
  const canEdit = () => host.can('cast.edit');
  const canPublish = () => host.can('cast.publish');

  const frame = {
    versions: h('section', { class: 'cs-versions', attrs: { 'aria-label': '整页版本' } }),
    confirm: h('div', { class: 'cs-confirm' }),
    notice: h('div', { class: 'cs-notices' }),
    start: h('section', { class: 'cs-card cs-start' }),
    importer: h('section', { class: 'cs-card cs-adder cs-import', attrs: { 'aria-label': '导入文件' } }),
    grid: h('section', { class: 'cs-card cs-grid-card' }),
    pair: h('section', { class: 'cs-card cs-side-card cs-pair', hidden: true }),
    sees: h('section', { class: 'cs-card cs-side-card cs-sees', hidden: true }),
    character: h('section', { class: 'cs-card cs-character cs-open', hidden: true }),
    stories: h('section', { class: 'cs-card cs-story-card cs-open', hidden: true }),
    groups: h('section', { class: 'cs-card cs-groups-card' }),
    world: h('section', { class: 'cs-card cs-world-card' }),
  };
  const side = h('div', { class: 'cs-side' }, frame.pair, frame.sees);
  const head = h('span', { class: 'cs-head-right' });
  const title = pageHead('关系与故事', head);
  const half = svgNode('svg', { class: 'cs-defs', width: '0', height: '0', 'aria-hidden': 'true' });
  half.append(
    (() => {
      const defs = svgNode('defs');
      const clip = svgNode('clipPath', { id: 'cs-half' });
      clip.append(svgNode('rect', { x: '0', y: '0', width: '12', height: '24' }));
      defs.append(clip);
      return defs;
    })(),
  );
  const page = h(
    'div',
    { class: 'cs' },
    half,
    title,
    frame.versions,
    frame.confirm,
    frame.notice,
    frame.start,
    frame.importer,
    h('div', { class: 'cs-main' }, frame.grid, side),
    frame.character,
    frame.stories,
    frame.groups,
    frame.world,
  );
  const picker = h('input', {
    attrs: { type: 'file', accept: '.json,application/json', hidden: '', 'data-cast-file': '', tabindex: '-1' },
  });
  const body = [frame.grid, side, frame.groups, frame.world];
  root.append(page, picker);

  const reveal = (node: HTMLElement) => {
    const quiet = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    node.scrollIntoView?.({ behavior: quiet ? 'auto' : 'smooth', block: 'nearest' });
  };
  /** The grid is the workbench roster; a cast character the roster does not list is added after it. */
  const ids = () => {
    const doc = state.doc;
    const own = doc ? doc.characters.map((c) => c.characterId) : [];
    return [...new Set([...state.roster, ...own])];
  };
  const nameFor = (id: string) =>
    state.doc && state.doc.characters.some((c) => c.characterId === id)
      ? nameOf(state.doc, id)
      : (state.rosterNames.get(id) ?? id);
  const ctx: CastCtx = {
    doc: () => state.doc!,
    canEdit,
    edited: (soft = false) => {
      state.dirty = true;
      state.saveIssues = [];
      paint.bar();
      paint.notice();
      if (!soft) return;
    },
    paint: (...regions: Region[]) => {
      for (const region of regions) paint[region]();
    },
    openCharacter: (characterId) => openCharacter(characterId),
    reveal,
    colour: (id) => colourOf()(id),
    ids,
    nameOf: nameFor,
    base: () => state.base ?? state.doc!,
    openStory: (index) => {
      state.story = index;
      paint.stories();
      reveal(frame.stories);
    },
    light: () => grid.light(),
  };
  const colourOf = () =>
    rosterColours(state.roster.length ? state.roster : (state.doc?.characters ?? []).map((c) => c.characterId));

  // ---- the regions that share the grid's state ---------------------------------------------------------------------
  const view = state as typeof state & GridState & StoryState;
  const grid = castGrid(frame.grid, ctx, view);
  const pair = pairPanel(frame.pair, ctx, view);
  const card = nameCard(frame.character, ctx, () => state.sel);
  const stories = storyPanel(frame.stories, ctx, view);
  const groups = groupsPanel(frame.groups, ctx, view);
  const world = worldPanel(frame.world, ctx, view);

  const seesNow = () => {
    const show = !state.pair && !!state.sel;
    frame.sees.hidden = !show;
    if (!show) return;
    seesPanel(frame.sees, state.sees, {
      loading: state.seesLoading,
      failed: state.seesFailed,
      unsaved: !!state.sel && state.fresh.has(state.sel),
      stale: state.dirty,
      names: nameFor,
      storyTitle: (id) => state.doc?.stories.find((s) => s.id === id)?.title ?? '（已删除的故事）',
      selected: state.sel,
      limit: CAST_LIMITS.viewMax,
    });
  };
  const paintSide = () => {
    pair.paint();
    seesNow();
    side.hidden = frame.pair.hidden && frame.sees.hidden;
  };

  const paint: Record<Region, () => void> = {
    bar: () => paintBar(),
    versions: () => paintVersions(),
    notice: () => paintNotice(),
    start: () => paintStart(),
    grid: () => grid.paint(),
    side: paintSide,
    groups: () => groups.paint(),
    stories: () => stories.paint(),
    world: () => world.paint(),
    character: () => card.paint(),
    sees: seesNow,
  };
  const paintAll = () => {
    if (!state.doc) return;
    const none = ids().length === 0;
    frame.start.hidden = !none;
    paintImporter();
    for (const node of body) node.hidden = none;
    for (const region of Object.keys(paint) as Region[])
      if (!none || region === 'start' || region === 'bar' || region === 'versions' || region === 'notice')
        paint[region]();
  };

  // ---- the first step: only when there is no character at all --------------------------------------------------------
  function paintStart() {
    frame.start.replaceChildren();
    if (!state.doc || ids().length) return;
    frame.start.append(
      h('h2', { text: '还没有角色' }),
      h('p', {
        class: 'cs-hint',
        text: canEdit() ? '先在角色工作台建一个角色，或者导入一份阵容文件。' : '阵容里还没有角色（你只有查看权限）。',
      }),
    );
  }

  // ---- title row: the status line, 保存草稿 and the one solid 发布 -------------------------------------------------
  function paintBar() {
    head.replaceChildren();
    if (!state.doc || !state.base) return;
    const next = (state.latest ?? 0) + 1;
    const blocked = state.publishIssues.length > 0;
    const changes = changeCount(state.base, state.doc);
    const status = h('span', { class: 'head-status' });
    fillStatus(
      status,
      h('span', { class: 'is-mono', text: state.latest ? `线上 v${state.latest}` : '还没发布' }),
      h('span', { class: 'is-mono', text: `草稿 #${state.revision}` }),
      blocked
        ? h('span', {
            class: 'cs-tag is-bad',
            text: `${state.publishIssues.length} 个问题挡着发布`,
            attrs: { role: 'status' },
          })
        : h('span', {
            class: 'cs-tag is-ok',
            text: state.warnings ? `可以发布 · ${state.warnings} 条提醒` : '可以发布',
            attrs: { role: 'status' },
          }),
      state.dirty ? h('span', { class: 'is-warn', text: changes > 0 ? unsavedText(changes) : '有没保存的修改' }) : null,
    );
    head.append(status);
    if (canEdit()) {
      const save = h('button', { class: 'cs-save', text: '保存草稿', attrs: { type: 'button' } });
      lock(save, !state.dirty);
      save.addEventListener('click', () => void saveDraft(false));
      head.append(save);
    }
    if (canPublish()) {
      const publish = h('button', {
        class: 'admin-primary cs-primary cs-publish',
        text: `发布 v${next}`,
        attrs: { type: 'button' },
      });
      lock(publish, state.dirty || blocked || !state.doc.characters.length, state.dirty ? '先保存草稿' : undefined);
      hoverValue(publish, '这一页的全部内容一起发布成 v' + next);
      publish.addEventListener('click', () => void publishNow(next));
      head.append(publish);
    }
  }
  // ---- 整页版本: the published versions and the draft, on one line --------------------------------------------------
  function paintVersions() {
    frame.versions.replaceChildren();
    if (!state.doc) return;
    const label = hoverValue(
      h('span', { class: 'cs-versions-label', text: '整页版本' }),
      '关系、组合、故事、世界、名片一起，发布成一个版本',
    );
    const line = h('div', { class: 'cs-version-line' });
    const ordered = [...state.versions].sort((a, b) => a.version - b.version);
    ordered.forEach((v, index) => {
      const chip = h(
        'button',
        {
          class: 'cs-version',
          attrs: {
            type: 'button',
            'data-version': String(v.version),
            'aria-pressed': String(state.openVersion === v.version),
          },
        },
        h('i', { class: 'cs-version-mark' }),
        h('span', { class: 'cs-mono', text: `v${v.version}` }),
      );
      hoverValue(
        chip,
        `${dateTimeText(v.publishedAt)} · 角色 ${v.counts.characters} · 组合 ${v.counts.groups} · 故事 ${v.counts.stories}${v.kind === 'rollback' ? ` · 回滚自 v${v.fromVersion}` : ''}`,
      );
      chip.addEventListener('click', () => {
        state.openVersion = state.openVersion === v.version ? null : v.version;
        paintVersions();
      });
      line.append(chip, h('i', { class: 'cs-version-rule', attrs: { 'aria-hidden': 'true' } }));
      void index;
    });
    line.append(
      h(
        'span',
        {
          class: `cs-version is-draft${state.dirty ? ' is-dirty' : ''}`,
          attrs: { 'data-draft': String(state.revision) },
        },
        h('i', { class: 'cs-version-mark' }),
        h('span', { class: 'cs-mono', text: `草稿 #${state.revision}` }),
      ),
    );
    const actions = h('span', { class: 'cs-versions-actions' });
    if (canEdit() && state.serverEmpty && !state.dirty) {
      const legacy = h('button', { class: 'cs-quiet', text: '从旧资料导入', attrs: { type: 'button' } });
      legacy.addEventListener('click', () => void importOld());
      actions.append(legacy);
    }
    const exportButton = h('button', { class: 'cs-quiet', text: '导出文件', attrs: { type: 'button' } });
    exportButton.addEventListener('click', () => void exportNow());
    actions.append(exportButton);
    if (canEdit()) actions.append(fileButton());
    frame.versions.append(h('div', { class: 'cs-versions-row' }, label, line, actions));
    const open = state.versions.find((v) => v.version === state.openVersion);
    if (open)
      frame.versions.append(
        h(
          'div',
          { class: 'cs-version-open' },
          h('b', { class: 'cs-mono', text: `v${open.version}` }),
          h('span', {
            class: 'cs-version-sub',
            text: `${open.kind === 'rollback' ? `回滚自 v${open.fromVersion}` : '发布'} · ${dateTimeText(open.publishedAt)} · 角色 ${open.counts.characters} · 组合 ${open.counts.groups} · 故事 ${open.counts.stories}`,
          }),
          canPublish() && open.version !== state.latest ? rollbackButton(open.version) : null,
        ),
      );
  }
  function rollbackButton(version: number) {
    const back = h('button', {
      class: 'cs-quiet is-tint',
      text: `回滚到 v${version}`,
      attrs: { type: 'button', 'aria-label': `回滚到 v${version}（作为新版本发布）` },
    });
    back.addEventListener('click', () => void rollbackTo(version));
    return back;
  }
  function paintNotice() {
    frame.notice.replaceChildren();
    if (state.conflict) {
      const keep = h('button', { class: 'cs-danger', text: '用我的内容覆盖', attrs: { type: 'button' } });
      keep.addEventListener('click', () => {
        // Their revision becomes the base, so the next save is a normal compare-and-swap against what is there now.
        state.revision = state.conflict!.revision;
        state.conflict = null;
        paintNotice();
        void saveDraft(true);
      });
      const take = h('button', { class: 'cs-quiet', text: '放弃我的，载入最新', attrs: { type: 'button' } });
      take.addEventListener('click', () => {
        const next = state.conflict!;
        adopt(next.doc, next.revision);
        state.conflict = null;
        paintAll();
      });
      const box = h(
        'div',
        { class: 'cs-notice is-bad', attrs: { role: 'alert' } },
        h('span', { text: `草稿已被另一位管理员存成修订 ${state.conflict.revision}。你写的内容都还在下面。` }),
      );
      if (canEdit()) box.append(keep);
      box.append(take);
      frame.notice.append(box);
    }
    const issues = state.saveIssues.length ? state.saveIssues : state.publishIssues;
    if (issues.length && state.doc) {
      frame.notice.append(
        h(
          'div',
          { class: `cs-notice ${state.saveIssues.length ? 'is-bad' : 'is-warn'}`, attrs: { role: 'status' } },
          h('b', {
            text: state.saveIssues.length
              ? `没能保存：${issues.length} 个问题`
              : `发布前要先解决：${issues.length} 个问题`,
          }),
          issueBox(state.doc, issues),
        ),
      );
    }
  }

  // ---- data ---------------------------------------------------------------------------------------------------------
  /** A roster character with no cast entry yet shows empty; the entry is made here and goes to the server with the next save. */
  function ensureEntries(doc: CastDoc) {
    const have = new Set(doc.characters.map((c) => c.characterId));
    const added: string[] = [];
    for (const id of state.roster) {
      if (have.has(id)) continue;
      doc.characters.push(blankCharacter(id, state.rosterNames.get(id) ?? id));
      added.push(id);
    }
    return added;
  }
  function adopt(doc: CastDoc, revision: number) {
    state.serverEmpty =
      !doc.characters.length &&
      !doc.people.length &&
      !doc.groups.length &&
      !doc.stories.length &&
      !doc.memes.length &&
      !Object.keys(doc.ratings).length &&
      !doc.directions.length;
    state.doc = structuredClone(doc);
    const added = ensureEntries(state.doc);
    // The new entries are part of the baseline, so they are not "unsaved changes"; they are saved with the next save.
    state.base = structuredClone(state.doc);
    state.revision = revision;
    state.dirty = false;
    state.fresh = new Set(added);
    state.saveIssues = [];
    state.pending = null;
    const known = ids();
    if (state.sel && !known.includes(state.sel)) state.sel = null;
    if (state.pair && (!known.includes(state.pair[0]) || !known.includes(state.pair[1]))) state.pair = null;
    if (state.story !== null && !state.doc.stories[state.story]) state.story = null;
    if (state.person && !state.doc.people.some((p) => p.id === state.person)) state.person = null;
    state.group = null;
  }
  async function readAll() {
    const api = host.api!;
    const [draft, versions, validation] = await Promise.all([api.draft(), api.versions(), api.validate()]);
    return { draft, versions, validation };
  }
  async function readRoster() {
    if (!host.characters) return;
    // The colours and the grid follow 角色工作台's roster, so a character is the same dot on every page.
    try {
      const roster = await host.characters.list();
      if (gone()) return;
      state.roster = roster.characters.map((c) => c.characterId);
      state.rosterNames = new Map(roster.characters.map((c) => [c.characterId, c.displayName]));
    } catch {
      state.roster = [];
      state.rosterNames = new Map();
    }
  }
  async function load() {
    if (!host.api) return;
    const [{ draft, versions, validation }] = await Promise.all([readAll(), readRoster()]);
    if (gone()) return;
    state.versions = versions.versions;
    state.latest = versions.latest;
    state.publishIssues = validation.validation.errors;
    state.warnings = validation.validation.warnings.length;
    if (!state.doc || !state.dirty) adopt(draft.doc, draft.revision);
    else if (draft.revision !== state.revision) state.conflict = { revision: draft.revision, doc: draft.doc };
    paintAll();
    void refreshSees();
  }
  async function afterChange() {
    const { draft, versions, validation } = await readAll();
    if (gone()) return;
    state.versions = versions.versions;
    state.latest = versions.latest;
    state.publishIssues = validation.validation.errors;
    state.warnings = validation.validation.warnings.length;
    adopt(draft.doc, draft.revision);
    paintAll();
    void refreshSees();
  }
  async function refreshSees() {
    const api = host.api;
    const selected = state.sel;
    if (!api || !selected || !state.doc || state.pair) return;
    if (state.fresh.has(selected)) {
      state.sees = null;
      state.seesFailed = false;
      state.seesLoading = false;
      seesNow();
      return;
    }
    state.seesLoading = true;
    state.seesFailed = false;
    seesNow();
    try {
      const result = await api.compilePreview(selected, 'draft');
      if (gone() || state.sel !== selected) return;
      state.sees = result;
    } catch {
      if (gone() || state.sel !== selected) return;
      state.sees = null;
      state.seesFailed = true;
    }
    state.seesLoading = false;
    seesNow();
  }
  function openCharacter(characterId: string) {
    if (!state.doc) return;
    state.sel = characterId;
    state.pair = null;
    state.sees = null;
    for (const region of ['grid', 'side', 'groups', 'character'] as Region[]) paint[region]();
    ctx.reveal(frame.character);
    void refreshSees();
  }

  const requestFor = (revision: number, doc: CastDoc) => {
    const json = JSON.stringify(doc);
    // The same document at the same revision is the same request, so a lost answer can be retried without a second save.
    if (state.pending?.revision !== revision || state.pending.json !== json)
      state.pending = { revision, json, requestId: globalThis.crypto.randomUUID() };
    return state.pending.requestId;
  };
  async function saveDraft(force: boolean) {
    if (!host.api || !state.doc || !canEdit() || (!state.dirty && !force)) return;
    await host.run(async () => {
      const api = host.api!;
      const doc = state.doc!;
      try {
        await api.save(state.revision, doc, requestFor(state.revision, doc));
      } catch (error) {
        if (gone()) return;
        if (error instanceof InviteLocalApiError && error.code === 'CAST_REVISION_CONFLICT') {
          const latest = await api.draft();
          if (gone()) return;
          state.conflict = { revision: latest.revision, doc: latest.doc };
          paintNotice();
          return;
        }
        if (error instanceof InviteLocalApiError && error.code === 'CAST_INVALID') {
          state.saveIssues = castIssues(error);
          paintNotice();
          host.status('有些内容不符合要求，没有保存。');
          return;
        }
        throw error;
      }
      await afterChange();
      if (!gone()) host.toast(`草稿已保存（修订 ${state.revision}）`, 'ok');
    });
  }
  async function publishNow(version: number) {
    if (!host.api || !canPublish() || state.dirty) return;
    const yes = await host.confirm(
      {
        title: `发布 v${version}`,
        message: '把整份草稿发布为新版本。CAST_CONTEXT_ENABLED 打开之前，玩家聊天不会用到它。',
        confirmLabel: '发布',
      },
      frame.confirm,
    );
    if (!yes || gone()) return;
    await host.run(async () => {
      const result = await host.api!.publish(state.revision);
      await afterChange();
      if (!gone()) host.toast(`已发布 v${result.version}`, 'ok');
    });
  }
  async function rollbackTo(version: number) {
    if (!host.api || !canPublish()) return;
    const yes = await host.confirm(
      {
        title: `回滚到 v${version}`,
        message: `把 v${version} 的内容作为新版本重新发布；旧版本都保留。`,
        confirmLabel: '回滚',
      },
      frame.confirm,
    );
    if (!yes || gone()) return;
    await host.run(async () => {
      const result = await host.api!.rollback(version);
      await afterChange();
      if (!gone()) host.toast(`已回滚，发布为 v${result.version}`, 'ok');
    });
  }
  // ---- cast file: export, and import with a summary first ----------------------------------------------------------------
  function fileButton() {
    const button = h('button', { class: 'cs-quiet', text: '导入文件', attrs: { type: 'button' } });
    button.addEventListener('click', () => picker.click());
    return button;
  }
  picker.addEventListener('change', () => {
    const chosen = (picker as HTMLInputElement).files?.[0];
    (picker as HTMLInputElement).value = '';
    if (chosen) void chooseFile(chosen);
  });
  async function exportNow() {
    if (!host.api || !host.can('cast.read')) return;
    await host.run(async () => {
      const { revision, file } = await host.api!.exportFile();
      if (gone()) return;
      (host.download ?? browserDownload)(
        `burbur-cast-修订${revision}.json`,
        `${JSON.stringify(file, null, 2)}\n`,
        'application/json;charset=utf-8',
      );
      host.toast('已导出当前草稿（修订 ' + revision + '）。', 'ok');
    });
  }
  async function chooseFile(file: File) {
    if (!host.api || !canEdit()) return;
    if (state.dirty) {
      host.toast('先保存草稿，或放弃没保存的修改，再导入文件。', 'warn');
      return;
    }
    if (file.size > CAST_BODY_LIMIT - 4096) {
      host.toast('文件太大了：一份阵容文件不能超过 1,000,000 字节。', 'warn');
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      host.toast('这不是合法的 JSON 文件。', 'warn');
      return;
    }
    await host.run(async () => {
      const preview = await host.api!.importPreview(parsed);
      if (gone()) return;
      state.importing = { file: parsed, preview, requestId: globalThis.crypto.randomUUID() };
      paintImporter();
      ctx.reveal(frame.importer);
    });
  }
  function paintImporter() {
    frame.importer.replaceChildren();
    frame.importer.hidden = !state.importing;
    const pending = state.importing;
    if (!pending) return;
    const { preview } = pending;
    const summary = preview.summary;
    const names = (label: string, list: readonly string[]) =>
      list.length ? h('li', { text: `${label} ${list.length}：${list.join('、')}` }) : null;
    const lines = h('ul', { class: 'cs-import-summary' });
    if (summary) {
      if (summary.unchanged) lines.append(h('li', { text: '文件和现在的草稿完全一样，导入后不会有任何改动。' }));
      for (const row of [
        names('新增角色', summary.charactersAdded),
        names('改动的角色', summary.charactersChanged),
        names('从草稿里移除的角色', summary.charactersRemoved),
      ])
        if (row) lines.append(row);
      lines.append(
        h('li', {
          text: `人物 ${summary.people} · 星级 ${summary.ratings} 条 · 称呼与相处 ${summary.directions} 条 · 组合 ${summary.groups} · 故事 ${summary.stories} · 梗 ${summary.memes}`,
        }),
      );
      const fresh = preview.created.filter((c) => !c.matched).length;
      if (fresh) lines.append(h('li', { text: `会同时建立 ${fresh} 个角色草稿（还没有上线，暂时不能聊天）。` }));
    }
    const confirm = h('button', { class: 'cs-primary', text: '确认导入', attrs: { type: 'button' } });
    lock(confirm, !preview.importable || !canEdit(), !preview.importable ? '先解决上面的问题' : undefined);
    confirm.addEventListener('click', () => void confirmImport());
    const cancel = h('button', { class: 'cs-quiet', text: '取消', attrs: { type: 'button' } });
    cancel.addEventListener('click', () => {
      state.importing = null;
      paintImporter();
    });
    frame.importer.append(
      h('h2', { text: '导入文件' }),
      h('p', {
        class: 'cs-hint',
        text: '确认后，这份文件会替换整份阵容草稿（现在草稿里有、文件里没有的角色会被移出阵容，角色本身不会被删除）。只改草稿：不会发布，也不会动玩家的任何数据。',
      }),
      lines,
    );
    if (preview.problems.length)
      frame.importer.append(
        h('b', { text: `${preview.problems.length} 个问题，必须先改文件：` }),
        problemBox(preview.problems),
      );
    if (preview.publishBlockers.length)
      frame.importer.append(
        h('b', { text: `${preview.publishBlockers.length} 个问题不影响导入，但发布前要处理：` }),
        problemBox(preview.publishBlockers),
      );
    if (preview.warnings.length)
      frame.importer.append(h('b', { text: `${preview.warnings.length} 条提醒：` }), problemBox(preview.warnings));
    frame.importer.append(h('div', { class: 'cs-adder-row' }, confirm, cancel));
  }
  async function confirmImport() {
    const pending = state.importing;
    if (!pending || !host.api || !canEdit() || !pending.preview.importable) return;
    await host.run(async () => {
      try {
        const result = await host.api!.importFile(pending.preview.revision, pending.file, pending.requestId);
        if (gone()) return;
        state.importing = null;
        paintImporter();
        await load();
        if (!gone())
          host.toast(
            result.unchanged
              ? '文件和草稿一样，没有改动。'
              : `已导入到草稿（修订 ${result.revision}）${result.created ? `，并建立了 ${result.created} 个角色草稿` : ''}。还没有发布。`,
            'ok',
          );
      } catch (error) {
        if (error instanceof InviteLocalApiError && error.code === 'CAST_REVISION_CONFLICT') {
          state.importing = null;
          paintImporter();
          await load();
          host.toast('草稿在你选文件之后被改过了，这次没有导入。请重新选择文件。', 'warn');
          return;
        }
        if (error instanceof InviteLocalApiError && error.code === 'CAST_FILE_INVALID') {
          state.importing = { ...pending, preview: await host.api!.importPreview(pending.file) };
          paintImporter();
          host.toast('文件有问题，没有导入。', 'warn');
          return;
        }
        throw error;
      }
    });
  }
  async function importOld() {
    if (!host.api || !canEdit()) return;
    const yes = await host.confirm(
      {
        title: '从旧资料导入',
        message: '用已发布角色里的旧设定生成阵容草稿（草稿现在是空的）。不会改动任何角色。',
        confirmLabel: '导入',
      },
      frame.confirm,
    );
    if (!yes || gone()) return;
    await host.run(async () => {
      await host.api!.importLegacy(state.revision);
      await afterChange();
      if (!gone()) host.toast('已导入到草稿', 'ok');
    });
  }

  return {
    load,
    clear() {
      state.doc = null;
      state.dirty = false;
      state.conflict = null;
      state.sees = null;
      state.importing = null;
      for (const node of Object.values(frame)) node.replaceChildren();
      head.replaceChildren();
    },
    /** Unsaved edits block leaving the page the same way an unsaved character does. */
    canLeave: () => !state.dirty,
    dispose() {
      disposed = true;
      root.replaceChildren();
    },
    /** Test seam: the state the regions are drawn from. */
    state,
  };
}

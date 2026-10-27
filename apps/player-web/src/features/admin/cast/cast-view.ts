import { CAST_LIMITS, type CastDoc, type CastIssue } from '../../../../../../packages/contracts/web-cast.ts';
import type { CastAdminPermission } from '../../../../../../packages/contracts/web-admin-permissions.ts';
import {
  castIssues,
  type CastAdminClient,
  type CastCompilePreviewResult,
  type CastVersion,
} from '../../../services/cast-admin-api.ts';
import { InviteLocalApiError } from '../../../services/invite-local-api.ts';
import { h } from '../../cocreation/h.ts';
import type { ConfirmOptions } from '../ui/confirm-dialog.ts';
import { dateTimeText } from '../system-format.ts';
import { castGrid, pairPanel, type GridState } from './cast-grid.ts';
import { characterPanel, seesPanel } from './cast-character.ts';
import { ISSUE_LABEL, nameOf } from './cast-model.ts';
import { groupCards, groupPanel, storiesPanel, type StoryState } from './cast-stories.ts';
import { lock, type CastCtx, type Region } from './cast-ui.ts';
import { pageHead } from '../ui/page-head.ts';

export type CastViewHost = {
  api: CastAdminClient | null;
  can: (permission: CastAdminPermission) => boolean;
  run: (work: () => Promise<void>) => Promise<void>;
  status: (text: string) => void;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  toast: (text: string, tone?: 'ok' | 'info' | 'warn' | 'danger') => void;
  disposed: () => boolean;
};

const issueText = (issue: CastIssue) => `${ISSUE_LABEL[issue.code] ?? issue.code}（${issue.path}）`;
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
    revision: 0,
    dirty: false,
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
    pair: null as GridState['pair'],
    hover: null as GridState['hover'],
    sel: null as string | null,
    panel: 'pair' as StoryState['panel'],
    group: 0,
    story: null as number | null,
  };
  let disposed = false;
  const gone = () => disposed || host.disposed();
  const canEdit = () => host.can('cast.edit');
  const canPublish = () => host.can('cast.publish');

  const frame = {
    bar: h('section', { class: 'cs-bar', attrs: { 'aria-label': '发布阵容' } }),
    versions: h('section', { class: 'cs-versions', attrs: { 'aria-label': '已发布的版本' } }),
    notice: h('div', { class: 'cs-notices' }),
    grid: h('section', { class: 'cs-card cs-grid-card' }),
    side: h('section', { class: 'cs-card cs-side-card' }),
    groups: h('section', { class: 'cs-card' }),
    stories: h('section', { class: 'cs-card cs-stories' }),
    character: h('section', { class: 'cs-card cs-character' }),
    sees: h('section', { class: 'cs-card cs-sees' }),
  };
  const sidePair = h('div', { class: 'cs-side-pair' }),
    sideGroup = h('div', { class: 'cs-side-group' });
  frame.side.append(sidePair, sideGroup);
  const title = pageHead('关系与故事', h('span', { class: 'cs-mono cs-count' }));
  const page = h(
    'div',
    { class: 'cs' },
    title,
    frame.bar,
    frame.notice,
    frame.versions,
    h('div', { class: 'cs-main' }, frame.grid, frame.side),
    frame.groups,
    frame.stories,
    h('div', { class: 'cs-people' }, frame.character, frame.sees),
  );
  root.append(page);

  const reveal = (node: HTMLElement) => {
    const quiet = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    node.scrollIntoView?.({ behavior: quiet ? 'auto' : 'smooth', block: 'nearest' });
  };
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
  };

  // ---- the three panels that share the grid's state -----------------------------------------------------------------
  const view = state as typeof state & GridState & StoryState;
  const grid = castGrid(frame.grid, ctx, view);
  const pair = pairPanel(sidePair, ctx, view);
  const groupSide = groupPanel(sideGroup, ctx, view, host.confirm);
  const cards = groupCards(frame.groups, ctx, view);
  const stories = storiesPanel(frame.stories, ctx, view, host.confirm);
  const character = characterPanel(frame.character, ctx, () => state.sel);

  const seesNow = () =>
    seesPanel(frame.sees, state.sees, {
      loading: state.seesLoading,
      failed: state.seesFailed,
      stale: state.dirty,
      names: (id) => (state.doc ? nameOf(state.doc, id) : id),
      storyTitle: (id) => state.doc?.stories.find((s) => s.id === id)?.title ?? '（已删除的故事）',
      selected: state.sel,
      limit: CAST_LIMITS.viewMax,
    });

  const paint: Record<Region, () => void> = {
    bar: () => paintBar(),
    versions: () => paintVersions(),
    notice: () => paintNotice(),
    grid: () => grid.paint(),
    side: () => {
      pair.paint();
      groupSide.paint();
      sidePair.hidden = state.panel !== 'pair';
      sideGroup.hidden = state.panel !== 'group';
    },
    groups: () => cards.paint(),
    stories: () => stories.paint(),
    character: () => character.paint(),
    sees: seesNow,
  };
  const paintAll = () => {
    if (!state.doc) return;
    title.querySelector('.cs-count')!.textContent = `${state.doc.characters.length} 人`;
    for (const region of Object.keys(paint) as Region[]) paint[region]();
  };

  // ---- publish bar --------------------------------------------------------------------------------------------------
  function paintBar() {
    frame.bar.replaceChildren();
    if (!state.doc) return;
    const next = (state.latest ?? 0) + 1;
    const blocked = state.publishIssues.length > 0;
    frame.bar.append(
      h(
        'h2',
        { class: 'cs-bar-title' },
        '发布阵容 ',
        h('span', { class: 'cs-mono', text: `v${state.latest ?? 0} → v${next}` }),
      ),
      h('span', { class: 'cs-chip-static', text: `草稿 修订 ${state.revision}` }),
    );
    if (state.dirty) frame.bar.append(h('span', { class: 'cs-chip-static is-warn', text: '有没保存的修改' }));
    frame.bar.append(
      blocked
        ? h('span', {
            class: 'cs-chip-static is-bad',
            text: `${state.publishIssues.length} 个问题挡着发布`,
            attrs: { role: 'status' },
          })
        : h('span', {
            class: 'cs-chip-static is-ok',
            text: state.warnings ? `可以发布 · ${state.warnings} 条提醒` : '可以发布',
            attrs: { role: 'status' },
          }),
      h('span', { class: 'cs-spacer' }),
    );
    if (canEdit() && isEmptyDraft(state.doc) && !state.dirty) {
      const importLegacy = h('button', { class: 'cs-quiet', text: '从旧资料导入', attrs: { type: 'button' } });
      importLegacy.addEventListener('click', () => void importOld());
      frame.bar.append(importLegacy);
    }
    if (canEdit() && state.dirty) {
      const save = h('button', { class: 'cs-quiet', text: '保存草稿', attrs: { type: 'button' } });
      save.addEventListener('click', () => void saveDraft(false));
      frame.bar.append(save);
    }
    if (canPublish()) {
      const publish = h('button', { class: 'cs-primary cs-publish', text: `发布 v${next}`, attrs: { type: 'button' } });
      lock(publish, state.dirty || blocked || !state.doc.characters.length, state.dirty ? '先保存草稿' : undefined);
      publish.addEventListener('click', () => void publishNow(next));
      frame.bar.append(publish);
    }
  }
  function paintVersions() {
    frame.versions.replaceChildren();
    if (!state.versions.length) return;
    const list = h('ol', { class: 'cs-version-list' });
    for (const v of state.versions) {
      const item = h(
        'li',
        { class: 'cs-version', attrs: { 'data-version': String(v.version) } },
        h('b', { class: 'cs-mono', text: `v${v.version}` }),
        h('span', { text: v.kind === 'rollback' ? `回滚自 v${v.fromVersion}` : '发布' }),
        h('span', { class: 'cs-mono', text: dateTimeText(v.publishedAt) }),
        h('span', {
          class: 'cs-mono',
          text: `角色 ${v.counts.characters} · 组合 ${v.counts.groups} · 故事 ${v.counts.stories}`,
        }),
      );
      if (canPublish() && v.version !== state.latest) {
        const back = h('button', {
          class: 'cs-quiet',
          text: '回滚',
          attrs: { type: 'button', 'aria-label': `回滚到 v${v.version}（作为新版本发布）` },
        });
        back.addEventListener('click', () => void rollbackTo(v.version));
        item.append(back);
      }
      list.append(item);
    }
    frame.versions.append(list);
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
    if (issues.length) {
      frame.notice.append(
        h(
          'div',
          { class: `cs-notice ${state.saveIssues.length ? 'is-bad' : 'is-warn'}`, attrs: { role: 'status' } },
          h('b', { text: state.saveIssues.length ? '没能保存：' : '发布前要先解决：' }),
          h('ul', {}, ...issues.slice(0, 6).map((issue) => h('li', { text: issueText(issue) }))),
          issues.length > 6 ? h('span', { class: 'cs-mono', text: `还有 ${issues.length - 6} 条` }) : null,
        ),
      );
    }
  }

  // ---- data ---------------------------------------------------------------------------------------------------------
  function adopt(doc: CastDoc, revision: number) {
    state.doc = structuredClone(doc);
    state.revision = revision;
    state.dirty = false;
    state.saveIssues = [];
    state.pending = null;
    const ids = state.doc.characters.map((c) => c.characterId);
    if (!state.sel || !ids.includes(state.sel)) state.sel = ids[0] ?? null;
    if (!state.pair || !ids.includes(state.pair[0]) || !ids.includes(state.pair[1]))
      state.pair = ids.length > 1 ? [ids[0]!, ids[1]!] : null;
    if (state.group >= state.doc.groups.length) state.group = 0;
    if (state.panel === 'group' && !state.doc.groups.length) state.panel = 'pair';
    if (state.story !== null && !state.doc.stories[state.story]) state.story = null;
  }
  async function readAll() {
    const api = host.api!;
    const [draft, versions, validation] = await Promise.all([api.draft(), api.versions(), api.validate()]);
    return { draft, versions, validation };
  }
  async function load() {
    if (!host.api) return;
    const { draft, versions, validation } = await readAll();
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
    if (!api || !selected || !state.doc) return;
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
    const other = state.doc.characters.find((c) => c.characterId !== characterId)?.characterId;
    if (!state.pair || state.pair[0] !== characterId) state.pair = other ? [characterId, other] : null;
    state.panel = 'pair';
    state.sees = null;
    for (const region of ['grid', 'side', 'stories', 'character', 'sees'] as Region[]) paint[region]();
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
    const yes = await host.confirm({
      title: `发布 v${version}`,
      message: '把整份草稿发布为新版本。CAST_CONTEXT_ENABLED 打开之前，玩家聊天不会用到它。',
      confirmLabel: '发布',
    });
    if (!yes || gone()) return;
    await host.run(async () => {
      const result = await host.api!.publish(state.revision);
      await afterChange();
      if (!gone()) host.toast(`已发布 v${result.version}`, 'ok');
    });
  }
  async function rollbackTo(version: number) {
    if (!host.api || !canPublish()) return;
    const yes = await host.confirm({
      title: `回滚到 v${version}`,
      message: `把 v${version} 的内容作为新版本重新发布；旧版本都保留。`,
      confirmLabel: '回滚',
    });
    if (!yes || gone()) return;
    await host.run(async () => {
      const result = await host.api!.rollback(version);
      await afterChange();
      if (!gone()) host.toast(`已回滚，发布为 v${result.version}`, 'ok');
    });
  }
  async function importOld() {
    if (!host.api || !canEdit()) return;
    const yes = await host.confirm({
      title: '从旧资料导入',
      message: '用已发布角色里的旧设定生成阵容草稿（草稿现在是空的）。不会改动任何角色。',
      confirmLabel: '导入',
    });
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
      for (const node of Object.values(frame)) node.replaceChildren();
      sidePair.replaceChildren();
      sideGroup.replaceChildren();
      frame.side.append(sidePair, sideGroup);
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

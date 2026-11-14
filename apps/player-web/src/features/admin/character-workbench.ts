import type { AvatarHost } from './owner/avatar-field.ts';
import { InviteLocalApiError } from '../../services/invite-local-api.ts';
import { characterColour, setMainColour, setRoster } from './ui/character-colour.ts';
import type { AdminMember } from '../../services/account-admin-api.ts';
import type {
  CharacterAdminClient,
  CharacterDetail,
  CharacterProfile,
  DeletionStatus,
  Material,
  PreviewJob,
} from '../../services/character-admin-api.ts';
import {
  canCreateCharacter,
  hasCharacterPermission,
  type CharacterAdminAction,
} from '../../../../../packages/contracts/web-admin-permissions.ts';
import { dateTimeText } from './system-format.ts';
import { publishBlocker, slotLabel, slotState, type SlotState } from './publish-slots.ts';
import { sectionIndex, type IndexedSection } from './ui/section-index.ts';
import { versionHistory } from './history/version-history.ts';
import { draftHistory } from './history/draft-history.ts';
import { readableGroups, withoutIds } from './history/readable.ts';
import { dangerZone } from './ui/danger-zone.ts';
import { inlineConfirm } from './ui/inline-confirm.ts';
import { statusBadge } from './ui/status-badge.ts';
import { clipTakesPanel } from './clip-takes-panel.ts';
import { fillStatus } from './ui/page-head.ts';
import { hoverValue } from './ui/hover-value.ts';
import { diffSideBySide, type Piece } from './preview/diff.ts';
import { ERROR_SENTENCES } from './error-sentences.ts';
import { unsavedText } from './ui/unsaved.ts';
import { leaveDialog } from './ui/leave-dialog.ts';
import { sentenceOf } from './ui/error-line.ts';
import { formatRoute } from './shell/admin-router.ts';
import {
  AdminFormError,
  changedSections,
  characterForm,
  check,
  disclosure,
  el,
  emptyCharacter,
  field,
  isColourOnlyChange,
} from './character-form.ts';

type Host = {
  api: CharacterAdminClient;
  member: () => AdminMember | null;
  run: (work: () => Promise<void>) => Promise<void>;
  status: (text: string) => void;
  disposed: () => boolean;
  /** Status-poll interval for submitted previews; tests shorten it. */
  /** Unread (new) co-creation submissions per character, shown as a badge on the character's row. */
  badges?: () => Record<string, number>;
  /** The badge on a card is a link to the 共创收件箱 filtered to that character. */
  openInbox?: (characterId: string) => void;
  /**
   * `inline` (default): the role directory is this component's first view. `none` (the console, Part 24b-2): the shell draws the
   * role list beside the editor and opens a role with `open()`; the editor then shows what it can without a button
   * (folds open, comparisons and material lists loaded on open) and has no 返回 / 重新读取 buttons.
   */
  directory?: 'inline' | 'none';
  /** The roles this administrator may see, whenever `load()` read them (directory `none`). */
  onDirectory?: (roles: Awaited<ReturnType<CharacterAdminClient['list']>>['characters']) => void;
  /** Tells the shell which view is showing (the role id, or null for the directory) so it can keep the URL in step. */
  onView?: (id: string | null) => void;
  /** The console's title row (right side): the draft status chip and 预演后发布. Only with directory `none`. */
  headerHost?: HTMLElement;
  /** A role's 主色 changed (opened, saved, discarded): the rail paints again. */
  onColour?: () => void;
  /** The role's dot colour (the rail's), for the status line. */
  colourOf?: (characterId: string) => string | undefined;
  /** Where the paid 预演 lives: shown as the last section when the role may be previewed. */
  previewMount?: HTMLElement;
  canPreview?: (characterId: string) => boolean;
  /** Whether the role is 成长中 (seed), as the editor has it now: the rail's dashed ring follows. */
  onSeed?: (characterId: string, seed: boolean) => void;
  /** Where the leave dialog is drawn (default: the editor's own root). */
  modalParent?: () => HTMLElement;
  /** Part 24b-6c: the form holds (or no longer holds) unsaved changes. 预演 sends the SAVED draft, so its reason line follows. */
  onDirty?: (dirty: boolean) => void;
};
type Section = { id: string; label: string; nodes: HTMLElement[]; danger?: boolean };
const when = (ms: number) => dateTimeText(ms);
type Control = {
  node: HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
  locked: () => boolean;
  text?: () => string;
};
const sameDraft = (value: { draftRevision: number; profileHash: string }, detail: CharacterDetail) =>
  !!detail.draft && value.draftRevision === detail.draft.revision && value.profileHash === detail.draft.contentHash;
const previewLabel = (value: string) =>
  (({ queued: '排队中', generating: '运行中', succeeded: '已通过', failed: '失败' }) as Record<string, string>)[
    value
  ] ?? value;
// Part 24b-7: no id string in the comparison (welcome-line ids and the like are left out).
const stringify = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(withoutIds(value), null, 2));
export function characterAdminError(error: unknown): string | null {
  if (error instanceof AdminFormError) return error.message;
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  // Part 30b: the server names the slot (欢迎 N / 结束) and nothing else; the standing sentence puts it first.
  const slot = (error as { detail?: { slot?: unknown } } | null)?.detail?.slot;
  if (typeof slot === 'string' && /^(欢迎 \d{1,2}|结束)$/.test(slot)) {
    if (code === 'CLIP_SLOT_NOT_APPROVED') return `${slot} 还没批准。`;
    if (code === 'CLIP_TAKE_UNUSABLE') return `${slot} 的选用版本已失效，请重录或另选。`;
  }
  return ERROR_SENTENCES[code] ?? null;
}

/** All mutations are explicit buttons. No storage, implicit generation, or player-content queries; the only timer polls the status of previews this admin already submitted. */
/** The voice the form starts from: the server's (binding or derived), else the Fish id an import recorded (an older answer). */
/** Part 31 (25e): where the form uploads and reads the picture (absent while the server offers none). */
function avatarOf(
  host: Host,
  snapshot: CharacterDetail | null,
  colour: () => string | null,
  initial: () => string,
): AvatarHost | null {
  if (!snapshot?.avatar?.available) return null;
  const id = snapshot.characterId;
  return {
    characterId: id,
    fileHint: snapshot.profileMeta?.avatarFile ?? null,
    upload: (base64) => host.api.uploadAvatar(id, base64),
    read: (avatarId) => host.api.readAvatar(id, avatarId),
    colour,
    initial,
  };
}
function voiceOf(snapshot: CharacterDetail | null) {
  if (snapshot?.speech?.voice) return snapshot.speech.voice;
  const recorded = snapshot?.profileMeta?.voiceReferenceId;
  return snapshot && recorded
    ? {
        referenceId: recorded,
        profileId: (snapshot.profileMeta?.code ?? snapshot.characterId).toLowerCase(),
        version: 1,
        speed: 1,
        derived: true,
      }
    : null;
}
export function characterWorkbench(root: HTMLElement, host: Host) {
  /** Display names seen while the roster was listed or a role opened: the deletion record names a character, never shows its id. */
  const names = new Map<string, string>();
  let disposed = false,
    busy = false,
    dirty = false,
    id: string | null = null,
    detail: CharacterDetail | null = null;
  let editor: ReturnType<typeof characterForm> | null = null,
    controls: Control[] = [],
    view = 0;
  let protectedRows: Array<{ characterId: string; node: HTMLElement }> = [];
  // The console shows one section of the editor at a time; the one showing is kept across a save of the same role.
  let lastSection: { id: string; section: string } = { id: '', section: '' };
  let paintDirty: (() => void) | null = null;
  let saveCurrent: (() => Promise<boolean>) | null = null;
  let zones: Array<{ paint: () => void }> = [];
  /** The 发布 tab's summary of each slot's 选用 take follows the 声音 tab whenever it reads the slots. */
  let onTakes: ((value: Awaited<ReturnType<CharacterAdminClient['takes']>>) => void) | null = null;
  const urls = new Set<string>();
  const pending = new Map<string, { input: unknown; uncertain: boolean; send: () => Promise<unknown> }>();
  const live = new Map<string, PreviewJob>();
  let previewsChanged: (() => void) | null = null;
  const can = (action: CharacterAdminAction, target = id ?? '') => {
    const m = host.member();
    return !!m && (m.role === 'owner' || hasCharacterPermission(m.permissions, action, target));
  };
  const canCreate = () => {
    const m = host.member();
    return !!m && (m.role === 'owner' || canCreateCharacter(m.permissions));
  };
  const gone = () => disposed || host.disposed();
  const embedded = host.directory === 'none';
  /** A fold, open from the start in the console: nothing that can be shown waits behind a click. */
  const fold = (parent: HTMLElement, title: string) => {
    const section = disclosure(parent, title);
    if (embedded) section.open = true;
    return section;
  };
  const revokeAudio = () => {
    for (const url of urls) URL.revokeObjectURL(url);
    urls.clear();
  };
  let reportedDirty = false;
  /** Part 24b-6c: saves the open draft (the 预演 reason line's 保存草稿 link). Set by the editor view. */
  let saveHook: (() => void) | null = null;
  const sync = () => {
    if (gone()) return;
    if (reportedDirty !== dirty) {
      reportedDirty = dirty;
      host.onDirty?.(dirty);
    }
    editor?.setDisabled(busy || (detail ? !can('edit', id ?? '') : !canCreate()));
    for (const zone of zones) zone.paint();
    for (const c of controls) {
      if (c.text) c.node.textContent = c.text();
      const lock = c.locked();
      c.node.dataset.locked = String(lock);
      c.node.disabled = busy || lock;
    }
  };
  /** 草稿已在别处更新: a bar above the editor with 重新载入 (reads the newer draft; the edits on this page are given up). */
  const showConflict = (role: string) => {
    root.querySelector('.wb-conflict')?.remove();
    const bar = el('div'),
      reload = el('button', '重新载入');
    bar.className = 'wb-conflict';
    bar.setAttribute('role', 'alert');
    reload.type = 'button';
    reload.className = 'admin-secondary';
    reload.addEventListener('click', () => {
      if (busy) return;
      act(async () => {
        dirty = false;
        await open(role);
      });
    });
    bar.append(el('span', ERROR_SENTENCES.DRAFT_CONFLICT), reload);
    root.prepend(bar);
  };
  const setDirty = () => {
    // Only a real difference counts: an event that leaves every field as it was loaded (an opened draft, a value typed back) is not
    // an unsaved change, so a clean page never asks anything when it is left.
    if (!editor || editor.changed().length === 0) {
      if (dirty) {
        dirty = false;
        sync();
        paintDirty?.();
      }
      return;
    }
    const was = dirty;
    dirty = true;
    // In the console the save bar and the rail's dots say it; the message is for the first change only.
    if (!embedded || !was) host.status('有未保存修改。');
    sync();
    paintDirty?.();
  };
  const act = (work: () => Promise<void>) => {
    void host.run(async () => {
      if (gone()) return;

      await work();
    });
  };
  function button(
    parent: HTMLElement,
    text: string | (() => string),
    locked: () => boolean,
    work: () => Promise<void> | void,
    secondary = false,
  ) {
    const node = el('button', typeof text === 'function' ? text() : text);
    node.type = 'button';
    if (secondary) node.className = 'admin-secondary';
    parent.append(node);
    controls.push({ node, locked, ...(typeof text === 'function' ? { text } : {}) });
    node.addEventListener('click', () => {
      if (!busy && !locked())
        act(async () => {
          await work();
        });
    });
    return node;
  }
  function guarded<T extends HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
    node: T,
    locked: () => boolean,
  ) {
    controls.push({ node, locked });
    return node;
  }
  const historyViews: { dispose: () => void }[] = [];
  const clearView = () => {
    view++;
    for (const panel of historyViews.splice(0)) panel.dispose();
    revokeAudio();
    controls = [];
    protectedRows = [];
    editor = null;
    previewsChanged = null;
    paintDirty = null;
    onTakes = null;
    zones = [];
    host.headerHost?.replaceChildren();
    root.replaceChildren();
  };
  async function exact<I, T>(key: string, input: I, send: (input: I) => Promise<T>): Promise<T> {
    let command = pending.get(key);
    if (!command) {
      const fixed = structuredClone(input);
      command = { input: fixed, uncertain: false, send: () => send(fixed) };
      pending.set(key, command);
    }
    // An ambiguous response retains the exact body/request ID even if another role is opened.
    try {
      const result = await command.send();
      pending.delete(key);
      return result as T;
    } catch (error) {
      if (
        !command.uncertain &&
        error instanceof InviteLocalApiError &&
        error.status >= 400 &&
        error.status < 500 &&
        ![408, 429].includes(error.status) &&
        error.code !== 'IDEMPOTENCY_CONFLICT'
      )
        pending.delete(key);
      else {
        command.uncertain = true;
        host.status('结果未确认，原请求已保留；核对时不会另建 requestId。');
      }
      throw error;
    }
  }
  function deletionRow(parent: HTMLElement, job: DeletionStatus) {
    const row = el('section'),
      progress = el('p'),
      error = el('p');
    row.className = 'character-deletion-row';
    parent.append(row);
    protectedRows.push({ characterId: job.characterId, node: row });
    row.append(el('h3', names.get(job.characterId) ?? '已删除的角色'), progress, error);
    const show = (current: DeletionStatus) => {
      progress.textContent =
        current.state === 'deleted'
          ? '已完成'
          : current.errorCode
            ? '失败'
            : `清理中：数据库 ${current.databaseCleared}/${current.total}；音频 ${current.audioCleared}/${current.total}`;
      error.textContent = current.errorCode ? '清理暂未完成。原任务保留；刷新核对，不要重新删除或释放未知费用。' : '';
    };
    show(job);
    button(
      row,
      '刷新此删除进度',
      () => !can('read', job.characterId),
      async () => {
        const next = await host.api.deleteStatus(job.characterId);
        if (gone()) return;
        show(next);
      },
      true,
    );
  }
  async function list() {
    if (dirty) throw new AdminFormError('请先保存草稿，或放弃本页修改。');
    const current = ++view,
      result = await host.api.list();
    if (gone() || current !== view) return;
    for (const role of result.characters) names.set(role.characterId, role.displayName);
    setRoster(result.characters);
    clearView();
    id = null;
    detail = null;
    dirty = false;
    if (embedded) {
      host.onDirectory?.(result.characters);
      const note = el('p', '从左边选一个角色。');
      note.className = 'admin-empty';
      root.append(note);
      if (result.deletions.length) {
        const jobs = el('section');
        jobs.className = 'character-deletions';
        jobs.append(el('h3', '角色删除记录'));
        root.append(jobs);
        for (const job of result.deletions) deletionRow(jobs, job);
      }
      sync();
      host.onView?.(null);
      return;
    }
    root.append(el('h2', '角色工作台'));
    const tools = el('div');
    tools.className = 'admin-toolbar';
    root.append(tools);
    button(
      tools,
      '新建角色草稿',
      () => !canCreate(),
      () => openNew(),
    );
    if (!result.characters.length) root.append(el('p', '当前没有可查看的人物。请由主管理员勾选所需功能类别。'));
    const roles = el('div');
    roles.className = 'character-directory';
    root.append(roles);
    for (const c of result.characters) {
      const row = el('section');
      row.className = 'character-directory-row';
      roles.append(row);
      protectedRows.push({ characterId: c.characterId, node: row });
      const heading = el('h3', c.displayName),
        unread = host.badges?.()[c.characterId] ?? 0;
      if (unread > 0) {
        // Visible text, not just a tooltip; a real link (the address names the filtered inbox), opened in place on click.
        const badge = el('a', `${unread} 条新共创`);
        badge.className = 'cocreation-badge';
        badge.setAttribute('href', formatRoute({ page: 'cocreation', id: c.characterId }));
        badge.setAttribute('title', `共创收件箱里有 ${unread} 条新的玩家想法，点击查看`);
        badge.addEventListener('click', (event) => {
          if (!host.openInbox) return;
          event.preventDefault();
          event.stopPropagation();
          host.openInbox(c.characterId);
        });
        heading.append(badge);
      }
      row.append(
        heading,
        el(
          'p',
          `${c.characterId} · ${c.publishedVersion === null ? '未发布' : `正式 v${c.publishedVersion}`}${c.draftRevision === null ? '' : ` · 草稿修订 ${c.draftRevision}`}`,
        ),
      );
      button(
        row,
        '打开资料',
        () => !can('read', c.characterId),
        () => open(c.characterId),
        true,
      );
    }
    if (result.deletions.length) {
      const jobs = disclosure(root, '角色删除记录与清理进度');
      jobs.append(el('p', '最近100条可查看任务。已删除 ID 不能复用；账号、其他人物、额度历史和账务保留。'));
      for (const job of result.deletions) deletionRow(jobs, job);
    }
    sync();
    host.onView?.(null);
  }
  async function open(target: string) {
    if (dirty) throw new AdminFormError('请先保存草稿，或放弃本页修改。');
    const current = ++view,
      next = await host.api.detail(target);
    if (gone() || current !== view) return;
    id = target;
    detail = next;
    // The draft's colour when there is a draft, else the published one (what the admin list returns, too).
    const wore = characterColour(target);
    setMainColour(target, (next.draft ?? next.published)?.profile.presentation.color);
    if (characterColour(target) !== wore) host.onColour?.();
    const shownName = (next.published ?? next.draft)?.profile.presentation.displayName;
    if (shownName) names.set(target, shownName);
    renderDetail();

    host.onView?.(target);
  }
  function openNew() {
    id = '';
    detail = null;
    dirty = false;
    renderDetail();
    host.status('请填写空白角色工作台；保存后仍须预演与批准才能发布。');
  }
  function renderDetail() {
    clearView();
    dirty = false;
    const snapshot = detail,
      target = id!;
    const profile = snapshot
      ? structuredClone(snapshot.draft?.profile ?? snapshot.published!.profile)
      : emptyCharacter();
    if (snapshot && !snapshot.draft) profile.template.version = snapshot.published!.version + 1;
    const canEdit = () => (snapshot ? can('edit', target) : canCreate());
    /** Reads the form and saves it as a new draft revision. Resolves true only when the draft was saved (the page then shows it). */
    const saveDraft = async (): Promise<boolean> => {
      if (busy || !canEdit()) return false;
      let next;
      try {
        next = editor!.read();
      } catch (error) {
        host.status(characterAdminError(error) ?? '请核对资料字段。');
        return false;
      }
      const role = next.template.id;
      let saved_ = false;
      await host.run(async () => {
        if (gone()) return;
        if (!can('edit', role)) throw new AdminFormError('没有角色工作台管理权限，请联系主管理员。');
        let saved;
        try {
          saved = await host.api.save(role, snapshot?.draft?.revision ?? null, next);
        } catch (error) {
          // The draft moved on the server: the edits stay on the page, with a button that reads the newer draft instead. The bar
          // (an alert) says it; no toast repeats it.
          if (error instanceof InviteLocalApiError && error.code === 'DRAFT_CONFLICT') {
            showConflict(role);
            return;
          }
          throw error;
        }
        if (gone()) return;
        dirty = false;
        await open(saved.characterId);
        host.status(`草稿修订 ${saved.revision} 已保存；尚未发布。`);
        saved_ = true;
      });
      return saved_;
    };
    const submit = () => {
      void saveDraft();
    };
    saveCurrent = saveDraft;
    const discardLocal = () => {
      renderDetail();
      host.status('已放弃本页修改；服务器草稿和正式版本不变。');
    };
    if (embedded) {
      renderConsole(snapshot, target, profile, canEdit, submit, discardLocal);
      return;
    }
    const tools = el('div');
    tools.className = 'admin-toolbar';
    root.append(tools);
    button(tools, '返回人物目录', () => dirty, list, true);
    root.append(
      el('h2', snapshot ? profile.presentation.displayName : '新建角色草稿'),
      el(
        'p',
        snapshot
          ? `${target} · ${snapshot.published ? `正式 v${snapshot.published.version}` : '未发布'} · 编辑版本 v${profile.template.version}${snapshot.draft ? ` · 草稿修订 ${snapshot.draft.revision}` : ' · 尚无已保存草稿'}`
          : '从空白资料建立 AI 虚构人物，不复制其他角色的资料或声音。保存后仍不会出现在玩家目录。',
      ),
    );
    if (snapshot && !can('edit')) root.append(el('p', '当前只有被授予的操作可用；资料编辑只读。'));
    // A long page gets an index instead of one long scroll; it is filled in once the sections exist.
    const index = el('nav');
    index.className = 'admin-section-index';
    index.hidden = true;
    root.append(index);
    if (snapshot) for (const job of snapshot.previews) mergeLive(job);
    editor = characterForm(
      root,
      profile,
      !snapshot,
      setDirty,
      (e) => host.status(characterAdminError(e) ?? '请核对资料字段。'),
      undefined,
      voiceOf(snapshot),
      avatarOf(
        host,
        snapshot,
        () => profile.presentation.color ?? null,
        () => profile.presentation.displayName || profile.template.name,
      ),
    );
    // A new ID must be enterable before its scoped edit permission can be evaluated.
    const actions = el('div');
    actions.className = 'admin-toolbar';
    editor.form.append(actions);
    const save = el('button', '保存草稿');
    save.type = 'submit';
    actions.append(save);
    controls.push({ node: save, locked: () => !canEdit() });
    editor.form.addEventListener('submit', (event) => {
      event.preventDefault();
      submit();
    });
    button(actions, '放弃本页未保存修改', () => !dirty, discardLocal, true);
    if (snapshot) {
      button(
        actions,
        '重新读取资料',
        () => dirty,
        () => open(target),
        true,
      );
      const flow = el('section');
      flow.className = 'character-flow';
      root.append(flow);
      if (snapshot.draft) {
        profileDiff(flow, snapshot);
        materials(flow, snapshot);
      }
      publication(flow, snapshot);
      deletion(flow, snapshot);
      if (snapshot.draft) discardFold(flow, snapshot);
    }
    const sections: IndexedSection[] = [];
    for (const node of root.children as unknown as HTMLElement[]) {
      const tag = node.tagName.toLowerCase();
      if (tag === 'form') sections.push({ label: '资料表单', node });
      else if (node.className === 'character-flow')
        for (const part of node.children as unknown as HTMLElement[])
          if (part.tagName.toLowerCase() === 'details')
            sections.push({ label: part.children[0]?.textContent ?? '', node: part });
    }
    sectionIndex(index, sections);
    sync();
  }
  /**
   * Part 24j, 身份与展示: the 角色代码 (its own save: it is not part of the draft) and the checklist of what a profile import could
   * not place yet. The checklist stays until each item is dismissed or the next import no longer produces it.
   */
  function identityExtras(snapshot: CharacterDetail): HTMLElement | null {
    const meta = snapshot.profileMeta,
      target = snapshot.characterId;
    if (!meta?.available) return null;
    const wrap = el('div'),
      row = el('div'),
      list = el('div');
    wrap.className = 'wb-identity-extras';
    row.className = 'wb-code';
    list.className = 'wb-checklist';
    const label = el('label'),
      input = el('input'),
      save = el('button', '保存代码'),
      note = el('span');
    input.type = 'text';
    input.value = meta.code ?? '';
    input.placeholder = '如 SYZ';
    input.setAttribute('data-wb-code', '');
    input.maxLength = 12;
    input.setAttribute('aria-label', '角色代码');
    save.type = 'button';
    save.className = 'admin-secondary';
    note.className = 'wb-code-note';
    // The code is saved on its own: typing here must not mark the draft as changed.
    for (const type of ['input', 'change']) input.addEventListener(type, (event) => event.stopPropagation());
    label.append(el('span', '角色代码'), input);
    row.append(label, save, note);
    controls.push({ node: input, locked: () => !can('edit', target) });
    controls.push({ node: save, locked: () => !can('edit', target) });
    save.addEventListener('click', () => {
      if (busy || !can('edit', target)) return;
      act(async () => {
        try {
          const next = await host.api.saveCode(target, input.value.trim());
          if (gone()) return;
          snapshot.profileMeta = next;
          note.textContent = '已保存';
        } catch (error) {
          note.textContent = characterAdminError(error) ?? '没有保存。';
        }
      });
    });
    const paint = () => {
      list.replaceChildren();
      const open = (snapshot.profileMeta?.checklist ?? []).filter((item) => item.state === 'open');
      list.hidden = open.length === 0;
      if (!open.length) return;
      const ul = el('ul');
      for (const item of open) {
        const li = el('li'),
          done = el('button', '已处理');
        done.type = 'button';
        done.className = 'admin-secondary';
        done.addEventListener('click', () => {
          if (busy || !can('edit', target)) return;
          act(async () => {
            const next = await host.api.dismissChecklist(target, item.key);
            if (gone()) return;
            snapshot.profileMeta = next;
            paint();
          });
        });
        controls.push({ node: done, locked: () => !can('edit', target) });
        li.append(el('span', item.text), done);
        ul.append(li);
      }
      list.append(el('h5', '待办清单（导入时没能放进去的）'), ul);
    };
    paint();
    wrap.append(row, list);
    return wrap;
  }
  /** 只移除当前未发布草稿: its own fold, in the publish section of the console and after the deletion fold elsewhere. */
  function discardFold(parent: HTMLElement, snapshot: CharacterDetail) {
    const target = snapshot.characterId;
    const section = fold(parent, '放弃服务器草稿');
    section.className = 'admin-confirm';
    section.append(el('p', '只移除当前未发布草稿；正式版本和历史不变。与“放弃本页修改”不同。'));
    button(
      section,
      '确认放弃此修订草稿',
      () => dirty || !can('discard'),
      async () => {
        await host.api.discard(target, snapshot.draft!.revision);
        if (gone()) return;
        dirty = false;
        await list();
        host.status('服务器草稿已放弃，正式版本不变。');
      },
    );
  }
  /**
   * The console's editor (Part 24b-3, V3 in 24b-6): ONE section bar over one card; clicking a section pops it in and replaces the
   * one showing (300 ms). The sections stay in the page (only `hidden` changes), so what was typed in one survives a visit to another;
   * a dot on the section's name marks the ones with unsaved changes. The save bar sticks to the foot of the card; the title row
   * carries the name, a status line and 预演后发布, which jumps to 发布.
   */
  function renderConsole(
    snapshot: CharacterDetail | null,
    target: string,
    profile: CharacterProfile,
    canEdit: () => boolean,
    submit: () => void,
    discardLocal: () => void,
  ) {
    const card = el('section'),
      bar = el('nav'),
      body = el('div'),
      foot = el('footer'),
      state = el('span'),
      footActions = el('div');
    card.className = 'wb-card';
    bar.className = 'wb-bar';
    bar.setAttribute('aria-label', '角色分区');
    body.className = 'wb-card-body';
    foot.className = 'wb-savebar';
    state.className = 'wb-savestate';
    footActions.className = 'wb-savebar-actions';
    foot.append(state, footActions);
    card.append(bar, body, foot);
    if (snapshot && !can('edit')) {
      const note = el('p', '当前只有被授予的操作可用；资料编辑只读。');
      note.className = 'wb-readonly';
      body.append(note);
    }
    if (snapshot) for (const job of snapshot.previews) mergeLive(job);
    const showing: { show: (section: string) => void } = { show: () => {} };
    editor = characterForm(
      body,
      profile,
      !snapshot,
      setDirty,
      (e) => host.status(characterAdminError(e) ?? '请核对资料字段。'),
      (pane) => {
        if (pane) showing.show(pane);
      },
      voiceOf(snapshot),
      avatarOf(
        host,
        snapshot,
        () => profile.presentation.color ?? null,
        () => profile.presentation.displayName || profile.template.name,
      ),
    );
    const form = editor.form;
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      submit();
    });
    const discard = button(footActions, '放弃本页修改', () => !dirty, discardLocal, true);
    const save = el('button', '保存草稿');
    save.type = 'button';
    save.className = 'admin-secondary';
    footActions.append(save);
    controls.push({ node: save, locked: () => !canEdit() });
    save.addEventListener('click', () => submit());
    saveHook = () => {
      if (!save.disabled) save.click();
    };

    // ---- the sections: the form's seven, then what only a saved role has ----
    const sections: Section[] = editor.panes.map((pane) => ({ id: pane.id, label: pane.label, nodes: [pane.node] }));
    if (snapshot) {
      const flow = el('section');
      flow.className = 'character-flow';
      body.append(flow);
      // Part 24j: the 角色代码 and the checklist belong to 身份与展示 (shown and hidden with it) but are not fields of the draft.
      const extras = identityExtras(snapshot);
      if (extras) {
        // Not inside .character-flow: that holds what only a saved role has (资料改动, 发布, 声音成品…), and 身份与展示 shows none of it.
        body.append(extras);
        sections.find((section) => section.id === 'identity')!.nodes.push(extras);
      }
      // What a builder appended to the flow, so it can be shown and hidden as one section.
      const made = (build: () => void) => {
        const before = new Set(Array.from(flow.children));
        build();
        return (Array.from(flow.children) as unknown as HTMLElement[]).filter((node) => !before.has(node));
      };
      if (snapshot.draft) {
        const changes = made(() => {
          // Part 24b-7: who last changed each group (above the comparison), the comparison, then 草稿记录 (below it).
          const record = draftRecord(snapshot);
          if (record) flow.append(record.groups);
          profileDiff(flow, snapshot);
          if (record) fold(flow, '草稿记录').append(record.root);
        });
        sections.find((section) => section.id === 'voice')!.nodes.push(...made(() => materials(flow, snapshot)));
        sections.push({ id: 'diff', label: '资料改动', nodes: changes });
      }
      // Part 24l: 下线 / 重新上线 sits first on the 发布 tab, next to the live version (the owner's buttons; others see the state).
      const publish = [...made(() => availability(flow, snapshot)), ...made(() => publication(flow, snapshot))];
      const danger = el('div');
      danger.className = 'wb-danger';
      if (snapshot.draft) danger.append(discardZone(snapshot));
      // Part 24f: deleting is the owner's alone; for anyone else the danger zone has no 删除角色 at all.
      if (snapshot.published && can('delete'))
        danger.append(deleteZone(snapshot, profile.presentation.displayName || target));
      if (danger.children.length) {
        flow.append(danger);
        publish.push(danger);
      }
      sections.push({ id: 'publish', label: '发布', nodes: publish });
      // Part 24f: 版本历史 is one more entry of the section bar, after 发布 (and before 预演).
      const past = made(() => historyPanel(flow, snapshot));
      if (past.length) sections.push({ id: 'history', label: '版本历史', nodes: past });
      if (host.previewMount && host.canPreview?.(target)) {
        const wrap = el('div');
        wrap.className = 'wb-preview-section';
        wrap.append(host.previewMount);
        body.append(wrap);
        sections.push({ id: 'preview', label: '预演', nodes: [wrap] });
      }
    }
    // Part 24b-7b: tables, comparisons and 预演 use the card's whole width; every form keeps the one reading column.
    for (const section of sections)
      if (['diff', 'history', 'preview'].includes(section.id))
        for (const node of section.nodes) node.className = `${node.className} wb-wide`.trim();
    for (const section of sections)
      if (section.nodes.length === 1) section.nodes[0]!.className = `${section.nodes[0]!.className} wb-sole`.trim();

    // ---- the section bar ----
    const tabs = new Map<string, HTMLElement>(),
      dots = new Map<string, HTMLElement>();
    for (const section of sections) {
      const tab = el('button'),
        dot = el('i');
      tab.type = 'button';
      tab.className = 'wb-tab';
      tab.append(el('span', section.label), dot);
      dot.className = 'wb-dot';
      dot.hidden = true;
      dot.setAttribute('aria-hidden', 'true');
      tab.addEventListener('click', () => showing.show(section.id));
      bar.append(tab);
      tabs.set(section.id, tab);
      dots.set(section.id, dot);
    }

    // ---- the title row: the name alone, a status line, 预演后发布 ----
    const name = profile.presentation.displayName || target || '新角色';
    host.onSeed?.(target, profile.template.seed === true);
    const line = el('span'),
      publishLink = el('button', '预演后发布');
    line.className = 'head-status';
    publishLink.type = 'button';
    publishLink.className = 'admin-primary';
    // 预演后发布 goes to the preview column with its box focused (the publish step is one tab further, once a preview passed).
    publishLink.addEventListener('click', () => {
      if (sections.some((section) => section.id === 'preview')) {
        showing.show('preview');
        host.previewMount?.dispatchEvent(new CustomEvent('pw-focus'));
      } else showing.show('publish');
    });
    host.headerHost?.append(line, publishLink);
    const meta = snapshot
      ? `${snapshot.published ? `正式 v${snapshot.published.version}` : '未发布'}${snapshot.draft ? ` · 草稿修订 ${snapshot.draft.revision}` : ''}`
      : '新角色';
    // Workbench4: the title row says 角色工作台 like every page; the role (dot, name) is the first part of the status line.
    const who = el('span');
    who.className = 'wb-who';
    const whoDot = el('i');
    whoDot.style?.setProperty('--dot', host.colourOf?.(target) ?? profile.presentation.color ?? '#8c8697');
    who.append(whoDot, el('strong', name));
    let current = '';
    const paint = () => {
      const changed = new Set(editor?.changed() ?? []);
      for (const [section, dot] of dots) dot.hidden = !changed.has(section);
      const unsaved = Math.max(changed.size, dirty ? 1 : 0);
      state.textContent = dirty ? unsavedText(unsaved) : snapshot?.draft ? '草稿已保存' : '';
      state.dataset.state = dirty ? 'dirty' : 'saved';
      discard.hidden = !dirty;
      const drafted = snapshot?.draft
        ? changedSections(snapshot.published?.profile ?? null, snapshot.draft.profile).length
        : 0;
      const seed = editor?.seed() ?? profile.template.seed === true;
      const tag = seed ? el('span', '成长中') : null;
      if (tag) {
        tag.className = 'wb-seed';
        tag.title = '设定还少：不编细节，多问玩家';
      }
      const unsavedPart = el('b', unsavedText(unsaved));
      unsavedPart.className = 'wb-unsaved';
      fillStatus(
        line,
        who,
        tag,
        meta,
        dirty ? unsavedPart : drafted ? `草稿有 ${drafted} 处改动` : snapshot?.draft ? '草稿与正式版一致' : null,
      );
      publishLink.hidden = !snapshot?.draft || !can('publish') || current === 'publish';
      host.onSeed?.(target, seed);
    };
    paintDirty = paint;
    showing.show = (sectionId: string) => {
      if (!sections.some((section) => section.id === sectionId)) return;
      const changedSection = current !== sectionId;
      current = sectionId;
      lastSection = { id: target, section: sectionId };
      for (const section of sections) {
        const on = section.id === sectionId;
        for (const node of section.nodes) {
          node.hidden = !on;
          // The section that comes in pops in (300 ms, CSS); the class is dropped first so a second visit plays again.
          node.dataset.pop = on && changedSection ? 'in' : 'idle';
        }
        tabs.get(section.id)!.setAttribute('aria-current', String(on));
      }
      paint();
    };
    showing.show(
      lastSection.id === target && sections.some((section) => section.id === lastSection.section)
        ? lastSection.section
        : sections[0]!.id,
    );
    root.append(card);
    sync();
  }
  /** 放弃服务器草稿: a small danger zone (one confirm button) at the foot of 发布. */
  function discardZone(snapshot: CharacterDetail) {
    const target = snapshot.characterId;
    const zone = dangerZone({
      open: '放弃服务器草稿',
      openerId: 'wb-discard',
      impact: () => [
        { n: String(snapshot.draft!.revision), label: '草稿修订' },
        {
          n: String(changedSections(snapshot.published?.profile ?? null, snapshot.draft!.profile).length),
          label: '处改动',
        },
      ],
      confirm: '确认放弃此修订草稿',
      busy: () => busy || dirty || !can('discard'),
      run: async () => {
        await host.api.discard(target, snapshot.draft!.revision);
        if (gone()) return;
        dirty = false;
        await list();
        host.status('服务器草稿已放弃，正式版本不变。');
      },
    });
    zones.push(zone);
    return zone.root;
  }
  /** 删除角色: impact numbers, the typed name, then a 1.5 s hold. The preview hash and the idempotent request are the old flow's. */
  function deleteZone(snapshot: CharacterDetail, displayName: string) {
    const target = snapshot.characterId,
      key = `delete:${target}`;
    let impact: Awaited<ReturnType<CharacterAdminClient['deletePreview']>> | null = null;
    const zone = dangerZone({
      open: '删除角色',
      openerId: 'wb-delete',
      typeName: displayName,
      typeLabel: `输入 ${displayName} 确认`,
      impact: async () => {
        const token = view;
        impact = await host.api.deletePreview(target);
        if (gone() || token !== view) return [];
        return [
          { n: String(impact.conversations), label: '个私人会话' },
          { n: String(impact.messages), label: '条消息' },
          { n: String(impact.pendingOperations), label: '个未终结任务' },
        ];
      },
      confirm: '永久删除',
      busy: () => busy || dirty || !can('delete'),
      run: async () => {
        if (!impact && !pending.has(key)) return;
        const result = await exact(
          key,
          { requestId: crypto.randomUUID(), previewHash: impact?.previewHash ?? '', acknowledgeDeleteAllChats: true },
          (input) => host.api.deleteStart(target, input),
        );
        if (gone()) return;
        dirty = false;
        await list();
        host.status('删除已开始，进度见下方删除记录。');
      },
    });
    zones.push(zone);
    return zone.root;
  }
  /**
   * 草稿记录 (Part 24b-7): read when the draft opens. 恢复到这一稿 never publishes: it saves that revision's profile as the NEXT draft
   * revision with the ordinary compare-and-swap save. With unsaved changes on the page it asks the existing question first.
   */
  function draftRecord(snapshot: CharacterDetail) {
    if (!embedded || !can('read')) return null;
    const role = snapshot.characterId;
    const record = draftHistory({
      api: host.api,
      canRestore: () => can('edit', role),
      disposed: gone,
      errorText: characterAdminError,
      restore: async (profile, revision) => {
        if (busy || !can('edit', role)) return;
        if (!(await confirmLeave())) return;
        // The draft may have been re-read (a save, or the dropped edits): the revision to swap against is the current one.
        const expected = detail?.draft?.revision ?? null;
        await host.run(async () => {
          if (gone()) return;
          let saved;
          try {
            saved = await host.api.save(role, expected, structuredClone(profile));
          } catch (error) {
            if (error instanceof InviteLocalApiError && error.code === 'DRAFT_CONFLICT') {
              showConflict(role);
              return;
            }
            throw error;
          }
          if (gone()) return;
          dirty = false;
          await open(saved.characterId);
          host.status(`草稿已恢复到修订 ${revision} 的内容，保存为修订 ${saved.revision}；没有发布。`);
        });
      },
    });
    const read = () =>
      record.load(role).catch((error) => host.status(characterAdminError(error) ?? '草稿记录没有读取成功。'));
    void read();
    return record;
  }
  function profileDiff(parent: HTMLElement, snapshot: CharacterDetail) {
    const section = fold(parent, '查看资料改动（不调用供应商）'),
      output = el('div');
    section.append(output);
    const compare = async () => {
      const token = view,
        result = await host.api.profilePreview(snapshot.characterId, snapshot.draft!.revision);
      if (gone() || token !== view) return;
      output.replaceChildren();
      // Part 24b-7b: the readable field form of 24f (label, old → new, list items as lines, no ids), never the profile as JSON.
      const groups: [string, unknown, unknown][] = readableGroups(result.published ?? null, result.draft.profile);
      for (const [name, before, after] of groups) {
        if (JSON.stringify(before) === JSON.stringify(after)) continue;
        const group = fold(output, name),
          grid = el('div');
        grid.className = 'pd-grid';
        // A text is compared as it is; anything else line by line in its readable (indented) form.
        const text = (value: unknown) => (value === undefined ? '' : stringify(value));
        const head = el('div');
        head.className = 'pd-row pd-head';
        const l = el('span', '正式'),
          r = el('span', '草稿');
        l.className = 'pd-cell pd-left';
        r.className = 'pd-cell pd-right';
        head.append(l, r);
        grid.append(head);
        const side = (cell: HTMLElement, pieces: Piece[] | null) => {
          if (pieces === null) {
            cell.className = `${cell.className} pd-empty`;
            return;
          }
          for (const piece of pieces) {
            if (piece.kind === 'same') cell.append(piece.text);
            else {
              const mark = el('span', piece.text);
              mark.className = piece.kind === 'del' ? 'pd-del' : 'pd-add';
              cell.append(mark);
            }
          }
        };
        if (before === undefined) {
          const row = el('div');
          row.className = 'pd-row';
          const left = el('span', '尚无正式版本'),
            right = el('span');
          left.className = 'pd-cell pd-left pd-empty';
          right.className = 'pd-cell pd-right';
          side(right, [{ kind: 'add', text: text(after) }]);
          row.append(left, right);
          grid.append(row);
        } else
          for (const diffRow of diffSideBySide(text(before), text(after))) {
            const row = el('div');
            row.className = 'pd-row';
            const left = el('span'),
              right = el('span');
            left.className = 'pd-cell pd-left';
            right.className = 'pd-cell pd-right';
            side(left, diffRow.left);
            side(right, diffRow.right);
            row.append(left, right);
            grid.append(row);
          }
        group.append(grid);
      }
      if (!output.childElementCount) output.append(el('p', '没有资料差异。'));
      if (!embedded) host.status('静态资料比较完成；这不是付费预演或发布审核证明。');
    };
    // In the console the comparison is simply there when the draft opens; elsewhere it is one explicit click.
    if (embedded) void compare().catch((error) => host.status(characterAdminError(error) ?? '资料比较没有完成。'));
    else button(section, '比较已存草稿与正式资料', () => dirty || !can('read'), compare, true);
  }
  const jobsOf = (characterId: string) => [...live.values()].filter((j) => j.characterId === characterId);
  function mergeLive(job: PreviewJob) {
    const old = live.get(job.previewId);
    live.set(job.previewId, {
      ...(old?.input !== undefined ? { input: old.input } : {}),
      ...(old?.createdAt !== undefined ? { createdAt: old.createdAt } : {}),
      ...job,
    });
  }
  /**
   * Part 30: the 声音 tab. One slot per welcome line (and the footer while it is required), several takes per slot, one 选用 take
   * and one approval per slot. There is no 素材版本 on the screen: the bundle a publication stands on is made from the approved
   * takes when 发布 asks for it. The panel itself lives in clip-takes-panel.ts; this hands it the console's helpers.
   */
  function materials(parent: HTMLElement, snapshot: CharacterDetail) {
    const section = fold(parent, '声音成品'),
      target = snapshot.characterId,
      output = el('div');
    output.className = 'vc-materials';
    section.append(output);
    const panel = clipTakesPanel(output, {
      api: host.api,
      target,
      dirty: () => dirty,
      can: (action) => can(action),
      gone,
      view: () => view,
      button,
      guard: guarded,
      act,
      exact,
      release: (container) => {
        controls = controls.filter((c) => !container.contains(c.node));
        zones = zones.filter((z) => !('node' in z) || !container.contains((z as { node: HTMLElement }).node));
      },
      paint: (zone) => zones.push(zone),
      sync,
      status: (text) => host.status(text),
      changed: (value) => onTakes?.(value),
      urls,
    });
    const show = () => panel.load().catch((error) => host.status(characterAdminError(error) ?? '成品没有读取成功。'));
    if (embedded) void show();
    else
      button(
        section,
        '读取成品',
        () => dirty || !can('read'),
        () => show(),
        true,
      );
  }
  /** The roster read again after 下线 / 重新上线: the sidebar groups follow the server. */
  async function refreshRoster() {
    const result = await host.api.list();
    if (gone()) return;
    for (const role of result.characters) names.set(role.characterId, role.displayName);
    setRoster(result.characters);
    host.onDirectory?.(result.characters);
  }
  /**
   * Part 24l: 现行版本 and whether it is on the home page. The owner alone has 下线 / 重新上线 (each asks first, in place); every other
   * administrator sees the state and no button. 下线 removes only the home page entry: chats, memory and every version stay.
   */
  function availability(parent: HTMLElement, snapshot: CharacterDetail) {
    const live = snapshot.published;
    if (!live) return;
    const target = snapshot.characterId,
      online = snapshot.online !== false,
      name = live.profile.presentation.displayName || target;
    const row = el('div');
    row.className = 'wb-avail';
    row.dataset.state = online ? 'online' : 'offline';
    const version = el('span', `现行 v${live.version}`);
    version.className = 'wb-avail-v';
    row.append(version, statusBadge(online ? '在线' : '已下线', online ? 'ok' : 'warn'));
    parent.append(row);
    if (host.member()?.role !== 'owner') return;
    const action = online ? 'offline' : 'online',
      key = `${action}:${target}`;
    const confirmHost = el('div');
    confirmHost.className = 'wb-avail-confirm';
    const toggle = el('button', online ? '下线' : '重新上线');
    toggle.type = 'button';
    toggle.className = online ? 'admin-secondary wb-avail-go is-off' : 'admin-primary wb-avail-go';
    controls.push({ node: toggle, locked: () => dirty });
    toggle.addEventListener('click', async () => {
      if (busy || dirty || gone()) return;
      // While the question is open it is the only 下线 / 重新上线 on the tab: the original button steps aside.
      toggle.hidden = true;
      const ok = await inlineConfirm(confirmHost, {
        title: online ? `下线 ${name}` : `重新上线 ${name}`,
        message: online
          ? `${name} 会从玩家首页消失，不能再发新消息。聊天和记忆都保留。`
          : `${name} 以 v${live.version} 回到玩家首页。原来的聊天和记忆都在。`,
        confirmLabel: online ? '下线' : '重新上线',
      });
      toggle.hidden = false;
      if (!ok || gone()) return;
      act(async () => {
        await exact(key, { requestId: crypto.randomUUID(), liveVersion: live.version }, (input) =>
          host.api.setAvailability(target, action, input),
        );
        if (gone()) return;
        await Promise.all([open(target), refreshRoster()]);
        host.status(online ? `${name} 已下线。` : `${name} 已重新上线。`);
      });
    });
    row.append(toggle);
    parent.append(confirmHost);
  }
  function publication(parent: HTMLElement, snapshot: CharacterDetail) {
    const section = fold(parent, '发布角色版本'),
      target = snapshot.characterId,
      key = `publish:${target}`,
      saved = snapshot.draft;
    // Part 24l: publishing never brings a character back; 重新上线 is the owner's own action, above.
    if (snapshot.published && snapshot.online === false) {
      section.append(el('p', '已下线。先重新上线，才能发布这份草稿。'));
      return;
    }
    const publishNote =
      '发布会将已存资料和批准成品提供给玩家。不会自动生成审核或声音；在途玩家任务／未知调用不被取消或重发。';
    const previews = () =>
      jobsOf(target)
        .filter((p) => p.status === 'succeeded' && sameDraft(p, snapshot))
        .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    if (!saved && !pending.has(key)) {
      section.append(el('p', '当前没有未发布草稿。'));
      return;
    }
    // A draft that differs from the published profile in the main colour only needs no 预演 (the server checks the same thing).
    const colourOnly = !!saved && isColourOnlyChange(snapshot.published?.profile ?? null, saved.profile);
    const label = el('label'),
      preview = el('select');
    label.append(el('span', '已查看且匹配当前草稿的预演'), preview);
    label.hidden = colourOnly;
    section.append(label);
    // Round 2: the reason a disabled 确认发布此版本 gives sits beside the button (one row), not a sentence further up the page.
    const noProof = el('span', '尚无匹配当前草稿的成功预演，不能发布。');
    noProof.className = 'wb-reason';
    const fillPreviews = () => {
      const keep = preview.value;
      preview.replaceChildren();
      for (const job of previews()) {
        // time and result; the id is only the value
        const option = el(
          'option',
          `${job.createdAt === undefined ? '时间未知' : when(job.createdAt)} · ${previewLabel(job.status)}`,
        );
        option.value = job.previewId;
        preview.append(option);
      }
      // an empty list says so in the box itself (it was a blank select)
      if (!previews().length) {
        const none = el('option', colourOnly ? '不需要预演' : '尚无匹配当前草稿的成功预演');
        none.value = '';
        preview.append(none);
      }
      if (keep && previews().some((p) => p.previewId === keep)) preview.value = keep;
      noProof.textContent = colourOnly
        ? '只改了主色，不需要预演，可以直接发布。'
        : !previews().length && !pending.has(key)
          ? '尚无匹配当前草稿的成功预演，不能发布。'
          : '';
    };
    fillPreviews();
    previewsChanged = fillPreviews;
    // Part 30: what the publication uses, read from the slots: each welcome line's 选用 take, and the footer only while it exists.
    const used = el('div');
    used.className = 'vc-used';
    used.hidden = colourOnly;
    section.append(used);
    let clips: Awaited<ReturnType<CharacterAdminClient['takes']>> | null = null;
    const paintUsed = () => {
      used.replaceChildren();
      if (!clips) return;
      // plain text: 「label: take name」 (empty when the slot has no 选用 take)
      const row = (label: string, value: string, footer: boolean, state: SlotState) => {
        const line = el('div');
        line.className = 'vc-used-row';
        line.dataset.state = state;
        const k = el('span', `${label}：`),
          v = el('span', state === 'approved' ? value : value ? `${value} · 未批准` : '未批准');
        k.className = 'vc-k';
        v.className = 'vc-used-name';
        v.dataset.used = footer ? 'footer' : 'line';
        line.append(k, v);
        used.append(line);
      };
      clips.slots.forEach((slot, index) => {
        const take = slot.takes.find((item) => item.takeId === slot.selectedTakeId);
        row(slotLabel(clips!.slots, index), take?.name ?? '', slot.kind === 'footer', slotState(slot));
      });
    };
    onTakes = (value) => {
      clips = value;
      paintUsed();
    };
    const loadUsed = async () => {
      const token = view;
      const value = await host.api.takes(target);
      if (gone() || token !== view) return;
      clips = value;
      paintUsed();
    };
    if (embedded) {
      if (!colourOnly)
        void loadUsed().catch((error) => host.status(characterAdminError(error) ?? '成品没有读取成功。'));
    } else button(section, '读取所选成品', () => dirty || !can('read'), loadUsed, true);
    const ack = check(
      section,
      colourOnly ? '我已核对主色，确认将本版本发布给玩家' : '我已查看资料差异和该预演结果，确认将本版本发布给玩家',
    );
    // The sentence about what publishing does is the hover tip of the confirmation line.
    // Part 24b-7c: the line shows a short label; the whole sentence stays the label's text (its accessible name) and the hover tip.
    ack.nextElementSibling?.setAttribute?.('data-short', colourOnly ? '已核对主色' : '已核对差异与预演');
    if (ack.parentElement)
      hoverValue(ack.parentElement as HTMLElement, `${ack.nextElementSibling?.textContent ?? ''}。${publishNote}`);
    for (const input of [preview, ack]) guarded(input, () => dirty || pending.has(key) || !can('publish'));
    const publishRow = el('div');
    publishRow.className = 'wb-publish-row';
    section.append(publishRow);
    const confirmPublish = button(
      publishRow,
      () => (pending.has(key) ? '按原请求核对发布回执' : '确认发布此版本'),
      () =>
        dirty ||
        !can('publish') ||
        (!pending.has(key) &&
          (!saved || !ack.checked || !(colourOnly || previews().some((p) => p.previewId === preview.value)))),
      async () => {
        // Part 30b: anything but a colour-only change publishes with a bundle made from the approved 选用 takes. A slot that is not
        // ready stops here, before any request, and says which one; a failed read of the slots is shown as that failure.
        let materialId: string | undefined;
        if (!colourOnly && !pending.has(key)) {
          const slots = await host.api.takes(target);
          const blocker = publishBlocker(slots);
          if (blocker) {
            host.status(`${blocker}。`);
            return;
          }
          if (slots.slots.length) materialId = await host.api.takeBundle(target);
        }
        const result = await exact(
          key,
          {
            requestId: crypto.randomUUID(),
            draftRevision: saved?.revision ?? 0,
            profileHash: saved?.contentHash ?? '',
            ...(colourOnly ? {} : { previewId: preview.value }),
            acknowledgeReview: true,
            ...(materialId ? { materialId } : {}),
          },
          (input) => host.api.publish(target, input),
        );
        if (gone()) return;
        await open(target);
        host.status(`正式 v${result.version} 已发布。`);
      },
    );
    // In the console the title row's 预演后发布 hides on this tab (it led here), so this is the screen's one solid button.
    if (embedded) confirmPublish.className = 'admin-primary';
    publishRow.append(noProof);
    // a disabled button is skipped by Tab: its reason is linked to it for a screen reader
    noProof.setAttribute?.('id', `wb-reason-${target}`);
    confirmPublish.setAttribute?.('aria-describedby', `wb-reason-${target}`);
    ack.addEventListener('change', sync);
  }
  /** 版本历史 lives in its own module (history/version-history.ts); this only hands it the client and what to do after a restore. */
  function historyPanel(parent: HTMLElement, snapshot: CharacterDetail) {
    if (!snapshot.published) return;
    const section = fold(parent, '版本历史');
    const target = snapshot.characterId;
    const panel = versionHistory(section, {
      api: host.api,
      isOwner: () => host.member()?.role === 'owner',
      status: host.status,
      run: (work) => host.run(work),
      disposed: gone,
      errorText: characterAdminError,
      // The live version, the draft's base and the publish step all moved: read the role again (an unsaved edit is never thrown away).
      onRestored: async () => {
        if (!dirty) await open(target);
      },
    });
    historyViews.push(panel);
    const read = () =>
      panel.load(target).catch((error) => host.status(characterAdminError(error) ?? '版本历史没有读取成功。'));
    if (embedded) void read();
    else {
      button(section, '读取版本历史', () => dirty || !can('read'), read, true);
    }
  }
  function deletion(parent: HTMLElement, snapshot: CharacterDetail) {
    // Part 24f: deleting is the owner's alone; for anyone else there is no 删除角色 section or button at all.
    if (!snapshot.published || !can('delete')) return;
    const section = fold(parent, '删除角色及所有旧聊天');
    section.className = 'admin-confirm';
    const target = snapshot.characterId,
      key = `delete:${target}`,
      output = el('div');
    section.append(
      el(
        'p',
        '不可撤销：删除此人物全部玩家的聊天、记忆和私有音频；不会删除账号、其他人物或已用额度，不释放结果未确认的预留费用。',
      ),
    );
    button(
      section,
      '获取删除影响',
      () => dirty || !can('delete'),
      async () => {
        const token = view,
          impact = await host.api.deletePreview(target);
        if (gone() || token !== view) return;
        controls = controls.filter((c) => !output.contains(c.node));
        output.replaceChildren();
        output.append(
          el(
            'p',
            `正式 v${impact.version} · ${impact.conversations} 个私人会话 · ${impact.messages} 条消息 · ${impact.pendingOperations} 个未终结任务。影响变化后必须重新确认。`,
          ),
        );
        const typed = guarded(
            field(output, `输入人物 ID ${target} 确认删除`, '', { max: 128 }),
            () => dirty || !can('delete'),
          ),
          ack = guarded(check(output, '我确认删除此人物和其全部旧聊天，不能恢复'), () => dirty || !can('delete'));
        button(
          output,
          () => (pending.has(key) ? '按原请求核对删除回执' : '确认永久删除此人物及全部旧聊天'),
          () => dirty || !can('delete') || typed.value !== target || !ack.checked,
          async () => {
            const result = await exact(
              key,
              { requestId: crypto.randomUUID(), previewHash: impact.previewHash, acknowledgeDeleteAllChats: true },
              (input) => host.api.deleteStart(target, input),
            );
            if (gone()) return;
            dirty = false;
            await list();
            host.status('删除已开始，进度见下方删除记录。');
          },
        );
        for (const node of [typed, ack]) node.addEventListener('input', sync);
        sync();
        host.status('删除影响已读取；尚未执行删除，请核对范围。');
      },
    );
    section.append(output);
    if (pending.has(key))
      button(
        section,
        '按原请求核对删除回执',
        () => dirty || !can('delete'),
        async () => {
          await exact(key, { requestId: '', previewHash: '', acknowledgeDeleteAllChats: true }, (input) =>
            host.api.deleteStart(target, input),
          );
          if (gone()) return;
          await list();
        },
        true,
      );
  }
  /** A 预演 finished in the panel beside the editor: the proofs the publish step offers are re-read, the form is left alone. */
  async function syncPreviews() {
    if (!id || !detail?.draft || dirty) return;
    const token = view,
      target = id,
      next = await host.api.detail(target);
    if (gone() || token !== view) return;
    if (next.draft?.revision !== detail.draft.revision || next.draft.contentHash !== detail.draft.contentHash) return;
    for (const job of next.previews) mergeLive(job);
    detail = next;
    previewsChanged?.();
    sync();
  }
  /** The unsaved-changes question (保存 / 不保存 / 取消), shared by leaving the page and 恢复到这一稿. */
  async function confirmLeave(): Promise<boolean> {
    if (!dirty) return true;
    const choice = await leaveDialog(host.modalParent?.() ?? root);
    if (choice === 'cancel') return false;
    if (choice === 'discard') {
      renderDetail();
      return true;
    }
    return (await saveCurrent?.()) === true && !dirty;
  }
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (dirty) {
      event.preventDefault();
      event.returnValue = '';
    }
  };
  window.addEventListener('beforeunload', beforeUnload);
  return {
    load: list,
    open,
    openNew,
    syncPreviews,
    canLeave: () => !dirty,
    /**
     * Asks before leaving when the editor holds unsaved changes. 保存 saves, then leaves (a failed save stays, with its message);
     * 不保存 drops the local changes (nothing is written) and leaves; 取消 stays. Nothing is ever saved without the click.
     */
    confirmLeave,
    isDirty: () => dirty,
    saveDraft: () => saveHook?.(),
    update: (working: boolean) => {
      busy = working;
      if (id && detail && !can('read', id)) {
        dirty = false;
        id = null;
        detail = null;
        clearView();
        host.status('此人物的查看权限已收回；账号和会话仍保留。');
      }
      for (const row of protectedRows) if (!can('read', row.characterId)) row.node.remove();
      protectedRows = protectedRows.filter((r) => root.contains(r.node));
      controls = controls.filter((c) => root.contains(c.node));
      sync();
    },
    clear: () => {
      dirty = false;
      id = null;
      detail = null;
      pending.clear();
      live.clear();
      clearView();
    },
    dispose: () => {
      disposed = true;
      revokeAudio();
      pending.clear();
      live.clear();
      window.removeEventListener('beforeunload', beforeUnload);
      root.replaceChildren();
    },
  };
}

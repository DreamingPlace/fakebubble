import { InviteLocalApiError } from '../../services/invite-local-api.ts';
import type { AdminMember } from '../../services/account-admin-api.ts';
import type {
  CharacterAdminClient,
  CharacterDetail,
  DeletionStatus,
  Material,
  PreviewJob,
} from '../../services/character-admin-api.ts';
import {
  canCreateCharacter,
  hasCharacterPermission,
  type CharacterAdminAction,
} from '../../../../../packages/contracts/web-admin-permissions.ts';
import { AdminFormError, characterForm, check, disclosure, el, emptyCharacter, field } from './character-form.ts';

type Host = {
  api: CharacterAdminClient;
  member: () => AdminMember | null;
  run: (work: () => Promise<void>) => Promise<void>;
  status: (text: string) => void;
  disposed: () => boolean;
  /** Status-poll interval for submitted previews; tests shorten it. */
  previewPollMs?: number;
  /** Unread (new) co-creation submissions per character, shown as a badge on the character's row. */
  badges?: () => Record<string, number>;
};
/** One client-side submission. The body (including requestId) is fixed when it is created. */
type QueueItem = {
  n: number;
  characterId: string;
  key: string;
  body: { requestId: string; draftRevision: number; profileHash: string; relationship: string; message: string };
  sentAt: number;
  state: 'waiting' | 'sending' | 'uncertain' | 'rejected';
  holdUntil: number;
  error: string;
};
export const PREVIEW_MAX_IN_FLIGHT = 3;
export const PREVIEW_BATCH_MAX = 20;
const PREVIEW_INPUT_MAX = 4000;
const when = (ms: number) => new Date(ms).toLocaleString('zh-CN', { hour12: false });
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
const stringify = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value, null, 2));
export function characterAdminError(error: unknown): string | null {
  if (error instanceof AdminFormError) return error.message;
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  return (
    (
      {
        DRAFT_CONFLICT: '草稿已在其他页面修改。请保留本页文字，放弃本页修改后重新读取；本次未覆盖新草稿。',
        LIVE_VERSION_CONFLICT: '正式版本已变，请重新读取资料后编辑。',
        VALID_PREVIEW_REQUIRED: '当前草稿还缺少有效的两阶段预演证明；刷新预演结果后核对，不会自动补发调用。',
        PREVIEW_UNAVAILABLE: '此运行环境未开启真实预演。资料可保存；不能用静态预览代替发布审核。',
        PREVIEW_QUEUE_FULL: '预演队列已满，请先核对已有任务。',
        CHARACTER_MATERIALS_REQUIRED: '当前草稿需要匹配的、已批准的欢迎和结束成品。',
        CHARACTER_VOICE_REQUIRED: '请先在资料中绑定已有音色并保存草稿。',
        CHARACTER_PUBLICATION_BUSY: '此人物仍有未终结的玩家任务。暂不能发布；不会取消或重发未知调用。',
        CHARACTER_CATALOG_FULL: '已达到 15 个人物，请先明确处理已有角色。',
        MATERIAL_AUDIO_IMMUTABLE: '这一成品位置已有不同音频，不能覆盖。请准备新的素材版本。',
        INVALID_MATERIAL_AUDIO: '请选择有效的单声道 24kHz PCM16 WAV，非静音，最长 60 秒且不超过 6 MB。',
        DELETION_PREVIEW_CHANGED: '删除影响已变化。请重新获取影响，并再次核对确认。',
        CHARACTER_DELETED: '人物已删除，不能继续编辑、发布或复用此 ID。',
        INVALID_SCHEDULE: '周作息须每天连续覆盖 00:00–24:00，概率 0–100%，每日至少一段、最多48段。',
        NO_CATCH_UP_WINDOW: '一周至少保留一个补聊时段。',
        INVALID_TIME_ZONE: '时区无效，请使用例如 Asia/Singapore 的 IANA 时区。',
        INVALID_VOICE_BINDING: '音色 ID、正整数版本和 0.5–2 之间语速必须有效。',
        INVALID_CANON_VALUE: '结构化设定包含无效值，请核对 JSON 层级和字段。',
        INVALID_CHARACTER_ALIASES: '身份别名需包含人设名称，并明确为虚构人物。',
        INVALID_CANON_EVENTS: '设定事件需明确作者设定、虚构世界及本人物知情范围。',
        INVALID_ADMIN_REQUEST: '资料字段无效或超出长度，请核对必填内容和结构化设定。',
      } as Record<string, string>
    )[code] ?? null
  );
}

/** All mutations are explicit buttons. No storage, implicit generation, or player-content queries; the only timer polls the status of previews this admin already submitted. */
export function characterWorkbench(root: HTMLElement, host: Host) {
  let disposed = false,
    busy = false,
    dirty = false,
    id: string | null = null,
    detail: CharacterDetail | null = null;
  let editor: ReturnType<typeof characterForm> | null = null,
    controls: Control[] = [],
    view = 0;
  let protectedRows: Array<{ characterId: string; node: HTMLElement }> = [];
  const urls = new Set<string>();
  const pending = new Map<string, { input: unknown; uncertain: boolean; send: () => Promise<unknown> }>();
  const items: QueueItem[] = [];
  const live = new Map<string, PreviewJob>();
  let itemSeq = 0,
    pollTimer: ReturnType<typeof setTimeout> | null = null,
    paintResults: (() => void) | null = null,
    previewsChanged: (() => void) | null = null;
  const can = (action: CharacterAdminAction, target = id ?? '') => {
    const m = host.member();
    return !!m && (m.role === 'owner' || hasCharacterPermission(m.permissions, action, target));
  };
  const canCreate = () => {
    const m = host.member();
    return !!m && (m.role === 'owner' || canCreateCharacter(m.permissions));
  };
  const gone = () => disposed || host.disposed();
  const revokeAudio = () => {
    for (const url of urls) URL.revokeObjectURL(url);
    urls.clear();
  };
  const sync = () => {
    if (gone()) return;
    editor?.setDisabled(busy || (detail ? !can('edit', id ?? '') : !canCreate()));
    for (const c of controls) {
      if (c.text) c.node.textContent = c.text();
      const lock = c.locked();
      c.node.dataset.locked = String(lock);
      c.node.disabled = busy || lock;
    }
  };
  const setDirty = () => {
    dirty = true;
    host.status('有未保存修改。请先保存草稿，或放弃本页修改后切换／预览。');
    sync();
  };
  const act = (work: () => Promise<void>) => {
    void host.run(async () => {
      if (gone()) return;
      host.status('处理中…');
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
  const clearView = () => {
    view++;
    revokeAudio();
    controls = [];
    protectedRows = [];
    editor = null;
    paintResults = null;
    previewsChanged = null;
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
    row.append(el('h3', job.characterId), progress, error);
    const show = (current: DeletionStatus) => {
      progress.textContent =
        current.state === 'deleted'
          ? '已删除，内容清理完成。'
          : `清理中：数据库 ${current.databaseCleared}/${current.total}；音频 ${current.audioCleared}/${current.total}`;
      error.textContent = current.errorCode
        ? `清理暂未完成：${current.errorCode}。原任务保留；刷新核对，不要重新删除或释放未知费用。`
        : '';
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
        host.status('删除进度已更新。');
      },
      true,
    );
  }
  async function list() {
    if (dirty) throw new AdminFormError('请先保存草稿，或放弃本页修改。');
    const current = ++view,
      result = await host.api.list();
    if (gone() || current !== view) return;
    clearView();
    id = null;
    detail = null;
    dirty = false;
    root.append(
      el('h2', '角色资料'),
      el('p', '保存草稿 → 查看改动 → 文字预演／批准成品 → 确认发布。正式角色与玩家聊天不会因保存草稿改变。'),
    );
    const tools = el('div');
    tools.className = 'admin-toolbar';
    root.append(tools);
    button(
      tools,
      '新建角色草稿',
      () => !canCreate(),
      () => openNew(),
    );
    button(tools, '刷新角色目录', () => false, list, true);
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
        const badge = el('span', String(unread));
        badge.className = 'cocreation-badge';
        badge.setAttribute('aria-label', `有 ${unread} 条新的共创`);
        badge.setAttribute('title', `共创收件箱里有 ${unread} 条新的玩家想法`);
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
    host.status('目录已更新。');
    sync();
  }
  async function open(target: string) {
    if (dirty) throw new AdminFormError('请先保存草稿，或放弃本页修改。');
    const current = ++view,
      next = await host.api.detail(target);
    if (gone() || current !== view) return;
    id = target;
    detail = next;
    renderDetail();
    host.status('资料已读取；保存草稿与正式发布是分开的操作。');
  }
  function openNew() {
    id = '';
    detail = null;
    dirty = false;
    renderDetail();
    host.status('请填写空白角色资料；保存后仍须预演与批准才能发布。');
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
    if (snapshot) for (const job of snapshot.previews) mergeLive(job);
    if (snapshot?.draft) previewPanel(root, snapshot);
    editor = characterForm(root, profile, !snapshot, setDirty, (e) =>
      host.status(characterAdminError(e) ?? '请核对资料字段。'),
    );
    // A new ID must be enterable before its scoped edit permission can be evaluated.
    const actions = el('div');
    actions.className = 'admin-toolbar';
    editor.form.append(actions);
    const save = el('button', '保存草稿');
    save.type = 'submit';
    actions.append(save);
    const canEdit = () => (snapshot ? can('edit', target) : canCreate());
    controls.push({ node: save, locked: () => !canEdit() });
    editor.form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (busy || !canEdit()) return;
      let next;
      try {
        next = editor!.read();
      } catch (error) {
        host.status(characterAdminError(error) ?? '请核对资料字段。');
        return;
      }
      const role = next.template.id;
      act(async () => {
        if (!can('edit', role)) throw new AdminFormError('没有角色资料管理权限，请联系主管理员。');
        const saved = await host.api.save(role, snapshot?.draft?.revision ?? null, next);
        if (gone()) return;
        dirty = false;
        await open(saved.characterId);
        host.status(`草稿修订 ${saved.revision} 已保存；尚未发布。`);
      });
    });
    button(
      actions,
      '放弃本页未保存修改',
      () => !dirty,
      () => {
        renderDetail();
        host.status('已放弃本页修改；服务器草稿和正式版本不变。');
      },
      true,
    );
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
      if (snapshot.draft) {
        const section = disclosure(flow, '放弃服务器草稿');
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
    }
    sync();
  }
  function profileDiff(parent: HTMLElement, snapshot: CharacterDetail) {
    const section = disclosure(parent, '查看资料改动（不调用供应商）'),
      output = el('div');
    section.append(output);
    button(
      section,
      '比较已存草稿与正式资料',
      () => dirty || !can('read'),
      async () => {
        const token = view,
          result = await host.api.profilePreview(snapshot.characterId, snapshot.draft!.revision);
        if (gone() || token !== view) return;
        output.replaceChildren();
        const groups: [string, unknown, unknown][] = [
          ['人设', result.published?.template.persona, result.draft.profile.template.persona],
          ['网页展示', result.published?.presentation, result.draft.profile.presentation],
          ['完整模板', result.published?.template, result.draft.profile.template],
        ];
        for (const [name, before, after] of groups) {
          if (JSON.stringify(before) === JSON.stringify(after)) continue;
          const group = disclosure(output, name),
            columns = el('div');
          columns.className = 'profile-diff';
          for (const [label, value] of [
            ['正式', before],
            ['草稿', after],
          ] as const) {
            const side = el('section');
            side.append(el('h4', label), el('pre', value === undefined ? '尚无正式版本' : stringify(value)));
            columns.append(side);
          }
          group.append(columns);
        }
        if (!output.childElementCount) output.append(el('p', '没有资料差异。'));
        host.status('静态资料比较完成；这不是付费预演或发布审核证明。');
      },
      true,
    );
  }
  const isOpenJob = (job: PreviewJob) => job.status === 'queued' || job.status === 'generating';
  const jobsOf = (characterId: string) => [...live.values()].filter((j) => j.characterId === characterId);
  function mergeLive(job: PreviewJob) {
    const old = live.get(job.previewId);
    live.set(job.previewId, {
      ...(old?.input !== undefined ? { input: old.input } : {}),
      ...(old?.createdAt !== undefined ? { createdAt: old.createdAt } : {}),
      ...job,
    });
  }
  const inFlight = (characterId: string) =>
    items.filter((i) => i.characterId === characterId && (i.state === 'sending' || i.state === 'uncertain')).length +
    jobsOf(characterId).filter(isOpenJob).length;
  // A provider call whose outcome is UNKNOWN is never retried or released; it also pauses new submissions on that draft.
  const unknownOn = (characterId: string, draftRevision: number, profileHash: string) =>
    jobsOf(characterId).some(
      (j) => j.draftRevision === draftRevision && j.profileHash === profileHash && !!j.errorCode?.includes('UNKNOWN'),
    );
  const uncertainItem = (characterId: string) =>
    items.find((i) => i.characterId === characterId && i.state === 'uncertain');
  const paint = () => {
    if (gone()) return;
    paintResults?.();
    previewsChanged?.();
    sync();
  };
  function schedulePoll() {
    if (pollTimer !== null || gone()) return;
    if (!items.some((i) => i.state === 'waiting') && ![...live.values()].some(isOpenJob)) return;
    pollTimer = setTimeout(() => {
      pollTimer = null;
      void tick();
    }, host.previewPollMs ?? 2500);
  }
  async function tick() {
    const open = [...live.values()].filter(isOpenJob);
    const results = await Promise.allSettled(open.map((j) => host.api.previewStatus(j.characterId, j.previewId)));
    if (gone()) return;
    for (const r of results) if (r.status === 'fulfilled') mergeLive(r.value);
    for (const characterId of new Set(items.filter((i) => i.state === 'waiting').map((i) => i.characterId)))
      pump(characterId);
    paint();
    schedulePoll();
  }
  function pump(characterId: string) {
    if (gone()) return;
    let slots = PREVIEW_MAX_IN_FLIGHT - inFlight(characterId);
    const now = Date.now();
    for (const item of items.filter((i) => i.characterId === characterId && i.state === 'waiting')) {
      if (slots <= 0) break;
      if (item.holdUntil > now || unknownOn(characterId, item.body.draftRevision, item.body.profileHash)) continue;
      slots--;
      void dispatch(item);
    }
    paint();
    schedulePoll();
  }
  async function dispatch(item: QueueItem) {
    item.state = 'sending';
    paint();
    try {
      const job = await exact(item.key, item.body, (body) => host.api.startPreview(item.characterId, body));
      if (gone()) return;
      items.splice(items.indexOf(item), 1);
      mergeLive({
        ...job,
        input: job.input ?? item.body.message,
        createdAt: job.createdAt ?? item.sentAt,
      });
      host.status(
        `预演 ${job.previewId}：${previewLabel(job.status)}。最多 ${PREVIEW_MAX_IN_FLIGHT} 条同时运行，其余自动排队。`,
      );
    } catch (error) {
      if (gone()) return;
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      if (code === 'PREVIEW_QUEUE_FULL') {
        // Rejected before any job or reservation exists, so the same requestId may safely be offered again later.
        pending.delete(item.key);
        item.state = 'waiting';
        item.holdUntil = Date.now() + (host.previewPollMs ?? 2500);
        host.status('服务器预演队列已满，该条保持排队，稍后自动继续。');
      } else if (pending.has(item.key)) {
        item.state = 'uncertain';
      } else {
        item.state = 'rejected';
        item.error = code || (error instanceof Error ? error.message : '请求失败');
        host.status(characterAdminError(error) ?? `预演未发起：${item.error}`);
      }
    }
    pump(item.characterId);
  }
  function enqueue(snapshot: CharacterDetail, relationship: string, lines: string[]) {
    const saved = snapshot.draft!;
    for (const message of lines) {
      const n = ++itemSeq;
      items.push({
        n,
        characterId: snapshot.characterId,
        key: `preview:${snapshot.characterId}:${n}`,
        body: {
          requestId: crypto.randomUUID(),
          draftRevision: saved.revision,
          profileHash: saved.contentHash,
          relationship,
          message,
        },
        sentAt: Date.now(),
        state: 'waiting',
        holdUntil: 0,
        error: '',
      });
    }
    host.status(`已加入 ${lines.length} 条预演；最多 ${PREVIEW_MAX_IN_FLIGHT} 条同时运行，其余自动排队。`);
    pump(snapshot.characterId);
  }
  const bubbleTexts = (result: unknown): string[] => {
    const bubbles = (result as { reply?: { bubbles?: unknown } } | null)?.reply?.bubbles;
    if (!Array.isArray(bubbles)) return [];
    return bubbles.flatMap((b) =>
      b && typeof b === 'object' && 'text' in b && typeof b.text === 'string' ? [b.text] : [],
    );
  };
  /** Always-open "预演测试" section: submit, queue and results never re-render the page or collapse. */
  function previewPanel(parent: HTMLElement, snapshot: CharacterDetail) {
    const saved = snapshot.draft!,
      cid = snapshot.characterId,
      section = el('section'),
      token = view;
    section.className = 'preview-panel';
    parent.append(section);
    section.append(
      el('h3', '预演测试'),
      el(
        'p',
        `只发送本角色草稿修订 ${saved.revision} 和下方合成输入，不读取玩家私聊。真实文字供应商会产生费用；每条预演单独扣预算、单独成卡，页面不会自动重发。可连续提交多条：每个角色最多同时运行 ${PREVIEW_MAX_IN_FLIGHT} 条，其余在本页排队。`,
      ),
    );
    const relationLabel = el('label'),
      relationship = el('select');
    relationLabel.append(el('span', '预演关系'), relationship);
    section.append(relationLabel);
    for (const [value, text] of [
      ['new', '初识'],
      ['friend', '朋友'],
      ['close_friend', '亲近朋友'],
      ['lover', '恋人'],
    ]) {
      const option = el('option', text);
      option.value = value!;
      relationship.append(option);
    }
    const message = field(section, '预演输入（不是玩家消息）', '', { area: true, max: PREVIEW_INPUT_MAX }),
      ack = check(section, '我确认发起真实付费文字预演，并已核对当前草稿与输入');
    if (!snapshot.previewAvailable) section.append(el('p', '当前运行未开启预演，不能通过静态比较绕过发布审核。'));
    const unknownNote = el('p');
    section.append(unknownNote);
    const blocked = () => unknownOn(cid, saved.revision, saved.contentHash);
    const readonly = () => dirty || !can('preview') || !!uncertainItem(cid);
    const batch = field(section, '每行一条，批量预演', '', { area: true });
    const hint = el('p');
    section.append(hint);
    const lines = () =>
      batch.value
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
    const showHint = () => {
      const n = lines().length;
      hint.textContent =
        `约 ${n} 次调用。每条预演都是一次付费调用（内部含草稿与审核两个阶段），提交前单独预留预算；最多 ${PREVIEW_BATCH_MAX} 条。` +
        (n > PREVIEW_BATCH_MAX ? ` 当前 ${n} 条，超过上限。` : '');
    };
    showHint();
    for (const input of [relationship, message, ack, batch]) guarded(input, readonly);
    const sendLocked = () =>
      dirty ||
      !can('preview') ||
      !snapshot.previewAvailable ||
      (!uncertainItem(cid) && (blocked() || !ack.checked || !message.value.trim()));
    const send = el('button', '发起付费文字预演');
    send.type = 'button';
    section.append(send);
    controls.push({
      node: send,
      locked: sendLocked,
      text: () => (uncertainItem(cid) ? '按原请求核对预演回执' : '发起付费文字预演'),
    });
    send.addEventListener('click', () => {
      if (busy || sendLocked()) return;
      const stuck = uncertainItem(cid);
      if (stuck) {
        void dispatch(stuck);
        return;
      }
      const text = message.value;
      // The box is emptied synchronously, so a second click of the same press has nothing left to submit.
      message.value = '';
      enqueue(snapshot, relationship.value, [text]);
    });
    const sendBatch = el('button', '批量发起付费文字预演');
    sendBatch.type = 'button';
    section.append(sendBatch);
    controls.push({
      node: sendBatch,
      locked: () => {
        const n = lines().length;
        return (
          dirty ||
          !can('preview') ||
          !snapshot.previewAvailable ||
          !!uncertainItem(cid) ||
          blocked() ||
          !ack.checked ||
          n === 0 ||
          n > PREVIEW_BATCH_MAX ||
          lines().some((l) => l.length > PREVIEW_INPUT_MAX)
        );
      },
    });
    sendBatch.addEventListener('click', () => {
      if (busy || sendBatch.disabled) return;
      const batchLines = lines();
      if (!batchLines.length || batchLines.length > PREVIEW_BATCH_MAX) return;
      batch.value = '';
      showHint();
      enqueue(snapshot, relationship.value, batchLines);
    });
    section.append(
      el('p', '遇到未确认回执时，按钮改为核对上次完整请求；若首次未到达服务，核对可能执行原请求，不会新建另一任务。'),
    );
    button(
      section,
      '刷新预演状态',
      () => dirty || !can('read'),
      async () => {
        const next = await host.api.detail(cid);
        if (gone() || token !== view) return;
        if (next.draft?.revision !== saved.revision || next.draft.contentHash !== saved.contentHash) {
          await open(cid);
          return;
        }
        for (const job of next.previews) mergeLive(job);
        detail = next;
        pump(cid);
        paint();
        schedulePoll();
        host.status('预演状态已更新。');
      },
      true,
    );
    const results = el('div');
    results.className = 'preview-results';
    section.append(results);
    paintResults = () => {
      controls = controls.filter((c) => !results.contains(c.node));
      results.replaceChildren();
      blocked();
      unknownNote.textContent = blocked()
        ? '当前草稿有结果未知的预演：不会重发、不会释放预算，并暂停新的提交与排队。先核对原任务。'
        : '';
      const cards: Array<{ at: number; order: number; build: () => void }> = [];
      const card = () => {
        const node = el('section');
        node.className = 'preview-card';
        results.append(node);
        return node;
      };
      for (const item of items.filter((i) => i.characterId === cid))
        cards.push({
          at: item.sentAt,
          order: item.n,
          build: () => {
            const node = card();
            node.append(
              el('p', '输入'),
              el('pre', item.body.message),
              el('p', `发送时间：${when(item.sentAt)}`),
              el(
                'p',
                `状态：${
                  item.state === 'waiting'
                    ? '排队中'
                    : item.state === 'sending'
                      ? '运行中'
                      : item.state === 'uncertain'
                        ? '运行中（回执未确认，可按原请求核对）'
                        : `失败：${item.error}`
                }`,
              ),
            );
            if (item.state === 'waiting' || item.state === 'rejected')
              button(
                node,
                item.state === 'waiting' ? '取消排队' : '移除此条',
                () => false,
                () => {
                  items.splice(items.indexOf(item), 1);
                  paint();
                },
                true,
              );
          },
        });
      let order = 0;
      for (const job of jobsOf(cid))
        cards.push({
          at: job.createdAt ?? 0,
          order: --order,
          build: () => {
            const node = card();
            node.append(
              el('p', '输入'),
              el('pre', job.input ?? '（输入文本不可用）'),
              el('p', `发送时间：${job.createdAt === undefined ? '未知' : when(job.createdAt)}`),
              el(
                'p',
                `状态：${previewLabel(job.status)}${job.status === 'failed' ? `：${job.errorCode ?? '未知原因'}` : ''} · ${job.previewId}${sameDraft(job, snapshot) ? ' · 当前草稿' : ' · 旧修订'}`,
              ),
            );
            if (job.errorCode && job.status !== 'failed') node.append(el('p', `预演未通过：${job.errorCode}。`));
            if (job.errorCode) node.append(el('p', '未知调用不能重发或释放。'));
            for (const text of bubbleTexts(job.result)) node.append(el('p', text));
            if (job.result !== null && job.result !== undefined)
              disclosure(node, '完整预演与审核数据').append(el('pre', stringify(job.result)));
          },
        });
      cards.sort((a, b) => b.at - a.at || b.order - a.order);
      for (const c of cards) c.build();
    };
    paintResults();
    for (const input of [ack, message, relationship]) input.addEventListener('input', sync);
    ack.addEventListener('change', sync);
    batch.addEventListener('input', () => {
      showHint();
      sync();
    });
    schedulePoll();
  }
  function materials(parent: HTMLElement, snapshot: CharacterDetail) {
    const section = disclosure(parent, '声音成品版本'),
      saved = snapshot.draft!,
      target = snapshot.characterId,
      key = `material:${target}`,
      output = el('div');
    section.append(
      el(
        'p',
        '仅使用已有音色 referenceId 和明确选取的两条成品；不会创建或克隆声音，不自动上传样本。每个素材版本固定本次草稿。',
      ),
    );
    const reference = guarded(
      field(section, '已有 Fish 音色 referenceId', '', { max: 128 }),
      () => dirty || pending.has(key) || !can('materials'),
    );
    button(
      section,
      () => (pending.has(key) ? '按原请求核对素材准备' : '准备新素材版本'),
      () => dirty || !can('materials') || (!pending.has(key) && !reference.value.trim()),
      async () => {
        const materialId = await exact(
          key,
          {
            requestId: crypto.randomUUID(),
            draftRevision: saved.revision,
            profileHash: saved.contentHash,
            referenceId: reference.value.trim(),
            model: 's2.1-pro',
          },
          (input) => host.api.prepareMaterial(target, input),
        );
        if (gone()) return;
        await load();
        host.status(`素材版本 ${materialId} 已准备，请明确选择欢迎和结束成品。`);
      },
    );
    button(section, '读取已有成品版本', () => dirty || !can('read'), load, true);
    section.append(output);
    async function load() {
      const token = view,
        items = await host.api.materials(target);
      if (gone() || token !== view) return;
      controls = controls.filter((c) => !output.contains(c.node));
      revokeAudio();
      output.replaceChildren();
      if (!items.length)
        output.append(el('p', '还没有管理工作台创建的素材版本。原已批准音色与欢迎词完全不变时，发布可沿用原成品。'));
      for (const material of items) materialRow(output, snapshot, material);
      sync();
      host.status('成品版本已读取；只有明确选择文件并点击上传才会传输。');
    }
    reference.addEventListener('input', sync);
  }
  function materialRow(parent: HTMLElement, snapshot: CharacterDetail, material: Material) {
    const target = snapshot.characterId,
      current = sameDraft(material, snapshot),
      section = disclosure(
        parent,
        `${material.materialId} · ${material.approved ? '已批准' : '待批准'}${current ? ' · 当前草稿' : ' · 旧修订'}`,
      );
    section.append(
      el(
        'p',
        `音色 ${material.voice.profileId} v${material.voice.version} · ${material.voice.model} · referenceId ${material.voice.referenceId}`,
      ),
    );
    for (const kind of ['welcome', 'footer'] as const) {
      const name = kind === 'welcome' ? '欢迎成品' : '结束成品',
        asset = material.assets.find((a) => a.kind === kind),
        row = el('section');
      section.append(row);
      row.append(el('h4', name));
      if (asset) {
        row.append(
          el('p', asset.body),
          el('p', `${(asset.durationMs / 1000).toFixed(2)} 秒 · ${asset.byteLength} 字节 · SHA256 ${asset.sha256}`),
        );
        const mount = el('div');
        row.append(mount);
        button(
          row,
          `加载${name}试听`,
          () => !can('read'),
          async () => {
            const token = view,
              base64 = await host.api.audio(target, material.materialId, kind);
            if (gone() || token !== view) return;
            const bytes = Uint8Array.from(atob(base64), (v) => v.charCodeAt(0)),
              digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
                .map((b) => b.toString(16).padStart(2, '0'))
                .join('');
            if (digest !== asset.sha256) throw new AdminFormError('成品哈希不匹配，拒绝试听或批准。');
            if (gone() || token !== view) return;
            const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
            urls.add(url);
            const audio = el('audio');
            audio.controls = true;
            audio.preload = 'none';
            audio.src = url;
            mount.replaceChildren(audio);
            host.status('成品已加载，请手动播放试听。');
          },
          true,
        );
      } else if (current) {
        const file = el('input');
        file.type = 'file';
        file.accept = '.wav,audio/wav';
        const label = el('label');
        label.append(el('span', `选择${name} WAV`), file);
        row.append(label);
        guarded(file, () => dirty || !can('materials'));
        const rights = guarded(
          check(row, '这是我有权使用的成品，不是待克隆的原始声音样本'),
          () => dirty || !can('materials'),
        );
        button(
          row,
          `上传所选${name}`,
          () => dirty || !can('materials') || !rights.checked || file.files?.length !== 1,
          async () => {
            const selected = file.files?.[0];
            if (!selected || selected.size > 6_000_000) throw new AdminFormError('请选择一条不超过 6 MB 的成品 WAV。');
            const bytes = new Uint8Array(await selected.arrayBuffer());
            let binary = '';
            for (let i = 0; i < bytes.length; i += 32768)
              binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
            await host.api.upload(target, material.materialId, kind, btoa(binary));
            if (gone()) return;
            await open(target);
            host.status('成品已上传。请重新读取该素材版本并试听，两条都批准后才能发布。');
          },
        );
        file.addEventListener('change', sync);
        rights.addEventListener('change', sync);
      }
    }
    if (current && !material.approved) {
      const rights = guarded(
          check(section, '我确认有权使用这个音色和两条成品'),
          () => dirty || !can('approve-materials'),
        ),
        welcome = guarded(
          check(section, '我已完整试听并确认欢迎成品与欢迎词一致'),
          () => dirty || !can('approve-materials'),
        ),
        footer = guarded(check(section, '我已完整试听并确认结束成品'), () => dirty || !can('approve-materials')),
        note = guarded(field(section, '批准说明', '', { max: 1000 }), () => dirty || !can('approve-materials'));
      button(
        section,
        '批准此素材版本',
        () =>
          dirty ||
          !can('approve-materials') ||
          material.assets.length !== 2 ||
          !rights.checked ||
          !welcome.checked ||
          !footer.checked ||
          !note.value.trim(),
        async () => {
          await host.api.approve(target, material.materialId, note.value);
          if (gone()) return;
          await open(target);
          host.status('成品已批准；尚未发布角色。');
        },
      );
      for (const node of [rights, welcome, footer, note]) node.addEventListener('input', sync);
    }
  }
  function publication(parent: HTMLElement, snapshot: CharacterDetail) {
    const section = disclosure(parent, '发布角色版本'),
      target = snapshot.characterId,
      key = `publish:${target}`,
      saved = snapshot.draft;
    section.append(
      el('p', '发布会将已存资料和批准成品提供给玩家。不会自动生成审核或声音；在途玩家任务／未知调用不被取消或重发。'),
    );
    const previews = () =>
      jobsOf(target)
        .filter((p) => p.status === 'succeeded' && sameDraft(p, snapshot))
        .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    if (!saved && !pending.has(key)) {
      section.append(el('p', '当前没有未发布草稿。'));
      return;
    }
    const label = el('label'),
      preview = el('select');
    label.append(el('span', '已查看且匹配当前草稿的预演'), preview);
    section.append(label);
    const noProof = el('p', '尚无匹配当前草稿的成功预演，不能发布。');
    const fillPreviews = () => {
      const keep = preview.value;
      preview.replaceChildren();
      for (const job of previews()) {
        const option = el('option', job.previewId);
        option.value = job.previewId;
        preview.append(option);
      }
      if (keep && previews().some((p) => p.previewId === keep)) preview.value = keep;
      noProof.textContent = !previews().length && !pending.has(key) ? '尚无匹配当前草稿的成功预演，不能发布。' : '';
    };
    fillPreviews();
    previewsChanged = fillPreviews;
    const materialLabel = el('label'),
      material = el('select');
    materialLabel.append(el('span', '发布使用的成品版本'), material);
    section.append(materialLabel);
    const reuse = el('option', '沿用原成品（仅声音与欢迎词完全不变）');
    reuse.value = '';
    material.append(reuse);
    button(
      section,
      '读取当前草稿的已批准成品',
      () => dirty || !can('read'),
      async () => {
        const token = view,
          items = await host.api.materials(target);
        if (gone() || token !== view) return;
        material.replaceChildren(reuse);
        for (const item of items.filter((m) => m.approved && sameDraft(m, snapshot))) {
          const option = el('option', item.materialId);
          option.value = item.materialId;
          material.append(option);
        }
        host.status('只列出与当前修订/hash匹配的已批准成品。');
      },
      true,
    );
    const ack = check(section, '我已查看资料差异和该预演结果，确认将本版本发布给玩家');
    for (const input of [preview, material, ack]) guarded(input, () => dirty || pending.has(key) || !can('publish'));
    section.append(noProof);
    button(
      section,
      () => (pending.has(key) ? '按原请求核对发布回执' : '确认发布此版本'),
      () =>
        dirty ||
        !can('publish') ||
        (!pending.has(key) && (!saved || !ack.checked || !previews().some((p) => p.previewId === preview.value))),
      async () => {
        const result = await exact(
          key,
          {
            requestId: crypto.randomUUID(),
            draftRevision: saved?.revision ?? 0,
            profileHash: saved?.contentHash ?? '',
            previewId: preview.value,
            acknowledgeReview: true,
            ...(material.value ? { materialId: material.value } : {}),
          },
          (input) => host.api.publish(target, input),
        );
        if (gone()) return;
        await open(target);
        host.status(`正式 v${result.version} 已发布。`);
      },
    );
    ack.addEventListener('change', sync);
  }
  function deletion(parent: HTMLElement, snapshot: CharacterDetail) {
    if (!snapshot.published) return;
    const section = disclosure(parent, '删除角色及所有旧聊天');
    section.className = 'admin-confirm';
    const target = snapshot.characterId,
      key = `delete:${target}`,
      output = el('div');
    section.append(
      el(
        'p',
        '不可撤销：删除此人物全部玩家的聊天、记忆和私有音频；不会删除账号、其他人物或已用额度，不释放 UNKNOWN 费用。',
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
            host.status(`删除任务 ${result.deletionId} 已建立，清理状态 ${result.state}；可在删除记录中继续核对。`);
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
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (dirty) {
      event.preventDefault();
      event.returnValue = '';
    }
  };
  window.addEventListener('beforeunload', beforeUnload);
  return {
    load: list,
    canLeave: () => !dirty,
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
      items.length = 0;
      live.clear();
      if (pollTimer !== null) clearTimeout(pollTimer);
      pollTimer = null;
      clearView();
    },
    dispose: () => {
      disposed = true;
      revokeAudio();
      pending.clear();
      items.length = 0;
      live.clear();
      if (pollTimer !== null) clearTimeout(pollTimer);
      pollTimer = null;
      window.removeEventListener('beforeunload', beforeUnload);
      root.replaceChildren();
    },
  };
}

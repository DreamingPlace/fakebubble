import type { AccountAdminApi, AccountAdminSession } from '../../services/account-admin-api.ts';
import { characterWorkbench, characterAdminError } from './character-workbench.ts';
import { previewWorkbench } from './preview/preview-workbench.ts';
import type { PreviewAdminClient } from '../../services/preview-admin-api.ts';
import { permissionMatrixEditor } from './permission-matrix.ts';
import { grantsView } from './grants-view.ts';
import { opsView } from './ops-view.ts';
import { rolePicker } from './shell/role-picker.ts';
import {
  canSeePage,
  firstAllowedPage,
  isAdminPage,
  navMarkup,
  NAV_TREE,
  type AdminPage,
  type NavAccess,
} from './shell/admin-nav.ts';
import { addressBar, sameRoute, type AdminRoute } from './shell/admin-router.ts';
import { splitPane } from './ui/split-pane.ts';
import { toastHost } from './ui/toast.ts';
import { cocreationInbox } from './cocreation-inbox.ts';
import type { CocreationAdminClient } from '../../services/cocreation-admin-api.ts';
import { inviteRecords } from './invite-records.ts';
import {
  ADMIN_PERMISSION_LIMIT,
  hasCharacterPermission,
  hasInvitePermission,
  hasCocreationPermission,
  type AdminPermission,
  type CocreationAdminPermission,
  type InviteAdminPermission,
} from '../../../../../packages/contracts/web-admin-permissions.ts';
import { InviteLocalApiError } from '../../services/invite-local-api.ts';

type Port = Pick<
  AccountAdminApi,
  | 'restore'
  | 'emailLogin'
  | 'login'
  | 'logout'
  | 'bindStart'
  | 'bindFinish'
  | 'resetStart'
  | 'resetFinish'
  | 'members'
  | 'issueMember'
  | 'setPermissions'
  | 'revokeCredential'
  | 'issue'
  | 'revokeInvite'
  | 'inviteRecords'
  | 'characters'
> & {
  /** 预演测试 workbench (runs, eval sets, batched status). Without it the page keeps the single-preview panel. */
  previews?: PreviewAdminClient;
  /** 运营数据 (owner only). Optional: a page without it has no such page in the nav. */
  stageLatency?: AccountAdminApi['stageLatency'];
  /** 共创收件箱. Optional: a page without it simply has no inbox tab. */
  cocreation?: Pick<CocreationAdminClient, 'counts' | 'list' | 'detail' | 'setStatus' | 'star' | 'note' | 'adopt'>;
};
export function adminAccountError(error: unknown) {
  const characterError = characterAdminError(error);
  if (characterError) return characterError;
  const code = error instanceof InviteLocalApiError ? error.code : '';
  return (
    (
      {
        ADMIN_PERMISSIONS_CONFLICT: '权限已被另一页面修改。请刷新权限列表，核对后再保存；本次未覆盖新权限。',
        ADMIN_LOGIN_INVALID: '邮箱或密码不正确。',
        ADMIN_INVALID_GRANT: '凭据已使用、已过期或已撤销，请联系主管理员。',
        ADMIN_UNAUTHORIZED: '登录已过期，请重新登录。',
        ADMIN_OWNER_REQUIRED: '此操作仅限主管理员。',
        ADMIN_PERMISSION_REQUIRED: '当前没有这项管理权限。账号仍可登录，请联系主管理员调整权限。',
        ADMIN_PASSWORD_INVALID: '新设密码需要 8–18 个字符；以前设置的较长密码仍可登录。',
        ADMIN_EMAIL_INVALID: '请填写有效的邮箱地址。',
        ADMIN_CODE_INVALID: '验证码无效或已过期，请核对最新一封邮件；连续错误后需重新申请。',
        ADMIN_EMAIL_UNAVAILABLE: '邮件服务尚未就绪。你仍可使用一次性凭据登录和管理。',
        ADMIN_EMAIL_UNAVAILABLE_FOR_BINDING: '无法绑定此邮箱，请使用其他邮箱或联系主管理员。',
        ADMIN_EMAIL_ALREADY_BOUND: '此账号已绑定邮箱，请刷新查看。',
        RATE_LIMITED: '操作太频繁，请稍后再试。',
      } as Record<string, string>
    )[code] ?? '操作结果未确认。请刷新核对当前状态，不要重复提交发码请求。'
  );
}

/** The address the console is served from, so a test machine is never mistaken for the real one. */
export const environmentLabel = (hostname: string | undefined) =>
  !hostname ? '' : ['127.0.0.1', 'localhost', '[::1]'].includes(hostname) ? '本机测试环境' : hostname;

/** Administrator-only surface. No player registration, external identity providers or browser secret storage. */
export function startAccountAdminPage(root: HTMLElement, port: Port): () => void {
  root.innerHTML = `<main class="invite-admin-page account-admin-page admin-shell" data-surface="login">
    <div class="admin-narrow-notice" role="note">管理后台请在电脑浏览器打开</div>
    <header class="admin-topbar">
      <div class="admin-brand"><h1 tabindex="-1">FAKE 泡泡管理</h1><span class="admin-env" id="admin-env"></span></div>
      <div class="admin-account" hidden>
        <button type="button" id="admin-account-toggle" class="admin-account-toggle" aria-haspopup="true" aria-expanded="false" aria-controls="admin-account-menu"></button>
        <div class="admin-menu" id="admin-account-menu" hidden>
          <p class="admin-identity"></p>
          <a class="admin-menu-item" href="#/account" data-page="account">我的账号</a>
          <button type="button" class="admin-menu-item" id="admin-logout">退出登录</button>
        </div>
      </div>
    </header>
    <div class="admin-frame">
    <nav class="admin-sidebar admin-nav" aria-label="管理页面" hidden>
      <div class="admin-nav-groups">${navMarkup()}</div>
      <button type="button" class="admin-nav-collapse" id="admin-nav-collapse" aria-pressed="false" title="收起或展开导航"><span aria-hidden="true">«</span><span class="admin-nav-collapse-text">收起导航</span></button>
    </nav>
    <div class="admin-content" tabindex="-1">
    <section class="invite-admin-result" id="admin-secret" hidden><span id="admin-secret-label"></span><strong class="invite-admin-code" id="admin-secret-value"></strong>
      <button id="admin-secret-close" type="button">已记录，清除显示</button></section>
    <section data-panel="login" hidden>
      <form id="admin-email-login"><label for="admin-email">管理员邮箱</label><input id="admin-email" type="email" autocomplete="username" maxlength="254" required>
        <label for="admin-password">密码</label><div class="admin-password-field"><input id="admin-password" type="password" autocomplete="current-password" maxlength="256" required><button id="admin-password-toggle" type="button" class="admin-secondary" aria-controls="admin-password" aria-pressed="false">显示密码</button></div>
        <button type="submit">邮箱登录</button></form>
      <div class="admin-links"><button type="button" data-page="token">使用一次性登录凭据</button><button type="button" data-page="reset">忘记密码</button></div>
    </section>
    <section data-panel="token" hidden><form id="admin-token-login"><label for="admin-token">一次性登录凭据</label>
      <input id="admin-token" type="password" autocomplete="off" maxlength="43" required><p>由主管理员签发，有效期 10 分钟，验证后即可进入管理。</p>
      <button type="submit">验证并进入</button></form><button class="admin-back" type="button" data-page="login">返回邮箱登录</button></section>
    <section data-panel="reset" hidden><form id="admin-reset-start"><label for="admin-reset-email">管理员邮箱</label>
      <input id="admin-reset-email" type="email" autocomplete="username" maxlength="254" required><button type="submit">申请密码重置</button></form>
      <form id="admin-reset-finish" hidden><label for="admin-reset-code">邮件验证码（6 位数字）</label><input id="admin-reset-code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" minlength="6" maxlength="6" required>
        <label for="admin-reset-password">新密码（8–18 个字符）</label><div class="admin-password-field"><input id="admin-reset-password" type="password" autocomplete="new-password" pattern=".{8,18}" maxlength="36" required><button id="admin-reset-password-toggle" type="button" class="admin-secondary" aria-controls="admin-reset-password" aria-pressed="false">显示密码</button></div>
        <p>重置密码会退出此账号的其他登录，但不会改变管理权限。</p><button type="submit">重置密码</button></form>
      <button class="admin-back" type="button" data-page="login">返回邮箱登录</button></section>
    <section data-panel="account" hidden><h2>我的账号</h2><p id="admin-account-info"></p>
      <form id="admin-bind-start"><label for="admin-bind-email">用于以后登录的邮箱</label><input id="admin-bind-email" type="email" autocomplete="username" maxlength="254" required>
        <button type="submit">验证邮箱</button></form>
      <form id="admin-bind-finish" hidden><label for="admin-bind-code">邮件验证码（6 位数字）</label><input id="admin-bind-code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" minlength="6" maxlength="6" required>
        <label for="admin-bind-password">设置密码（8–18 个字符）</label><div class="admin-password-field"><input id="admin-bind-password" type="password" autocomplete="new-password" pattern=".{8,18}" maxlength="36" required><button id="admin-bind-password-toggle" type="button" class="admin-secondary" aria-controls="admin-bind-password" aria-pressed="false">显示密码</button></div>
        <button type="submit">完成邮箱绑定</button></form>
      <button id="admin-account-continue" class="admin-back" type="button" data-page="home">进入管理</button></section>
    <section data-panel="invites" hidden><h2>玩家邀请码</h2><p id="admin-no-permissions" hidden>当前没有管理功能权限。账号和登录保留，你仍可管理自己的邮箱登录方式。</p>
      <form id="admin-invite-issue"><label for="admin-batch">批次标识</label><input id="admin-batch" maxlength="128" required>
        <label for="admin-note">备注（可选）</label><input id="admin-note" maxlength="500">
        <label for="admin-deadline">兑换截止时间（本机时区）</label><input id="admin-deadline" type="datetime-local" required>
        <p>这是兑换截止时间，不是受邀后的体验期限。</p><button type="submit">手动生成玩家邀请码</button></form>
      <div id="admin-invite-records"></div>
      <details id="admin-invite-manual"><summary>按记录 ID 撤销</summary><p>没有查看记录的权限时，可由主管理员提供记录 ID。请核对撤销范围。</p><form id="admin-invite-revoke"><label for="admin-revoke-id">需要撤销的记录 ID</label><input id="admin-revoke-id" required maxlength="128">
        <label for="admin-revoke-kind">撤销范围</label><select id="admin-revoke-kind"><option value="code">邀请码（不影响已兑换的体验授权）</option><option value="grant">已兑换的体验授权</option></select>
        <label><input id="admin-revoke-confirm" type="checkbox" required>我已核对记录和范围；此操作不会删除账号或聊天。</label><button type="submit">确认撤销该记录</button></form></details>
    </section>
    <section data-panel="characters" hidden><div id="admin-characters"></div></section>
    <section data-panel="cocreation" hidden><div id="admin-cocreation"></div></section>
    <section data-panel="members" hidden><h2>管理员权限</h2><p>调整功能权限不退出对方账号，也不影响玩家会话或存档。</p>
      <details class="admin-new-member"><summary>添加管理员 · 签发一次性登录凭据</summary><form id="admin-member-issue"><label for="admin-member-label">管理员备注（便于识别，不是职位）</label><input id="admin-member-label" maxlength="80" required>
        <p>按功能区勾选需要的权限（也可先套用快速设置），再签发一次性登录凭据。使用凭据后立即获得所选权限；邮箱绑定可稍后完成。</p><div id="admin-new-permissions"></div>
        <button type="submit">签发管理员一次性凭据</button></form></details>
      <button class="admin-back" id="admin-members-refresh" type="button">刷新权限列表</button><div id="admin-members-list"></div>
    </section>
    <section data-panel="preview" hidden><div id="admin-preview" class="admin-fill"></div></section>
    <section data-panel="grants" hidden><div id="admin-grants"></div></section>
    <section data-panel="ops" hidden><div id="admin-ops"></div></section>
    </div>
    </div>
    <p class="invite-admin-status admin-statusbar" role="status" aria-live="polite">正在检查登录状态…</p>
  </main>`;
  const q = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const value = (id: string) => q<HTMLInputElement>(`#${id}`).value;
  const status = q<HTMLElement>('.invite-admin-status');
  let session: AccountAdminSession | null = null,
    page: AdminPage | 'login' | 'token' | 'reset' = 'login',
    routeId: string | null = null,
    busy = true,
    disposed = false;
  let bindId: string | null = null,
    resetId: string | null = null,
    issueUnknown = false,
    memberUnknown = false;
  const cleanups: Array<() => void> = [];
  const can = (permission: InviteAdminPermission) =>
    session?.member.role === 'owner' || (!!session && hasInvitePermission(session.member.permissions, permission));
  const access = (): NavAccess => ({
    owner: session?.member.role === 'owner',
    permissions: session?.member.permissions ?? [],
    inbox: !!port.cocreation,
    metrics: !!port.stageLatency,
  });
  const canEditCharacter = (characterId: string) =>
    session?.member.role === 'owner' ||
    (!!session && hasCharacterPermission(session.member.permissions, 'edit', characterId));
  const address = addressBar(window);
  let workbench: ReturnType<typeof characterWorkbench> | null = null;
  let previewBench: {
    open(id: string): Promise<void>;
    update(busy: boolean): void;
    clear(): void;
    dispose(): void;
  } | null = null;
  let inbox: ReturnType<typeof cocreationInbox> | null = null;
  // New (unread) co-creation submissions per character: the badge in the character workbench.
  let unread: Record<string, number> = {};
  /** Grouped permissions with 共生项 and presets; the inbox group only when this page has an inbox. */
  const permissionControls = (host: HTMLElement, initial: readonly AdminPermission[]) =>
    permissionMatrixEditor(host, initial, { cocreation: !!port.cocreation });
  const canCocreation = (permission: CocreationAdminPermission) =>
    !!port.cocreation &&
    (session?.member.role === 'owner' ||
      (!!session && hasCocreationPermission(session.member.permissions, permission)));
  const refreshCounts = async () => {
    if (!port.cocreation || !canCocreation('cocreation.read')) {
      unread = {};
      return;
    }
    try {
      const counts = await port.cocreation.counts();
      if (!disposed) unread = counts;
    } catch {
      /* The badge is a convenience; the inbox itself reports real errors. */
    }
  };
  let newPermissions: ReturnType<typeof permissionControls> | null = null;
  // Opening a page loads its list and then the role in the address; the workbench's own "view changed" reports are muted meanwhile.
  let quiet = 0;
  let navCollapsed = false;
  try {
    navCollapsed = localStorage.getItem('fakebubble.admin.nav') === 'collapsed';
  } catch {
    /* A per-viewer convenience only; the page works without it. */
  }
  const canPreview = (characterId: string) =>
    session?.member.role === 'owner' ||
    (!!session &&
      hasCharacterPermission(session.member.permissions, 'read', characterId) &&
      hasCharacterPermission(session.member.permissions, 'preview', characterId));
  const reissueUnknown = new Set<string>();
  const passwordIds = ['admin-password', 'admin-bind-password', 'admin-reset-password'];
  const concealPassword = (id: string) => {
    q<HTMLInputElement>(`#${id}`).type = 'password';
    const button = q<HTMLButtonElement>(`#${id}-toggle`);
    button.textContent = '显示密码';
    button.setAttribute('aria-pressed', 'false');
  };
  const clearSecrets = () => {
    // Explicit IDs also clear secrets while their input is temporarily visible as text.
    for (const id of [...passwordIds, 'admin-token', 'admin-bind-code', 'admin-reset-code'])
      q<HTMLInputElement>(`#${id}`).value = '';
    for (const id of passwordIds) concealPassword(id);
    q<HTMLElement>('#admin-secret-value').textContent = '';
    q<HTMLElement>('#admin-secret').hidden = true;
  };
  const render = () => {
    for (const panel of root.querySelectorAll<HTMLElement>('[data-panel]')) panel.hidden = panel.dataset.panel !== page;
    const who = session ? (session.member.email ?? session.member.label) : '';
    q<HTMLElement>('.admin-identity').textContent = session
      ? `${session.member.role === 'owner' ? '主管理员' : '管理员'} · ${who}`
      : '';
    q<HTMLElement>('#admin-account-toggle').textContent = who ? `${who} ▾` : '';
    q<HTMLElement>('.admin-account').hidden = !session;
    if (!session) closeMenu();
    q<HTMLElement>('.admin-nav').hidden = !session;
    // Hidden, never disabled: an item the administrator may not use is simply not there.
    const visible = access();
    for (const group of NAV_TREE) {
      let any = false;
      for (const item of group.items) {
        const show = !!session && canSeePage(item.page, visible);
        q<HTMLElement>(`[data-page="${item.page}"]`).hidden = !show;
        any ||= show;
      }
      q<HTMLElement>(`[data-group="${group.id}"]`).hidden = !any;
    }
    if (page === 'cocreation') inbox?.activate();
    else inbox?.deactivate();
    q<HTMLElement>('#admin-account-continue').textContent = session?.member.email ? '进入管理' : '稍后绑定，进入管理';
    q<HTMLElement>('#admin-bind-start').hidden = !!session?.member.email || !!bindId;
    q<HTMLElement>('#admin-bind-finish').hidden = !bindId;
    q<HTMLElement>('#admin-reset-start').hidden = !!resetId;
    q<HTMLElement>('#admin-reset-finish').hidden = !resetId;
    q<HTMLElement>('#admin-account-info').textContent = session?.member.email
      ? `已绑定：${session.member.email}`
      : session?.emailDeliveryAvailable
        ? '你已可以管理。绑定邮箱仅用于以后方便登录，也可以稍后再做。'
        : '你已可以管理。邮件服务尚未就绪，暂不能绑定邮箱。';
    q<HTMLElement>('#admin-invite-issue').hidden = !can('invites.issue');
    const revokeCode = can('invites.revoke-code'),
      revokeAccess = can('invites.revoke-access');
    q<HTMLElement>('#admin-invite-revoke').hidden = !revokeCode && !revokeAccess;
    q<HTMLElement>('#admin-invite-manual').hidden = !revokeCode && !revokeAccess;
    q<HTMLElement>('#admin-invite-records').hidden = !can('invites.read');
    if (!can('invites.read')) records.clear();
    q<HTMLOptionElement>('#admin-revoke-kind option[value=code]').hidden = !revokeCode;
    q<HTMLOptionElement>('#admin-revoke-kind option[value=grant]').hidden = !revokeAccess;
    const kind = q<HTMLSelectElement>('#admin-revoke-kind');
    if (kind.value === 'grant' && !revokeAccess) kind.value = 'code';
    if (kind.value !== 'grant' && !revokeCode) kind.value = 'grant';
    q<HTMLElement>('#admin-no-permissions').hidden =
      can('invites.read') || can('invites.issue') || revokeCode || revokeAccess;
    for (const control of root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>(
      'button,input,select,textarea',
    ))
      control.disabled = busy || control.dataset.locked === 'true';
    q<HTMLButtonElement>('#admin-bind-start button').disabled = busy || !session?.emailDeliveryAvailable;
    q<HTMLButtonElement>('#admin-invite-issue button').disabled = busy || issueUnknown;
    q<HTMLButtonElement>('#admin-member-issue button').disabled = busy || memberUnknown || !newPermissions;
    newPermissions?.setDisabled(busy || memberUnknown);
    q<HTMLElement>('main').setAttribute('data-surface', session ? page : 'login');
    workbench?.update(busy);
    previewBench?.update(busy);
    q<HTMLElement>('main').setAttribute('data-nav', navCollapsed ? 'collapsed' : 'expanded');
    q<HTMLElement>('#admin-nav-collapse').setAttribute('aria-pressed', String(navCollapsed));
    for (const nav of root.querySelectorAll<HTMLElement>('.admin-nav [data-page]')) {
      if (nav.dataset.page === page) nav.setAttribute('aria-current', 'page');
      else nav.removeAttribute('aria-current');
    }
  };
  const WITH_ID: readonly string[] = ['characters', 'preview', 'cocreation'];
  const closeMenu = () => {
    q<HTMLElement>('#admin-account-menu').hidden = true;
    q<HTMLElement>('#admin-account-toggle').setAttribute('aria-expanded', 'false');
  };
  const toggleMenu = () => {
    const menu = q<HTMLElement>('#admin-account-menu');
    menu.hidden = !menu.hidden;
    q<HTMLElement>('#admin-account-toggle').setAttribute('aria-expanded', String(!menu.hidden));
  };
  /** Which page the administrator is on, as the address bar shows it. */
  const here = (): AdminRoute | null => (session && isAdminPage(page) ? { page, id: routeId } : null);
  const navigate = (next: string, id: string | null = null, options: { replaceUrl?: boolean } = {}) => {
    const wanted = next === 'home' && session ? firstAllowedPage(access()) : next;
    const target =
      session && isAdminPage(wanted) && !canSeePage(wanted, access()) ? firstAllowedPage(access()) : wanted;
    const targetId = WITH_ID.includes(target) && target === wanted ? id : null;
    if (
      page === 'characters' &&
      workbench &&
      !workbench.canLeave() &&
      !(target === 'characters' && targetId === routeId)
    ) {
      status.textContent = '请先保存草稿，或放弃本页修改后再切换。';
      return false;
    }
    clearSecrets();
    bindId = null;
    resetId = null;
    page = target as typeof page;
    routeId = targetId;
    status.textContent = '';
    closeMenu();
    if (target === 'preview') picker.select(routeId);
    render();
    q<HTMLElement>('.admin-content').focus();
    const route = here();
    if (route) {
      if (options.replaceUrl) address.replace(route);
      else address.push(route);
    }
    return true;
  };
  /** What opening the current page has to load, or null when it only shows what is already there. */
  const loader = (): (() => Promise<void>) | null => {
    if (!session) return null;
    if (page === 'characters')
      return async () => {
        await refreshCounts();
        quiet++;
        try {
          await workbench!.load();
          if (routeId) await workbench!.open(routeId);
        } finally {
          quiet--;
        }
      };
    if (page === 'preview')
      return async () => {
        const result = await port.characters.list();
        if (disposed) return;
        picker.show(result.characters.filter((c) => canPreview(c.characterId)));
        picker.select(routeId);
        if (routeId) await previewBench!.open(routeId);
        else previewSplit.detail.replaceChildren(previewHint());
      };
    if (page === 'cocreation' && inbox && canCocreation('cocreation.read'))
      return () => {
        // #/cocreation/<id> is the inbox filtered to that character (the badge on its card); plain #/cocreation keeps the filter.
        if (routeId) inbox!.showCharacter(routeId);
        return inbox!.load();
      };
    if (page === 'members') return loadMembers;
    if (page === 'invites' && can('invites.read')) return () => records.load();
    if (page === 'grants' && can('invites.read')) return () => grants.load();
    if (page === 'ops' && session.member.role === 'owner' && port.stageLatency) return () => ops.load();
    return null;
  };
  const run = async (work: () => Promise<void>) => {
    if (busy || disposed) return;
    busy = true;
    render();
    try {
      await work();
    } catch (error) {
      if (disposed) return;
      if (error instanceof InviteLocalApiError && error.status === 401 && error.code !== 'ADMIN_LOGIN_INVALID') {
        session = null;
        page = 'login';
        clearSecrets();
        clearManagement();
      }
      status.textContent = adminAccountError(error);
      if (error instanceof InviteLocalApiError && error.code === 'ADMIN_PERMISSION_REQUIRED') {
        try {
          adoptSession(await port.restore());
        } catch {
          /* Keep the error; the next request still rechecks server authority. */
        }
      }
    } finally {
      busy = false;
      if (!disposed) render();
    }
  };
  const listen = (element: HTMLElement, event: string, callback: (event: Event) => void) => {
    element.addEventListener(event, callback);
    cleanups.push(() => element.removeEventListener(event, callback));
  };
  for (const id of passwordIds)
    listen(q(`#${id}-toggle`), 'click', () => {
      if (busy || disposed) return;
      const input = q<HTMLInputElement>(`#${id}`),
        visible = input.type === 'password';
      input.type = visible ? 'text' : 'password';
      const button = q<HTMLButtonElement>(`#${id}-toggle`);
      button.textContent = visible ? '隐藏密码' : '显示密码';
      button.setAttribute('aria-pressed', String(visible));
    });
  const submit = (selector: string, work: () => Promise<void>) =>
    listen(q(selector), 'submit', (event) => {
      event.preventDefault();
      void run(work);
    });
  const active = async (result: AccountAdminSession) => {
    if (disposed) return;
    session = result;
    clearSecrets();
    bindId = null;
    resetId = null;
    // Reload keeps the place (the address bar); otherwise the first page this administrator may use.
    const wanted = address.read();
    const landing: AdminRoute =
      wanted && canSeePage(wanted.page, access())
        ? wanted
        : { page: result.member.email ? firstAllowedPage(access()) : 'account', id: null };
    page = landing.page;
    routeId = landing.id;
    address.replace(landing);
    status.textContent = '已登录。';
    const load = loader();
    if (load) await load();
  };
  const showSecret = (label: string, secret: string | null) => {
    if (disposed) return;
    q<HTMLElement>('#admin-secret-label').textContent = label;
    q<HTMLElement>('#admin-secret-value').textContent = secret ?? '';
    q<HTMLElement>('#admin-secret').hidden = !secret;
    status.textContent = secret
      ? '请现在安全记录，仅显示一次；不要在公开聊天中发送。'
      : '请求已处理，原凭据无法再次显示。请核对列表，不要重复创建。';
  };
  const workbenchHost = {
    api: port.characters,
    member: () => session?.member ?? null,
    run,
    status: (text: string) => {
      if (!disposed) status.textContent = text;
    },
    disposed: () => disposed,
  };
  // 角色资料 no longer carries the paid preview; it has its own page (the second workbench, preview only).
  workbench = characterWorkbench(q('#admin-characters'), {
    ...workbenchHost,
    badges: () => unread,
    openInbox: (characterId) => {
      if (busy || disposed || !navigate('cocreation', characterId)) return;
      const load = loader();
      if (load) void run(load);
    },
    preview: 'none',
    onView: (id) => {
      if (quiet || page !== 'characters') return;
      routeId = id;
      address.push({ page: 'characters', id });
    },
  });
  const previewSplit = splitPane(q('#admin-preview'), { label: '调整角色列表宽度' });
  const previewHint = () => {
    const note = document.createElement('p');
    note.className = 'admin-empty';
    note.textContent = '从左侧选择要预演的角色。预演只发送该角色的已存草稿和你输入的合成内容。';
    return note;
  };
  const picker = rolePicker(previewSplit.list, {
    emptyText: '没有可预演的角色。预演需要“查看角色”和“预演测试”权限。',
    onPick: (characterId) => {
      if (busy || disposed || !navigate('preview', characterId)) return;
      void run(() => previewBench!.open(characterId));
    },
  });
  previewBench = port.previews
    ? previewWorkbench(previewSplit.detail, {
        api: port.previews,
        characters: port.characters,
        member: () => session?.member ?? null,
        run,
        status: (text: string) => {
          if (!disposed) status.textContent = text;
        },
        disposed: () => disposed,
        toast: (text, tone) => toasts.show(text, tone ?? 'info'),
        modalParent: () => q('main'),
      })
    : characterWorkbench(previewSplit.detail, { ...workbenchHost, preview: 'only' });
  inbox = port.cocreation
    ? cocreationInbox(q('#admin-cocreation'), {
        api: port.cocreation,
        characters: port.characters,
        canManage: () => canCocreation('cocreation.manage'),
        canEditCharacter,
        run,
        status: (text) => {
          if (!disposed) status.textContent = text;
        },
        disposed: () => disposed,
        onChanged: () => void refreshCounts(),
      })
    : null;
  const records = inviteRecords(q('#admin-invite-records'), port, can, run, () => disposed);
  const toasts = toastHost(q('main'));
  const grants = grantsView(q('#admin-grants'), {
    port,
    can,
    run,
    disposed: () => disposed,
    toast: (text) => toasts.show(text, 'ok'),
  });
  const ops = opsView(q('#admin-ops'), {
    load: (days) => (port.stageLatency ? port.stageLatency(days) : Promise.resolve([])),
    run,
    disposed: () => disposed,
  });
  const clearMemberControls = () => {
    q('#admin-members-list').replaceChildren();
    q('#admin-new-permissions').replaceChildren();
    newPermissions = null;
  };
  const clearManagement = () => {
    records.clear();
    clearMemberControls();
    workbench?.clear();
    previewBench?.clear();
    previewSplit.detail.replaceChildren();
    picker.clear();
    grants.clear();
    ops.clear();
    inbox?.clear();
    unread = {};
  };
  const adoptSession = (current: AccountAdminSession) => {
    if (session && (session.member.id !== current.member.id || session.csrf !== current.csrf)) {
      clearSecrets();
      clearManagement();
      bindId = null;
      resetId = null;
      issueUnknown = false;
      memberUnknown = false;
      reissueUnknown.clear();
      page = 'account';
      status.textContent = '登录身份或会话已改变，已清除上一会话的本页资料与请求；没有自动提交。';
    }
    session = current;
  };
  const loadMembers = async () => {
    const result = await port.members();
    if (disposed) return;
    const selected = newPermissions?.value() ?? [];
    q('#admin-new-permissions').replaceChildren();
    newPermissions = permissionControls(q('#admin-new-permissions'), selected);
    const list = q<HTMLElement>('#admin-members-list');
    list.replaceChildren();
    for (const member of result.members) {
      const item = document.createElement('details');
      item.className = 'admin-member';
      const heading = document.createElement('summary');
      heading.textContent = `${member.label} · ${member.role === 'owner' ? '主管理员' : `已分配 ${member.permissions.length} 项授权`}`;
      item.append(heading);
      const detail = document.createElement('p');
      detail.textContent = member.email ?? '尚未绑定邮箱';
      item.append(detail);
      if (member.role === 'owner') {
        const owner = document.createElement('p');
        owner.textContent = '主管理员保留所有功能权限，不能在此撤权。';
        item.append(owner);
      } else {
        const controls = document.createElement('div');
        item.append(controls);
        const editor = permissionControls(controls, member.permissions);
        const save = document.createElement('button');
        save.type = 'button';
        save.textContent = `保存 ${member.label} 的权限`;
        save.addEventListener('click', () => {
          void run(async () => {
            const selected = editor.value();
            if (selected.length > ADMIN_PERMISSION_LIMIT) {
              status.textContent = '原授权数据异常，请重新读取后处理。';
              return;
            }
            await port.setPermissions(member.id, selected, member.permissions);
            await loadMembers();
            if (!disposed) status.textContent = '权限已更新，对方账号和登录会话保持不变。';
          });
        });
        item.append(save);
        const confirm = document.createElement('details');
        confirm.className = 'admin-confirm';
        const summary = document.createElement('summary');
        summary.textContent = `收回 ${member.label} 的全部功能权限`;
        const note = document.createElement('p');
        note.textContent = '只收回管理功能。此账号仍可登录，所有会话、邮箱和玩家聊天保持不变。';
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = '确认收回全部功能权限';
        remove.addEventListener('click', () => {
          void run(async () => {
            await port.setPermissions(member.id, [], member.permissions);
            await loadMembers();
            if (!disposed) status.textContent = '已收回全部管理功能权限，账号及登录会话保留。';
          });
        });
        confirm.append(summary, note, remove);
        item.append(confirm);
        const reissue = document.createElement('button');
        reissue.type = 'button';
        reissue.className = 'admin-secondary';
        reissue.textContent = reissueUnknown.has(member.id)
          ? '上次签发结果未确认，请核对未用凭据'
          : '为此管理员签发新登录凭据';
        reissue.dataset.locked = String(reissueUnknown.has(member.id));
        reissue.addEventListener('click', () => {
          if (reissueUnknown.has(member.id)) return;
          void run(async () => {
            reissueUnknown.add(member.id);
            reissue.dataset.locked = 'true';
            const result = await port.issueMember({
              requestId: crypto.randomUUID(),
              label: member.label,
              memberId: member.id,
              permissions: member.permissions,
            });
            reissueUnknown.delete(member.id);
            showSecret('管理员一次性登录凭据 · 权限保持原样', result.token);
            await loadMembers();
          });
        });
        item.append(reissue);
      }
      for (const grant of result.grants.filter(
        (g) => g.memberId === member.id && !g.consumed && g.revokedAt === null && g.expiresAt > Date.now(),
      )) {
        if (member.role === 'owner') continue;
        const revoke = document.createElement('button');
        revoke.type = 'button';
        revoke.className = 'admin-secondary';
        revoke.textContent = `撤销未用登录凭据 · ${new Date(grant.expiresAt).toLocaleString()} 到期`;
        revoke.addEventListener('click', () => {
          void run(async () => {
            await port.revokeCredential(grant.id);
            await loadMembers();
          });
        });
        item.append(revoke);
      }
      list.append(item);
    }
  };
  for (const button of root.querySelectorAll<HTMLElement>('[data-page]'))
    listen(button, 'click', (event) => {
      const click = event as MouseEvent;
      // Let the browser open a link in a new tab; everything else is handled here so unsaved edits are guarded.
      if (click.metaKey || click.ctrlKey || click.shiftKey || click.button === 1) return;
      event.preventDefault();
      if (busy || disposed) return;
      // Already on this page: nothing to do (each page has its own refresh button).
      if (isAdminPage(button.dataset.page!) && sameRoute({ page: button.dataset.page, id: null }, here())) return;
      if (!navigate(button.dataset.page!)) return;
      const load = loader();
      if (load) void run(load);
    });
  listen(q('#admin-account-toggle'), 'click', toggleMenu);
  listen(q('#admin-nav-collapse'), 'click', () => {
    navCollapsed = !navCollapsed;
    try {
      localStorage.setItem('fakebubble.admin.nav', navCollapsed ? 'collapsed' : 'expanded');
    } catch {
      /* Not remembered; still collapsed for this visit. */
    }
    render();
  });
  const onWindowClick = (event: Event) => {
    const menu = q<HTMLElement>('#admin-account-menu');
    if (menu.hidden || q<HTMLElement>('.admin-account').contains?.(event.target as Node)) return;
    closeMenu();
  };
  const onWindowKey = (event: Event) => {
    if ((event as KeyboardEvent).key === 'Escape') closeMenu();
  };
  window.addEventListener('click', onWindowClick);
  window.addEventListener('keydown', onWindowKey);
  cleanups.push(() => {
    window.removeEventListener('click', onWindowClick);
    window.removeEventListener('keydown', onWindowKey);
  });
  // Back/Forward and edited addresses: follow the hash, but never past unsaved edits or a request in flight.
  const stopHash = address.listen(() => {
    const wanted = address.read();
    if (!session || disposed || !wanted || sameRoute(wanted, here())) return;
    const before = here();
    if (busy || !navigate(wanted.page, wanted.id, { replaceUrl: true })) {
      if (busy) status.textContent = '请等待当前操作完成后再切换。';
      address.replace(before);
      return;
    }
    const load = loader();
    if (load) void run(load);
  });
  cleanups.push(stopHash);
  submit('#admin-email-login', async () => {
    const email = value('admin-email'),
      password = value('admin-password');
    q<HTMLInputElement>('#admin-password').value = '';
    concealPassword('admin-password');
    await active(await port.emailLogin(email, password));
  });
  submit('#admin-token-login', async () => {
    const token = value('admin-token');
    q<HTMLInputElement>('#admin-token').value = '';
    await active(await port.login(token));
  });
  submit('#admin-bind-start', async () => {
    const result = await port.bindStart(value('admin-bind-email'));
    if (disposed) return;
    bindId = result.challengeId;
    status.textContent = '验证请求已提交。请查收邮件，输入最新验证码；暂未收到时不要连续申请。';
  });
  submit('#admin-bind-finish', async () => {
    if (!bindId) return;
    const password = value('admin-bind-password');
    q<HTMLInputElement>('#admin-bind-password').value = '';
    concealPassword('admin-bind-password');
    await active(await port.bindFinish(bindId, value('admin-bind-code').trim(), password));
    if (!disposed) status.textContent = '邮箱已绑定，以后可使用邮箱和密码登录。';
  });
  submit('#admin-reset-start', async () => {
    const result = await port.resetStart(value('admin-reset-email'));
    if (disposed) return;
    resetId = result.challengeId;
    status.textContent = '请求已提交。如果该邮箱已绑定账号，将收到重置邮件。';
  });
  submit('#admin-reset-finish', async () => {
    if (!resetId) return;
    const password = value('admin-reset-password');
    q<HTMLInputElement>('#admin-reset-password').value = '';
    concealPassword('admin-reset-password');
    await port.resetFinish(resetId, value('admin-reset-code').trim(), password);
    if (disposed) return;
    session = null;
    navigate('login');
    status.textContent = '密码已重置，请用新密码登录。';
  });
  submit('#admin-invite-issue', async () => {
    if (issueUnknown || !can('invites.issue')) return;
    const redeemBy = new Date(value('admin-deadline')).getTime();
    if (!Number.isSafeInteger(redeemBy) || redeemBy <= Date.now()) {
      status.textContent = '请填写未来的兑换截止时间。';
      return;
    }
    try {
      const result = await port.issue({
        requestId: crypto.randomUUID(),
        redeemBy,
        batch: value('admin-batch').trim(),
        note: value('admin-note').trim() || null,
      });
      showSecret('玩家邀请码（不是管理员登录凭据）', result.code);
    } catch (error) {
      issueUnknown = true;
      throw error;
    }
  });
  submit('#admin-invite-revoke', async () => {
    const kind = value('admin-revoke-kind') === 'code' ? 'code' : 'grant';
    if (
      !can(kind === 'code' ? 'invites.revoke-code' : 'invites.revoke-access') ||
      !q<HTMLInputElement>('#admin-revoke-confirm').checked
    )
      return;
    await port.revokeInvite(kind, value('admin-revoke-id').trim());
    q<HTMLInputElement>('#admin-revoke-confirm').checked = false;
    if (can('invites.read')) await records.load();
    if (!disposed) status.textContent = '指定记录已撤销。';
  });
  submit('#admin-member-issue', async () => {
    if (memberUnknown || session?.member.role !== 'owner') return;
    if (!newPermissions) return;
    const permissions = newPermissions.value();
    if (permissions.length > ADMIN_PERMISSION_LIMIT) {
      status.textContent = '原授权数据异常，请重新读取后处理。';
      return;
    }
    try {
      const result = await port.issueMember({
        requestId: crypto.randomUUID(),
        label: value('admin-member-label').trim(),
        memberId: null,
        permissions,
      });
      showSecret('管理员一次性登录凭据 · 10 分钟内使用', result.token);
      await loadMembers();
    } catch (error) {
      memberUnknown = true;
      throw error;
    }
  });
  listen(q('#admin-members-refresh'), 'click', () => {
    void run(loadMembers);
  });
  listen(q('#admin-secret-close'), 'click', clearSecrets);
  listen(q('#admin-logout'), 'click', () => {
    void run(async () => {
      if (!workbench?.canLeave()) {
        status.textContent = '请先保存草稿，或放弃本页修改后退出。';
        return;
      }
      clearSecrets();
      await port.logout();
      if (disposed) return;
      session = null;
      clearManagement();
      navigate('login');
      address.replace(null);
      status.textContent = '已退出登录。';
    });
  });
  const refresh = () => {
    if (!session || busy || disposed) return;
    void run(async () => {
      const current = await port.restore();
      if (disposed) return;
      adoptSession(current);
      if (current.member.role !== 'owner') {
        clearMemberControls();
        if (page === 'members') page = 'account';
      }
      // A page whose permission was just taken away is no longer offered; the pages that explain themselves stay.
      if (isAdminPage(page) && page !== 'invites' && page !== 'characters' && !canSeePage(page, access())) {
        page = 'account';
        routeId = null;
        address.replace({ page, id: null });
      }
    });
  };
  window.addEventListener('focus', refresh);
  cleanups.push(() => window.removeEventListener('focus', refresh));
  q<HTMLElement>('#admin-env').textContent = environmentLabel(window.location?.hostname);
  render();
  void port
    .restore()
    .then((result) => active(result))
    .catch((error) => {
      if (!disposed && error instanceof InviteLocalApiError && error.status === 401) {
        session = null;
        page = 'login';
        clearSecrets();
        clearManagement();
      }
      if (!disposed)
        status.textContent =
          error instanceof InviteLocalApiError && error.status === 401
            ? '请使用管理员邮箱登录，或选择一次性凭据。'
            : adminAccountError(error);
    })
    .finally(() => {
      busy = false;
      if (!disposed) render();
    });
  return () => {
    disposed = true;
    clearSecrets();
    session = null;
    workbench?.dispose();
    previewBench?.dispose();
    toasts.dispose();
    inbox?.dispose();
    for (const cleanup of cleanups) cleanup();
    root.replaceChildren();
  };
}

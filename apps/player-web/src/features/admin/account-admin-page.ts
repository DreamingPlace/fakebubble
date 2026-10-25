import type { AccountAdminApi, AccountAdminSession } from '../../services/account-admin-api.ts';
import { characterWorkbench, characterAdminError } from './character-workbench.ts';
import { previewWorkbench } from './preview/preview-workbench.ts';
import type { PreviewAdminClient } from '../../services/preview-admin-api.ts';
import { permissionMatrixEditor } from './permission-matrix.ts';
import { overviewView } from './overview-view.ts';
import { pointsView } from './points-view.ts';
import { systemView } from './system-view.ts';
import { statsView } from './stats-view.ts';
import { costsView } from './costs-view.ts';
import { modelsView } from './models-view.ts';
import { confirmDialog } from './ui/confirm-dialog.ts';
import { rolePicker } from './shell/role-picker.ts';
import { wordmarkSvg } from '../brand/wordmark.ts';
import {
  canSeePage,
  firstAllowedPage,
  groupPages,
  isAdminPage,
  navMarkup,
  navTree,
  type AdminPage,
  type NavAccess,
} from './shell/admin-nav.ts';
import { addressBar, sameRoute, type AdminRoute } from './shell/admin-router.ts';
import { splitPane } from './ui/split-pane.ts';
import { toastHost } from './ui/toast.ts';
import { cocreationInbox } from './cocreation-inbox.ts';
import { conversationsView } from './conversations-view.ts';
import type { ConversationsAdminClient } from '../../services/conversations-admin-api.ts';
import type { CocreationAdminClient } from '../../services/cocreation-admin-api.ts';
import { browserDownload, inviteTiersView } from './invite-tiers-view.ts';
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
  | 'characters'
> & {
  /** 预演测试 workbench (runs, eval sets, batched status). Without it the page keeps the single-preview panel. */
  previews?: PreviewAdminClient;
  /** 概览, 系统状态 and 积分发放 (Part 22b). Optional: a page without `overview` has none of them in the nav. */
  overview?: AccountAdminApi['overview'];
  systemStatus?: AccountAdminApi['systemStatus'];
  renewPrices?: AccountAdminApi['renewPrices'];
  budgetTopUp?: AccountAdminApi['budgetTopUp'];
  pointsPreview?: AccountAdminApi['pointsPreview'];
  pointsGrant?: AccountAdminApi['pointsGrant'];
  resetPreview?: AccountAdminApi['resetPreview'];
  resetPoints?: AccountAdminApi['resetPoints'];
  /** 玩家统计 and 消耗表 (Part 22c): the owner or stats.read. Optional: a page without them has neither in the nav. */
  playerStats?: AccountAdminApi['playerStats'];
  exportPlayerStats?: AccountAdminApi['exportPlayerStats'];
  costs?: AccountAdminApi['costs'];
  exportCosts?: AccountAdminApi['exportCosts'];
  /** 总览's chart, 消耗表 by user type and 玩家统计's chat users (Part 22d / 24b-1): the owner or stats.read. Optional like the rest. */
  chart?: AccountAdminApi['chart'];
  spendByType?: AccountAdminApi['spendByType'];
  /** 邀请与额度 (the owner, or an administrator holding invites.manage). Optional: a page without them shows nothing on that page. */
  inviteBatches?: AccountAdminApi['inviteBatches'];
  inviteBatchDetail?: AccountAdminApi['inviteBatchDetail'];
  exportInviteBatch?: AccountAdminApi['exportInviteBatch'];
  createInviteBatch?: AccountAdminApi['createInviteBatch'];
  editInviteBatch?: AccountAdminApi['editInviteBatch'];
  revokeInviteBatch?: AccountAdminApi['revokeInviteBatch'];
  revokeTierCode?: AccountAdminApi['revokeTierCode'];
  revokeEntitlement?: AccountAdminApi['revokeEntitlement'];
  /** 系统 → 模型与价格 (any administrator may read; saving needs the owner role or models.manage). Optional: a page without it has no such page. */
  modelSettings?: AccountAdminApi['modelSettings'];
  saveModelSettings?: AccountAdminApi['saveModelSettings'];
  /** 共创收件箱. Optional: a page without it simply has no inbox tab. */
  cocreation?: Pick<CocreationAdminClient, 'counts' | 'list' | 'detail' | 'setStatus' | 'star' | 'note' | 'adopt'>;
  /** 测试对话 (CHAT_REVIEW_ENABLED; the page only appears when the session says the switch is on). */
  conversations?: Pick<ConversationsAdminClient, 'list' | 'detail' | 'export'>;
};
export function adminAccountError(error: unknown) {
  const characterError = characterAdminError(error);
  if (characterError) return characterError;
  const code = error instanceof InviteLocalApiError ? error.code : '';
  return (
    (
      {
        MODEL_TIER_EMPTY: '每一类玩家至少要保留一个已开启的模型，本次未保存。',
        MODEL_SETTINGS_CONFLICT: '设置已被另一位管理员修改。请重新打开本页核对最新内容后再保存；本次未覆盖。',
        WEB_INVITE_POINTS_REQUIRED: '需要先开启模型选择/积分，才能建每天补充的批次。',
        MODEL_SETTINGS_UNAVAILABLE: '这个站点的数据库还没有升级到模型与价格（迁移 124）。',
        PLAYER_NOT_FOUND: '没有找到这位玩家。请核对完整的邮箱或 8 位玩家编号。',
        POINTS_NOT_ENABLED: '积分功能还没有打开（PLAYER_MODEL_CHOICE_ENABLED），现在不能发放或重置。',
        BUDGET_UNLIMITED: '这个供应商的预算不限额，不需要充值。',
        BUDGET_UNAVAILABLE:
          '预算服务暂时没有回应，充值结果未确认。请重新打开本页核对剩余额度后再试（同一次点击不会重复充值）。',
        SYSTEM_UNAVAILABLE: '这个环境没有提供这项系统功能。',
        STATS_UNAVAILABLE: '这个站点的数据库还没有升级到统计功能（迁移 128）。',
        IDEMPOTENCY_CONFLICT: '这次提交与之前的同一请求内容不一致，请重新打开本页后重试。',
        INVALID_REQUEST: '填写的内容不符合要求（每条点数 1–200，语音加点 0–20，均为整数）。',
        ADMIN_PERMISSIONS_CONFLICT: '权限已被另一页面修改。请重新打开本页核对后再保存；本次未覆盖新权限。',
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
        ADMIN_EMAIL_ALREADY_BOUND: '此账号已绑定邮箱，请重新打开本页查看。',
        RATE_LIMITED: '操作太频繁，请稍后再试。',
        ACCESS_REQUIRED: '需要先通过 Cloudflare Access 验证身份。',
        ORIGIN_INVALID: '请从管理页面操作，不要直接打开接口地址。',
      } as Record<string, string>
    )[code] ?? '操作结果未确认。请重新打开本页核对当前状态，不要重复提交发码请求。'
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
      <div class="admin-brand"><h1 tabindex="-1">FAKE 泡泡管理</h1></div>
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
      <div class="admin-side-brand">${wordmarkSvg({ size: 30, weight: 2, logo: true, className: 'hand admin-hand' })}<span class="admin-tag">ADMIN</span><span class="admin-env" id="admin-env"></span></div>
      <div class="admin-nav-groups">${navMarkup()}</div>
    </nav>
    <div class="admin-content" tabindex="-1">
    <section class="admin-access-notice" id="admin-access" role="alert" hidden><p>需要先通过 Cloudflare Access 验证身份。</p>
      <button type="button" id="admin-access-enter">前往验证</button></section>
    <section class="invite-admin-result" id="admin-secret" hidden><span id="admin-secret-label"></span><strong class="invite-admin-code" id="admin-secret-value"></strong>
      <button id="admin-secret-close" type="button">已记录，清除显示</button></section>
    <section data-panel="login" hidden>
      <form id="admin-email-login"><label for="admin-email">管理员邮箱</label><input id="admin-email" type="email" autocomplete="username" maxlength="254" required>
        <label for="admin-password">密码</label><div class="admin-password-field"><input id="admin-password" type="password" autocomplete="current-password" maxlength="256" required><button id="admin-password-toggle" type="button" class="admin-secondary" aria-controls="admin-password" aria-pressed="false">显示密码</button></div>
        <button type="submit">邮箱登录</button></form>
      <div class="admin-links"><button type="button" data-page="token">使用一次性登录凭据</button><button type="button" data-page="reset">忘记密码</button></div>
    </section>
    <section data-panel="token" hidden><form id="admin-token-login"><label for="admin-token">一次性登录凭据</label>
      <input id="admin-token" type="password" autocomplete="off" maxlength="43" required><p>由主管理员签发，有效期 1 小时，验证后即可进入管理。</p>
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
    <section data-panel="invites" hidden><p id="admin-no-permissions" hidden>当前账号没有“邀请与额度”权限，请联系主管理员开通。</p><div id="admin-invites"></div></section>
    <section data-panel="characters" hidden><div id="admin-characters"></div></section>
    <section data-panel="cocreation" hidden><div id="admin-cocreation"></div></section>
    <section data-panel="members" hidden><h2>管理员与权限</h2>
      <div class="members-layout"><div class="members-side"><form id="admin-member-issue"><label for="admin-member-label">管理员备注</label><input id="admin-member-label" maxlength="80" required>
        <div id="admin-new-permissions"></div>
        <button type="submit">签发管理员一次性凭据</button></form></div>
      <div id="admin-members-list" class="members-list"></div></div>
    </section>
    <section data-panel="preview" hidden><div id="admin-preview" class="admin-fill"></div></section>
    <section data-panel="overview" hidden><div id="admin-overview"></div></section>
    <section data-panel="points" hidden><div id="admin-points"></div></section>
    <section data-panel="system" hidden><div id="admin-system"></div></section>
    <section data-panel="stats" hidden><div id="admin-stats"></div></section>
    <section data-panel="costs" hidden><div id="admin-costs"></div></section>
    <section data-panel="conversations" hidden><div id="admin-conversations"></div></section>
    <section data-panel="models" hidden><div id="admin-models"></div></section>
    </div>
    </div>
    <p class="invite-admin-status admin-statusbar sr-only" role="status" aria-live="polite"></p>
  </main>`;
  const q = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const value = (id: string) => q<HTMLInputElement>(`#${id}`).value;
  const statusLine = q<HTMLElement>('.invite-admin-status');
  // Feedback appears where it happened, one message at a time (the toast), and stays readable by a screen reader in the live
  // region; there is no status bar. Messages that only say "fine" are not shown at all.
  let toastSink: ((text: string, tone: 'info' | 'danger') => void) | null = null;
  const status = {
    get textContent() {
      return statusLine.textContent ?? '';
    },
    set textContent(text: string) {
      statusLine.textContent = text;
      if (text) toastSink?.(text, 'info');
    },
  };
  const accessNotice = q<HTMLElement>('#admin-access');
  // The browser has no Cloudflare Access cookie yet: the notice carries its own text, so the status line stays empty.
  q<HTMLButtonElement>('#admin-access-enter').addEventListener('click', () =>
    window.location.assign('/api/web/provider/admin/enter'),
  );
  const report = (error: unknown) => {
    const needsAccess = error instanceof InviteLocalApiError && error.code === 'ACCESS_REQUIRED';
    accessNotice.hidden = !needsAccess;
    statusLine.textContent = needsAccess ? '' : adminAccountError(error);
    if (!needsAccess) toastSink?.(statusLine.textContent, 'danger');
  };
  let session: AccountAdminSession | null = null,
    page: AdminPage | 'login' | 'token' | 'reset' = 'login',
    routeId: string | null = null,
    busy = true,
    disposed = false;
  let bindId: string | null = null,
    resetId: string | null = null,
    memberUnknown = false;
  const cleanups: Array<() => void> = [];
  // The administrator whose permission grid is open (a click on a name); the first one until another is picked.
  let chosenMember: string | null = null;
  let membersResult: Awaited<ReturnType<Port['members']>> | null = null;
  const can = (permission: InviteAdminPermission) =>
    session?.member.role === 'owner' || (!!session && hasInvitePermission(session.member.permissions, permission));
  const access = (): NavAccess => ({
    owner: session?.member.role === 'owner',
    permissions: session?.member.permissions ?? [],
    inbox: !!port.cocreation,
    models: !!port.modelSettings,
    system: !!port.overview && !!port.systemStatus,
    conversations: !!port.conversations && session?.features?.chatReview === true,
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
    permissionMatrixEditor(host, initial, {
      cocreation: !!port.cocreation,
      conversations: !!port.conversations && session?.features?.chatReview === true,
    });
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
    tiers.clearSecrets();
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
    for (const group of navTree()) {
      let any = false;
      for (const item of groupPages(group)) {
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
    // 邀请与额度 needs the owner role or invites.manage (the server checks again); anyone else sees why the page is empty.
    q<HTMLElement>('#admin-no-permissions').hidden = can('invites.manage');
    q<HTMLElement>('#admin-invites').hidden = !can('invites.manage');
    for (const control of root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>(
      'button,input,select,textarea',
    ))
      control.disabled = busy || control.dataset.locked === 'true';
    q<HTMLButtonElement>('#admin-bind-start button').disabled = busy || !session?.emailDeliveryAvailable;
    q<HTMLButtonElement>('#admin-member-issue button').disabled = busy || memberUnknown || !newPermissions;
    newPermissions?.setDisabled(busy || memberUnknown);
    q<HTMLElement>('main').setAttribute('data-surface', session ? page : 'login');
    // 系统 → 模型与价格 is the one page that is usable on a phone: its route lifts the desktop-only notice (and the login in front of it).
    // The Access notice is usable on a phone as well: it is the only thing shown until Access has been passed.
    if (window.location?.hash?.startsWith('#/models') === true || !accessNotice.hidden)
      q<HTMLElement>('main').setAttribute('data-mobile-ok', '');
    else q<HTMLElement>('main').removeAttribute('data-mobile-ok');
    if (accessNotice.hidden) q<HTMLElement>('main').removeAttribute('data-access');
    else q<HTMLElement>('main').setAttribute('data-access', '');
    workbench?.update(busy);
    previewBench?.update(busy);
    for (const nav of root.querySelectorAll<HTMLElement>('.admin-nav [data-page]')) {
      if (nav.dataset.page === page) nav.setAttribute('aria-current', 'page');
      else nav.removeAttribute('aria-current');
    }
    // 角色工作台 stays lit while its 预演测试 page (listed under it) is open.
    q<HTMLElement>('.admin-nav [data-page="characters"]').setAttribute('data-trail', String(page === 'preview'));
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
    if (page === 'invites' && can('invites.manage') && port.inviteBatches) return () => tiers.load();
    if (page === 'overview' && canSeePage('overview', access())) return () => overview.load();
    if (page === 'points' && canSeePage('points', access())) return () => points.load();
    if (page === 'system' && canSeePage('system', access())) return () => system.load();
    if (page === 'stats' && canSeePage('stats', access())) return () => stats.load();
    if (page === 'costs' && canSeePage('costs', access())) return () => costs.load();
    if (page === 'conversations' && canSeePage('conversations', access())) return () => reviews.load();
    if (page === 'models' && port.modelSettings) return () => models.load();
    return null;
  };
  /** The newest load a click asked for while something else was running; it starts when that run ends. */
  let queuedLoad: (() => Promise<void>) | null = null;
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
      report(error);
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
      const next = queuedLoad;
      queuedLoad = null;
      if (next && !disposed) void run(next);
    }
  };
  /**
   * A click that opens something is never dropped: it runs now, or, when another run is in flight, waits for it (only
   * the newest waiting load is kept, and never two run at once). The work itself must check it is still wanted.
   */
  const runLatest = (work: () => Promise<void>) => {
    if (disposed) return;
    if (busy) queuedLoad = work;
    else void run(work);
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
      if (disposed || !navigate('preview', characterId)) return;
      // Still the picked role when its turn comes (a later pick, or leaving the page, replaces this one).
      runLatest(async () => {
        if (page === 'preview' && routeId === characterId) await previewBench!.open(characterId);
      });
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
  const toasts = toastHost(q('main'));
  toastSink = (text, tone) => void toasts.show(text, tone);
  const unavailable = () => Promise.reject(new Error('ADMIN_SYSTEM_UNAVAILABLE'));
  const overview = overviewView(q('#admin-overview'), {
    load: () => (port.overview ? port.overview() : unavailable()),
    run,
    disposed: () => disposed,
    chart: port.chart
      ? { load: (metric, range) => port.chart!(metric, range), available: () => canSeePage('stats', access()) }
      : undefined,
  });
  const system = systemView(q('#admin-system'), {
    load: () => (port.systemStatus ? port.systemStatus() : unavailable()),
    renewPrices: (requestId) => (port.renewPrices ? port.renewPrices(requestId) : unavailable()),
    topUp: (input) => (port.budgetTopUp ? port.budgetTopUp(input) : unavailable()),
    isOwner: () => session?.member.role === 'owner',
    run,
    confirm: (options) => confirmDialog(q('main'), options),
    toast: (text) => toasts.show(text, 'ok'),
    newRequestId: () => globalThis.crypto.randomUUID(),
    disposed: () => disposed,
  });
  const stats = statsView(q('#admin-stats'), {
    load: (range) => (port.playerStats ? port.playerStats(range) : unavailable()),
    chatUsers: port.chart ? () => port.chart!('chat_users', '14d') : undefined,
    exportCsv: (range) => (port.exportPlayerStats ? port.exportPlayerStats(range) : unavailable()),
    download: browserDownload,
    run,
    disposed: () => disposed,
  });
  const costs = costsView(q('#admin-costs'), {
    load: (range) => (port.costs ? port.costs(range) : unavailable()),
    spend: port.spendByType ? (range) => port.spendByType!(range) : undefined,
    exportCsv: (range) => (port.exportCosts ? port.exportCosts(range) : unavailable()),
    download: browserDownload,
    run,
    disposed: () => disposed,
  });
  const points = pointsView(q('#admin-points'), {
    preview: (to, amount) => (port.pointsPreview ? port.pointsPreview(to, amount) : unavailable()),
    grant: (input) => (port.pointsGrant ? port.pointsGrant(input) : unavailable()),
    errorText: adminAccountError,
    resetPreview: () => (port.resetPreview ? port.resetPreview() : unavailable()),
    reset: (requestId) => (port.resetPoints ? port.resetPoints(requestId) : unavailable()),
    isOwner: () => session?.member.role === 'owner',
    run,
    confirm: (options) => confirmDialog(q('main'), options),
    toast: (text) => toasts.show(text, 'ok'),
    newRequestId: () => globalThis.crypto.randomUUID(),
    disposed: () => disposed,
  });
  const tiers = inviteTiersView(q('#admin-invites'), {
    port,
    isOwner: () => session?.member.role === 'owner',
    run,
    confirm: (options) => confirmDialog(q('main'), options),
    toast: (text) => toasts.show(text, 'ok'),
    newRequestId: () => globalThis.crypto.randomUUID(),
    disposed: () => disposed,
  });
  const models = modelsView(q('#admin-models'), {
    load: () => (port.modelSettings ? port.modelSettings() : Promise.reject(new Error('ADMIN_MODELS_UNAVAILABLE'))),
    save: (input) =>
      port.saveModelSettings ? port.saveModelSettings(input) : Promise.reject(new Error('ADMIN_MODELS_UNAVAILABLE')),
    run,
    confirm: (options) => confirmDialog(q('main'), options),
    toast: (text) => toasts.show(text, 'ok'),
    newRequestId: () => globalThis.crypto.randomUUID(),
    disposed: () => disposed,
  });
  const reviews = conversationsView(q('#admin-conversations'), {
    api: port.conversations ?? {
      list: () => Promise.reject(new Error('ADMIN_CONVERSATIONS_UNAVAILABLE')),
      detail: () => Promise.reject(new Error('ADMIN_CONVERSATIONS_UNAVAILABLE')),
      export: () => Promise.reject(new Error('ADMIN_CONVERSATIONS_UNAVAILABLE')),
    },
    run,
    runLatest,
    status: (text) => {
      if (!disposed) status.textContent = text;
    },
    disposed: () => disposed,
  });
  const clearMemberControls = () => {
    q('#admin-members-list').replaceChildren();
    membersResult = null;
    chosenMember = null;
    q('#admin-new-permissions').replaceChildren();
    newPermissions = null;
  };
  const clearManagement = () => {
    tiers.clear();
    clearMemberControls();
    workbench?.clear();
    previewBench?.clear();
    previewSplit.detail.replaceChildren();
    picker.clear();
    overview.clear();
    system.clear();
    stats.clear();
    costs.clear();
    points.clear();
    reviews.clear();
    models.clear();
    inbox?.clear();
    unread = {};
  };
  const adoptSession = (current: AccountAdminSession) => {
    if (session && (session.member.id !== current.member.id || session.csrf !== current.csrf)) {
      clearSecrets();
      clearManagement();
      bindId = null;
      resetId = null;
      memberUnknown = false;
      reissueUnknown.clear();
      page = 'account';
      status.textContent = '登录身份或会话已改变，已清除上一会话的本页资料与请求；没有自动提交。';
    }
    session = current;
  };
  const paintMembers = () => {
    const result = membersResult;
    if (!result) return;
    const list = q<HTMLElement>('#admin-members-list');
    list.replaceChildren();
    const chosen =
      result.members.find((m) => m.id === chosenMember)?.id ??
      (result.members.find((m) => m.role !== 'owner') ?? result.members[0])?.id ??
      null;
    for (const member of result.members) {
      const item = document.createElement('div');
      item.className = 'admin-member';
      const heading = document.createElement('button');
      heading.type = 'button';
      heading.className = 'admin-member-head';
      heading.setAttribute('aria-expanded', String(member.id === chosen));
      heading.textContent = `${member.label} · ${member.role === 'owner' ? '主管理员' : `已分配 ${member.permissions.length} 项授权`}${member.email ? ` · ${member.email}` : ''}`;
      heading.addEventListener('click', () => {
        if (chosenMember === member.id) return;
        chosenMember = member.id;
        paintMembers();
      });
      item.append(heading);
      if (member.id !== chosen) {
        list.append(item);
        continue;
      }
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
            let result: Awaited<ReturnType<typeof port.issueMember>>;
            try {
              result = await port.issueMember({
                requestId: crypto.randomUUID(),
                label: member.label,
                memberId: member.id,
                permissions: member.permissions,
              });
            } catch (error) {
              // An unconfirmed issue is shown at once (the button stays locked) instead of waiting for a reload.
              paintMembers();
              throw error;
            }
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
  const loadMembers = async () => {
    const result = await port.members();
    if (disposed) return;
    const selected = newPermissions?.value() ?? [];
    q('#admin-new-permissions').replaceChildren();
    newPermissions = permissionControls(q('#admin-new-permissions'), selected);
    membersResult = result;
    paintMembers();
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
    if (!session || disposed || !wanted) return;
    // An old link to a page that moved: the address is rewritten to its place today.
    if (sameRoute(wanted, here())) {
      address.replace(wanted);
      return;
    }
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
      showSecret('管理员一次性登录凭据 · 1 小时内使用', result.token);
      await loadMembers();
    } catch (error) {
      memberUnknown = true;
      throw error;
    }
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
  // 总览 and 系统状态 reload by themselves every 60 s while the tab is visible and nothing else is running.
  const tick = setInterval(() => {
    if (!session || busy || disposed || (page !== 'overview' && page !== 'system')) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    // Never under the administrator's hands: not while a field has focus (the repaint would take it away).
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName ?? '')) return;
    // A quiet reload: the controls are not disabled for it, and a failure is simply tried again a minute later.
    void loader()?.().catch(() => {});
  }, 60_000);
  (tick as { unref?: () => void }).unref?.();
  cleanups.push(() => clearInterval(tick));
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
      if (!disposed) {
        if (error instanceof InviteLocalApiError && error.status === 401) {
          accessNotice.hidden = true;
          status.textContent = '请使用管理员邮箱登录，或选择一次性凭据。';
        } else report(error);
      }
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

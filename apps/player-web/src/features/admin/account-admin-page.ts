import { disclosureChevron } from './ui/disclosure.ts';
import { watchFieldWidths } from './ui/field-width.ts';
import type { AccountAdminApi, AccountAdminSession } from '../../services/account-admin-api.ts';
import { REFUSED, UNKNOWN_OUTCOME } from './error-sentences.ts';
import { characterWorkbench, characterAdminError } from './character-workbench.ts';
import { previewWorkbench } from './preview/preview-workbench.ts';
import type { PreviewAdminClient } from '../../services/preview-admin-api.ts';
import { permissionMatrixEditor } from './permission-matrix.ts';
import { membersView } from './members-view.ts';
import { overviewView } from './overview-view.ts';
import { pointsView } from './points-view.ts';
import { broadcastView } from './broadcast-view.ts';
import { memesView } from './memes-view.ts';
import { systemView } from './system-view.ts';
import { costsView } from './costs-view.ts';
import { modelsView } from './models-view.ts';
import { dateTimeText } from './system-format.ts';
import { confirmDialog } from './ui/confirm-dialog.ts';
import { inlineConfirm } from './ui/inline-confirm.ts';
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
import { toastHost } from './ui/toast.ts';
import { characterColour, setRoster } from './ui/character-colour.ts';
import { castView } from './cast/cast-view.ts';
import type { CastAdminClient } from '../../services/cast-admin-api.ts';
import type { ProfileImportClient } from '../../services/profile-import-api.ts';
import { profileImportView } from './profile-import/profile-import-view.ts';
import { cocreationInbox } from './cocreation-inbox.ts';
import { exportButton, type MakeExport } from './export/export-dialog.ts';
import { adoptBox } from './speech-profile/adopt-box.ts';
import { othersReader } from './speech-profile/profile-draft.ts';
import { conversationsView } from './conversations-view.ts';
import { feedbackView } from './feedback-view.ts';
import { arcOrderView } from './owner/arc-order-view.ts';
import type { OwnerAdminClient } from '../../services/owner-admin-api.ts';
import type { ConversationsAdminClient } from '../../services/conversations-admin-api.ts';
import type {
  CocreationAdminClient,
  CocreationRelationsClient,
  CocreationWordingsClient,
} from '../../services/cocreation-admin-api.ts';
import { browserDownload, inviteTiersView } from './invite-tiers-view.ts';
import {
  ADMIN_PERMISSION_ITEMS,
  ADMIN_PERMISSION_LIMIT,
  canCreateCharacter,
  hasCastPermission,
  hasCharacterPermission,
  hasInvitePermission,
  hasCocreationPermission,
  type AdminPermission,
  type CocreationAdminPermission,
  type InviteAdminPermission,
} from '../../../../../packages/contracts/web-admin-permissions.ts';
import { InviteLocalApiError } from '../../services/invite-local-api.ts';
import {
  adminConnection,
  ACCESS_EXPIRED_LINE,
  INTERRUPTED_LINE,
  INTERRUPTED_LINE_READ,
  isInterrupted,
  reauthUrl,
} from '../../services/admin-connection.ts';
import { isCancelled } from '../../services/invite-admin-api.ts';
import { clearAllKeptEdits } from './ui/edit-keeper.ts';
import { keepScroll } from './ui/keep-scroll.ts';

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
  /** Part 60: the page-open that is loading now (its reads are cancelled by a newer one). Optional: a port without it never cancels. */
  setLoadSignal?: (signal: AbortSignal | null) => void;
  /** 预演 beside the editor of 角色工作台 (runs, eval sets, batched status). Without it the page keeps the single-preview panel. */
  previews?: PreviewAdminClient;
  /** 关系与故事. Optional: a page without it has no such page in the nav. */
  cast?: CastAdminClient;
  /** Part 24j: 导入角色资料 in 角色工作台. Optional: a page without it has no such button. */
  profileImport?: ProfileImportClient;
  /** 概览, 系统状态 and 积分发放 (Part 22b). Optional: a page without `overview` has none of them in the nav. */
  overview?: AccountAdminApi['overview'];
  systemStatus?: AccountAdminApi['systemStatus'];
  renewPrices?: AccountAdminApi['renewPrices'];
  budgetTopUp?: AccountAdminApi['budgetTopUp'];
  /** Part 54: 未确认的调用 on 系统状态. */
  unknownCalls?: AccountAdminApi['unknownCalls'];
  resolveUnknownCall?: AccountAdminApi['resolveUnknownCall'];
  pointsPreview?: AccountAdminApi['pointsPreview'];
  pointsGrant?: AccountAdminApi['pointsGrant'];
  resetPreview?: AccountAdminApi['resetPreview'];
  cocreationPoints?: AccountAdminApi['cocreationPoints'];
  saveCocreationPoints?: AccountAdminApi['saveCocreationPoints'];
  resetPoints?: AccountAdminApi['resetPoints'];
  /** 广播 (Part 42): the owner or broadcast.send. Optional: a page without it has no 广播 in the nav. */
  broadcast?: AccountAdminApi['broadcast'];
  /** 玩家统计 and 消耗表 (Part 22c): the owner or stats.read. Optional: a page without them has neither in the nav. */
  playerStats?: AccountAdminApi['playerStats'];
  costs?: AccountAdminApi['costs'];
  /** Part 57: 导出, the one button of each page. Optional: without it no page has the button. */
  exports?: AccountAdminApi['exports'];
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
  reviewModel?: AccountAdminApi['reviewModel'];
  saveReviewModel?: AccountAdminApi['saveReviewModel'];
  /** Part 37a: 回复写法 (owner only; the card is drawn only for the owner). */
  writerSetting?: AccountAdminApi['writerSetting'];
  saveWriterSetting?: AccountAdminApi['saveWriterSetting'];
  saveModelSettings?: AccountAdminApi['saveModelSettings'];
  /** 共创收件箱. Optional: a page without it simply has no inbox tab. */
  cocreation?: Pick<CocreationAdminClient, 'counts' | 'list' | 'detail' | 'setStatus' | 'star' | 'note' | 'adopt'> &
    Partial<Pick<CocreationAdminClient, 'unadopt' | 'addToCastStory' | 'adoptAnswers'>>;
  /** Part 39: relation notes and 玩家眼中的关系 (optional; without it the inbox has neither). */
  cocreationRelations?: Pick<CocreationRelationsClient, 'detail' | 'stats' | 'adopt' | 'reject' | 'exclude' | 'tidy'> &
    Partial<Pick<CocreationRelationsClient, 'adoptReason'>>;
  /** Part 39b: 题目, the wording pool of the co-creation themes. */
  cocreationWordings?: Pick<
    CocreationWordingsClient,
    'list' | 'add' | 'edit' | 'toggle' | 'remove' | 'estimate' | 'generate'
  > &
    Partial<Pick<CocreationWordingsClient, 'setEnabled'>>;
  /** 测试对话 (CHAT_REVIEW_ENABLED; the page only appears when the session says the switch is on). */
  conversations?: Pick<ConversationsAdminClient, 'list' | 'detail' | 'export'>;
  /** Part 36: 语音反馈 (the owner only). Optional: a page without it has no 语音反馈 in the nav. */
  feedback?: AccountAdminApi['feedback'];
  /** Part 31: the owner's operations. Optional: a page without it draws none of them. */
  owner?: Pick<
    OwnerAdminClient,
    | 'arcRead'
    | 'arcSave'
    | 'deletePreviews'
    | 'deleteRehearsals'
    | 'deleteConversations'
    | 'closedRead'
    | 'closedPolicy'
    | 'closedDelete'
  >;
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
        MODEL_SETTINGS_UNAVAILABLE: '这个站点的数据库还没有升级到模型与价格，请联系开发。',
        PLAYER_NOT_FOUND: '没有找到这位玩家。请核对完整的邮箱或 8 位玩家编号。',
        POINTS_NOT_ENABLED: '积分功能还没有打开，现在不能发放或重置。',
        BUDGET_UNLIMITED: '这个供应商的预算不限额，不需要充值。',
        BUDGET_UNAVAILABLE:
          '预算服务暂时没有回应，充值结果未确认。请重新打开本页核对剩余额度后再试（同一次点击不会重复充值）。',
        SYSTEM_UNAVAILABLE: '这个环境没有提供这项系统功能。',
        STATS_UNAVAILABLE: '这个站点的数据库还没有升级到统计功能，请联系开发。',
        IDEMPOTENCY_CONFLICT: '这次提交与之前的同一请求内容不一致，请重新打开本页后重试。',
        INVALID_REQUEST: '填写的内容不符合要求（每条点数 1–200，语音加点 0–20，均为整数）。',
        CAST_REVISION_CONFLICT: '草稿已被另一位管理员修改，本次没有保存。你写的内容还在页面上。',
        CAST_INVALID: '有些内容不符合要求，请看页面上的提示。',
        CAST_PUBLISH_BLOCKED: '还有问题挡着发布，请先解决页面上列出的问题。',
        CAST_DRAFT_NOT_EMPTY: '草稿不是空的，不能再从旧资料导入。',
        CAST_UNAVAILABLE: '这个站点的数据库还没有升级到关系与故事，请联系开发。',
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
    )[code] ??
    // Only a request whose outcome is truly unknown (no answer, a 5xx) gets the "unconfirmed" text; a named 4xx refusal changed nothing.
    (error instanceof InviteLocalApiError && error.status >= 400 && error.status < 500 && error.status !== 408
      ? REFUSED
      : UNKNOWN_OUTCOME)
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
      <div class="admin-brand"><h1 tabindex="-1">Burbur 管理</h1></div>
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
    <section class="admin-conn" id="admin-conn" role="alert" hidden><p id="admin-conn-line"></p>
      <button type="button" id="admin-conn-open" class="admin-primary">验证 / 重新登录</button>
      <button type="button" id="admin-conn-retry" class="admin-primary" hidden>重试</button>
      <a id="admin-conn-link" href="/?mode=provider-admin" target="_blank" rel="noopener" hidden>重新验证</a></section>
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
    <section data-panel="account" hidden><div class="page-head"><h2>我的账号</h2><div class="page-head-actions"></div></div><p id="admin-account-info"></p>
      <form id="admin-bind-start"><label for="admin-bind-email">用于以后登录的邮箱</label><input id="admin-bind-email" type="email" autocomplete="username" maxlength="254" required>
        <button type="submit">验证邮箱</button></form>
      <form id="admin-bind-finish" hidden><label for="admin-bind-code">邮件验证码（6 位数字）</label><input id="admin-bind-code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" minlength="6" maxlength="6" required>
        <label for="admin-bind-password">设置密码（8–18 个字符）</label><div class="admin-password-field"><input id="admin-bind-password" type="password" autocomplete="new-password" pattern=".{8,18}" maxlength="36" required><button id="admin-bind-password-toggle" type="button" class="admin-secondary" aria-controls="admin-bind-password" aria-pressed="false">显示密码</button></div>
        <button type="submit">完成邮箱绑定</button></form>
      <button id="admin-account-continue" class="admin-back" type="button" data-page="home">进入管理</button></section>
    <section data-panel="invites" hidden><p id="admin-no-permissions" hidden>当前账号没有“邀请与额度”权限，请联系主管理员开通。</p><div id="admin-invites"></div></section>
    <section data-panel="characters" hidden><div class="page-head"><h2 id="wb-title">角色工作台</h2><div class="page-head-actions" id="wb-head"></div></div><div id="admin-characters"></div></section>
    <section data-panel="cast" hidden><div id="admin-cast"></div></section>
    <section data-panel="memes" hidden><div id="admin-memes"></div></section>
    <section data-panel="cocreation" hidden><div id="admin-cocreation"></div></section>
    <section data-panel="members" hidden><div class="page-head"><h2>管理员与权限</h2><div class="page-head-actions" id="admin-members-head"></div></div>
      <form id="admin-member-issue" class="mb-add"><label class="mb-field mb-name-field" for="admin-member-label"><span>新管理员备注</span><input id="admin-member-label" maxlength="80" placeholder="例：共创写手 · 小雨" required></label>
        <div class="mb-field mb-preset-field" role="group" aria-labelledby="admin-new-permissions-label"><span id="admin-new-permissions-label">权限预设</span><span id="admin-new-permissions" class="mb-presets"></span></div>
        <div id="admin-new-grid" class="mb-grid mb-new-grid"></div>
        <div class="mb-issue"><button class="admin-primary" type="submit">签发凭据 · 0 项</button><span id="admin-issue-reason" class="mb-reason" aria-live="polite"></span></div></form>
      <div id="admin-members-table" class="members-table-card"></div><div id="admin-members-list" class="members-list"></div>
    </section>
    <section data-panel="overview" hidden><div id="admin-overview"></div></section>
    <section data-panel="points" hidden><div id="admin-points"></div></section>
    <section data-panel="broadcast" hidden><div id="admin-broadcast"></div></section>
    <section data-panel="system" hidden><div id="admin-system"></div></section>
    <section data-panel="costs" hidden><div id="admin-costs"></div></section>
    <section data-panel="conversations" hidden><div id="admin-conversations"></div></section>
    <section data-panel="feedback" hidden><div id="admin-feedback"></div></section>
    <section data-panel="models" hidden><div id="admin-models"></div></section>
    </div>
    </div>
    <p class="invite-admin-status admin-statusbar sr-only" role="status" aria-live="polite"></p>
  </main>`;
  const q = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  // Part 24b-7c: every single-line field gets its width class (docs/ADMIN_LAYOUT.md); layout only.
  const stopFieldWidths = watchFieldWidths(root);
  // Part 59: no click moves the page: every scroller of the console keeps its position through a repaint (ui/keep-scroll.ts).
  const scroll = keepScroll(root);
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
    // Part 59: an interruption of a console that is signed in is not a failure: the connection line says it (edits are kept).
    if (isInterrupted(error) && session) {
      accessNotice.hidden = true;
      statusLine.textContent =
        adminConnection.reason === 'access'
          ? ACCESS_EXPIRED_LINE
          : adminConnection.writePending
            ? INTERRUPTED_LINE
            : INTERRUPTED_LINE_READ;
      return;
    }
    // Part 60: a request that timed out (or lost its connection) before any sign-in is not an Access problem: the form is simply
    // still there, and the owner is told to try again.
    const timedOut = isInterrupted(error) && error.reason === 'network';
    const needsAccess = !timedOut && error instanceof InviteLocalApiError && error.code === 'ACCESS_REQUIRED';
    accessNotice.hidden = !needsAccess;
    statusLine.textContent = timedOut ? '连接超时，请再试一次。' : needsAccess ? '' : adminAccountError(error);
    if (!needsAccess) toastSink?.(statusLine.textContent, 'danger');
  };
  let session: AccountAdminSession | null = null,
    page: AdminPage | 'login' | 'token' | 'reset' = 'login',
    routeId: string | null = null,
    disposed = false;
  /**
   * Part 60: there is NO page-wide busy. A save locks only its own form (the scope below); a load locks nothing. What was wrong: one
   * `busy` disabled every control of the page (the 「not-allowed」 cursor) and started TRUE until the first session read answered, so
   * a request that never came back (a stuck answer, a Cloudflare challenge, a dead connection after the tab slept) froze the whole
   * console, the login form included, until the tab was closed.
   */
  const cleanups: Array<() => void> = [];
  const inFlight = new Set<HTMLElement>();
  const running = new Set<unknown>();
  const lockedBy = (control: HTMLElement) => {
    for (const scope of inFlight) if (scope === control || scope.contains?.(control)) return true;
    return false;
  };
  /** A save lock touches this element (it is inside a locked form, or contains one). */
  const lockedWithin = (host: HTMLElement | null | undefined) => {
    if (!host) return false;
    for (const scope of inFlight) if (scope === host || scope.contains?.(host) || host.contains?.(scope)) return true;
    return false;
  };
  // What the owner touched last: the save that starts a moment later belongs to that form (or, without a form, to that control).
  let touchedAt = 0;
  let touchedEl: HTMLElement | null = null;
  const SCOPE = 'form, [data-save-scope], #wb-editor, #wb-preview, #wb-import-host, #wb-arc-host, [role="dialog"], dialog';
  const markTouch = (event: Event) => {
    const target = event.target as HTMLElement | null;
    if (!target || typeof target.closest !== 'function') return;
    touchedEl = target;
    touchedAt = Date.now();
  };
  for (const type of ['click', 'submit', 'keydown', 'change']) {
    root.addEventListener(type, markTouch, true);
    cleanups.push(() => root.removeEventListener(type, markTouch, true));
  }
  const scopeOfTouch = (): HTMLElement | null => {
    const el = touchedEl;
    if (!el || Date.now() - touchedAt > 10_000) return null;
    const form = el.closest(SCOPE) as HTMLElement | null;
    if (form) return form;
    return el.matches?.('button,input,select,textarea') ? el : null;
  };
  let bindId: string | null = null,
    resetId: string | null = null;
  const can = (permission: InviteAdminPermission) =>
    session?.member.role === 'owner' || (!!session && hasInvitePermission(session.member.permissions, permission));
  const access = (): NavAccess => ({
    owner: session?.member.role === 'owner',
    permissions: session?.member.permissions ?? [],
    inbox: !!port.cocreation,
    cast: !!port.cast,
    models: !!port.modelSettings,
    system: !!port.overview && !!port.systemStatus,
    broadcast: !!port.broadcast,
    feedback: !!port.feedback,
    conversations: !!port.conversations && session?.features?.chatReview === true,
  });
  const canCreateRole = () =>
    session?.member.role === 'owner' || (!!session && canCreateCharacter(session.member.permissions));
  /** The same gate the server applies before it reads the body: cast.edit, and the right to create or to edit characters. */
  const canImportProfiles = () => {
    const member = session?.member;
    if (!member || !port.profileImport) return false;
    if (member.role === 'owner') return true;
    const grants = member.permissions;
    return (
      hasCastPermission(grants, 'cast.edit') &&
      (canCreateCharacter(grants) ||
        grants.includes('category.characters') ||
        grants.some((p) => p.startsWith('characters.edit:')))
    );
  };
  const canEditCharacter = (characterId: string) =>
    session?.member.role === 'owner' ||
    (!!session && hasCharacterPermission(session.member.permissions, 'edit', characterId));
  const address = addressBar(window);
  const roleNames = new Map<string, string>();
  let workbench: ReturnType<typeof characterWorkbench> | null = null;
  let previewBench: {
    open(id: string): Promise<void>;
    update(locked: boolean): void;
    refresh(): void;
    clear(): void;
    dispose(): void;
  } | null = null;
  let inbox: ReturnType<typeof cocreationInbox> | null = null;
  // New (unread) co-creation submissions per character: the badge in the character workbench.
  let unread: Record<string, number> = {};
  /** Grouped permissions with 共生项 and presets; the inbox group only when this page has an inbox. */
  const permissionControls = (
    host: HTMLElement,
    initial: readonly AdminPermission[],
    onChange?: (dirty: number) => void,
    adding?: boolean,
  ) =>
    permissionMatrixEditor(host, initial, {
      cocreation: !!port.cocreation,
      conversations: !!port.conversations && session?.features?.chatReview === true,
      ...(onChange ? { onChange } : {}),
      ...(adding ? { adding } : {}),
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
  // Opening a page loads its list and then the role in the address; the workbench's own "view changed" reports are muted meanwhile.
  let quiet = 0;
  const canPreview = (characterId: string) =>
    session?.member.role === 'owner' ||
    (!!session &&
      hasCharacterPermission(session.member.permissions, 'read', characterId) &&
      hasCharacterPermission(session.member.permissions, 'preview', characterId));
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
    const toggle = q<HTMLElement>('#admin-account-toggle');
    // the name, then the shared chevron (drawn first by the CSS: it is the first thing the eye meets, like every disclosure)
    toggle.textContent = who ?? '';
    if (who) {
      toggle.className = /\bdc\b/.test(toggle.className) ? toggle.className : `${toggle.className} dc`;
      toggle.append(disclosureChevron());
    }
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
      control.disabled = lockedBy(control) || control.dataset.locked === 'true';
    q<HTMLButtonElement>('#admin-bind-start button').disabled =
      lockedBy(q<HTMLButtonElement>('#admin-bind-start button')) || !session?.emailDeliveryAvailable;
    members.paintIssue();
    q<HTMLElement>('main').setAttribute('data-surface', session ? page : 'login');
    // 系统 → 模型与价格 is the one page that is usable on a phone: its route lifts the desktop-only notice (and the login in front of it).
    // The Access notice is usable on a phone as well: it is the only thing shown until Access has been passed.
    if (window.location?.hash?.startsWith('#/models') === true || !accessNotice.hidden)
      q<HTMLElement>('main').setAttribute('data-mobile-ok', '');
    else q<HTMLElement>('main').removeAttribute('data-mobile-ok');
    if (accessNotice.hidden) q<HTMLElement>('main').removeAttribute('data-access');
    else q<HTMLElement>('main').setAttribute('data-access', '');
    workbench?.update(lockedWithin(editorHost));
    previewBench?.update(lockedWithin(previewHost));
    newRole.hidden = !session || !canCreateRole();
    importRoles.hidden = !canImportProfiles();
    arcButton.hidden =
      !port.owner ||
      !session ||
      !(session.member.role === 'owner' || session.member.permissions.includes('category.characters'));
    for (const nav of root.querySelectorAll<HTMLElement>('.admin-nav [data-page]')) {
      if (nav.dataset.page === page) nav.setAttribute('aria-current', 'page');
      else nav.removeAttribute('aria-current');
    }
  };
  const WITH_ID: readonly string[] = ['characters', 'cocreation'];
  const closeMenu = () => {
    q<HTMLElement>('#admin-account-menu').hidden = true;
    q<HTMLElement>('#admin-account-toggle').setAttribute('aria-expanded', 'false');
  };
  const toggleMenu = () => {
    const menu = q<HTMLElement>('#admin-account-menu');
    menu.hidden = !menu.hidden;
    q<HTMLElement>('#admin-account-toggle').setAttribute('aria-expanded', String(!menu.hidden));
  };
  /** Leaving the workbench with unsaved changes asks first (保存 / 不保存 / 取消); anything else leaves at once. */
  const clean = () => page !== 'characters' || !workbench || workbench.canLeave();
  /** Runs `go` at once on a clean page (no await: the click keeps its synchronous effect), else after the answer says to leave. */
  const whenLeaveOk = (go: () => void) => {
    if (clean()) return go();
    void workbench!.confirmLeave().then((ok) => {
      if (ok && !disposed) go();
    });
  };
  /** Which page the administrator is on, as the address bar shows it. */
  const here = (): AdminRoute | null => (session && isAdminPage(page) ? { page, id: routeId } : null);
  const navigate = (next: string, id: string | null = null, options: { replaceUrl?: boolean } = {}) => {
    const wanted = next === 'home' && session ? firstAllowedPage(access()) : next;
    const target =
      session && isAdminPage(wanted) && !canSeePage(wanted, access()) ? firstAllowedPage(access()) : wanted;
    const targetId =
      WITH_ID.includes(target) && target === wanted
        ? id
        : target === 'system' && wanted === 'system' && id === 'cleanup'
          ? id
          : null;
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
    if (target === 'characters') picker.select(routeId);
    render();
    // Another page is opened on purpose: it starts at the top. (preventScroll: focusing must not scroll by itself.)
    scroll.reset();
    q<HTMLElement>('.admin-content').focus({ preventScroll: true });
    const route = here();
    if (route) {
      if (options.replaceUrl) address.replace(route);
      else address.push(route);
    }
    return true;
  };
  /** One roster read (names and 主色, never profiles) before any page but the workbench paints, so every dot is the character's own colour. */
  let rosterRead: Promise<void> | null = null;
  const readRoster = () =>
    (rosterRead ??= (async () => {
      const api = port.characters;
      if (!api || typeof api.list !== 'function') return;
      try {
        setRoster((await api.list()).characters);
      } catch {
        /* a convenience: without it the ids are dealt the palette */
      }
    })());
  /** What opening the current page has to load, or null when it only shows what is already there. */
  const loader = (): (() => Promise<void>) | null => {
    const load = pageLoader();
    return page !== 'characters' && load
      ? async () => {
          await readRoster();
          await load();
        }
      : load;
  };
  const pageLoader = (): (() => Promise<void>) | null => {
    if (!session) return null;
    if (page === 'characters')
      return async () => {
        await refreshCounts();
        quiet++;
        try {
          await workbench!.load();
          picker.select(routeId);
          if (routeId) await openRole(routeId);
          else showPreview(null);
        } finally {
          quiet--;
        }
      };
    if (page === 'cast' && port.cast && canSeePage('cast', access())) return () => castPage.load();
    if (page === 'memes' && port.cast && canSeePage('memes', access())) return () => memes.load();
    if (page === 'cocreation' && inbox && canCocreation('cocreation.read'))
      return () => {
        // #/cocreation/<id> is the inbox filtered to that character (the badge on its card); plain #/cocreation keeps the filter.
        if (routeId) inbox!.showCharacter(routeId);
        return inbox!.load();
      };
    if (page === 'members') return members.load;
    if (page === 'invites' && can('invites.manage') && port.inviteBatches) return () => tiers.load();
    if (page === 'overview' && canSeePage('overview', access())) return () => overview.load();
    if (page === 'points' && canSeePage('points', access())) return () => points.load();
    if (page === 'broadcast' && canSeePage('broadcast', access())) return () => broadcast.load();
    if (page === 'system' && canSeePage('system', access()))
      return async () => {
        await system.load();
        // #/system/cleanup (the 总览 warning) lands on the cleanup section with its failure table in view.
        if (routeId === 'cleanup') system.reveal('cleanup');
      };
    if (page === 'costs' && canSeePage('costs', access())) return () => costs.load();
    if (page === 'conversations' && canSeePage('conversations', access())) return () => reviews.load();
    if (page === 'feedback' && canSeePage('feedback', access())) return () => feedbackPage.load();
    if (page === 'models' && port.modelSettings) return () => models.load();
    return null;
  };
  /** What went wrong in a load or a save: the page's one place for it (sign-in lost, a missing permission, an interruption). */
  const handleError = async (error: unknown) => {
    if (disposed || isCancelled(error)) return;
    if (
      !isInterrupted(error) &&
      error instanceof InviteLocalApiError &&
      error.status === 401 &&
      error.code !== 'ADMIN_LOGIN_INVALID'
    ) {
      session = null;
      page = 'login';
      cancelLoad();
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
  };
  /**
   * A SAVE (or any action a click starts). It locks only the form it came from (never two saves of one form at once); navigation,
   * sign-out and every other field stay usable. A load is not a `run`: see `startLoad`.
   */
  const run = async (work: () => Promise<void>) => {
    if (disposed) return;
    const scope = scopeOfTouch();
    // One save per form: the form itself, or (when no event told which one) the same piece of code, is the key.
    const key: unknown = scope ?? work.toString();
    if (running.has(key)) return;
    running.add(key);
    if (scope) {
      inFlight.add(scope);
      render();
    }
    try {
      await work();
    } catch (error) {
      await handleError(error);
    } finally {
      running.delete(key);
      if (scope) inFlight.delete(scope);
      if (!disposed) render();
    }
  };
  /**
   * Opening a page (or a role, a tab) is a LOAD. It never locks the page; the newest click wins: starting one cancels the load that
   * is still in flight (its reads are aborted), and a cancelled load shows nothing. A load that times out (20 s) or loses the
   * connection raises the connection line with the page's name and 重试.
   */
  let loadControl: AbortController | null = null;
  let failedLoad: { page: string; again: () => void } | null = null;
  const pageName = (id: string) => {
    for (const group of navTree()) for (const item of groupPages(group)) if (item.page === id) return item.label;
    return id === 'account' ? '我的账号' : '这个页面';
  };
  const startLoad = (work: () => Promise<void>) => {
    if (disposed) return;
    loadControl?.abort();
    const control = new AbortController();
    loadControl = control;
    failedLoad = null;
    // The older line (naming the page that could not load) is repainted at once: it no longer names the page being opened.
    if (adminConnection.state === 'interrupted') paintConnection('interrupted', adminConnection.reason);
    port.setLoadSignal?.(control.signal);
    const opened = page;
    void (async () => {
      try {
        await work();
      } catch (error) {
        if (control.signal.aborted || disposed) return;
        if (isInterrupted(error) && session && isAdminPage(opened)) {
          failedLoad = { page: opened, again: () => startLoad(work) };
          report(error);
          paintConnection('interrupted', adminConnection.reason);
          return;
        }
        await handleError(error);
      } finally {
        if (loadControl === control) {
          loadControl = null;
          port.setLoadSignal?.(null);
          if (!disposed) render();
        }
      }
    })();
  };
  /** A click that opens something: it runs now and the newest wins (the older load is cancelled). */
  const runLatest = (work: () => Promise<void>) => startLoad(work);
  const cancelLoad = () => {
    loadControl?.abort();
    loadControl = null;
    failedLoad = null;
    port.setLoadSignal?.(null);
  };
  /** Opens the current page: its load starts (the newest click wins); a page with nothing to load cancels the older load. */
  const openLoad = () => {
    const load = loader();
    if (load) startLoad(load);
    else cancelLoad();
  };
  const listen = (element: HTMLElement, event: string, callback: (event: Event) => void) => {
    element.addEventListener(event, callback);
    cleanups.push(() => element.removeEventListener(event, callback));
  };
  for (const id of passwordIds)
    listen(q(`#${id}-toggle`), 'click', () => {
      if (disposed) return;
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
    // Part 59: this is the verification / sign-in popup the connection line opened: it did its job, the page that asked carries on.
    if (window.location?.hash === '#/reauth' && window.opener) {
      window.close();
      if (window.closed) return;
    }
    // Reload keeps the place (the address bar); otherwise the first page this administrator may use.
    const wanted = address.read();
    const landing: AdminRoute =
      wanted && canSeePage(wanted.page, access())
        ? wanted
        : { page: result.member.email ? firstAllowedPage(access()) : 'account', id: null };
    page = landing.page;
    routeId = landing.id;
    address.replace(landing);
    // Part 60: the load of the first page runs on its own (the newest click wins); the sign-in itself is already done.
    openLoad();
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
  // 角色工作台: a row of role pills, then the editor (one section at a time) and the paid 预演 beside it (under it on a narrow window);
  // the shell opens a role in both.
  const stage = q('#admin-characters');
  // Part 24b-7: 导入角色资料 opens in this row, between the title row and the rail / editor (no drawer).
  const importHost = document.createElement('div');
  importHost.id = 'wb-import-host';
  // (the component tests' small DOM has no before(): the host then simply follows the stage)
  if (typeof stage.before === 'function') stage.before(importHost);
  else stage.parentNode?.appendChild(importHost);
  const newRole = document.createElement('button');
  newRole.type = 'button';
  newRole.id = 'wb-new';
  newRole.textContent = '+ 新建角色';
  newRole.hidden = true;
  const importRoles = document.createElement('button');
  importRoles.type = 'button';
  importRoles.id = 'wb-import';
  importRoles.textContent = '导入角色资料';
  importRoles.hidden = true;
  // Part 31 (A): 首页顺序, an inline panel like 导入角色资料; the owner or anyone with the 角色 category may set it.
  const arcHost = document.createElement('div');
  arcHost.id = 'wb-arc-host';
  if (typeof stage.before === 'function') stage.before(arcHost);
  else stage.parentNode?.appendChild(arcHost);
  const arcButton = document.createElement('button');
  arcButton.type = 'button';
  arcButton.id = 'wb-arc';
  arcButton.textContent = '首页顺序';
  arcButton.hidden = true;
  const rolesHost = document.createElement('div');
  rolesHost.id = 'wb-roles';
  rolesHost.className = 'wb-roles';
  const roster = document.createElement('div');
  roster.className = 'wb-roster';
  roster.setAttribute('role', 'group');
  roster.setAttribute('aria-label', '角色');
  roster.append(rolesHost, newRole, importRoles, arcButton);
  const editorHost = document.createElement('div');
  editorHost.id = 'wb-editor';
  editorHost.className = 'wb-editor';
  const previewHost = document.createElement('aside');
  previewHost.id = 'wb-preview';
  previewHost.className = 'wb-preview';
  previewHost.setAttribute('aria-label', '预演');
  previewHost.hidden = true;
  // 预演 is the editor's last section: the workbench mounts this element there.
  const split = document.createElement('div');
  split.className = 'wb';
  split.append(editorHost);
  stage.append(roster, split);
  const rosterColourOf = new Map<string, string>();
  let lastRoles: Parameters<typeof picker.show>[0] = [];
  const picker = rolePicker(rolesHost, {
    emptyText: '当前没有可查看的角色。',
    compact: {
      colour: (id) => {
        const colour = characterColour(id);
        rosterColourOf.set(id, colour);
        return colour;
      },
    },
    badges: () => unread,
    // Part 24l: this admin's own order of one sidebar group; a refusal puts the rail back and says so.
    onReorder: async (group, ids) => {
      try {
        await port.characters!.saveOrder(group, ids);
      } catch (error) {
        toasts.show(characterAdminError(error) ?? '排序没有保存。', 'warn');
        throw error;
      }
    },
    openInbox: (characterId) => {
      if (disposed) return;
      whenLeaveOk(() => {
        if (!navigate('cocreation', characterId)) return;
        openLoad();
      });
    },
    onPick: (characterId) => {
      if (disposed) return;
      const go = () => {
        if (!navigate('characters', characterId)) return;
        // Still the picked role when its turn comes (a later pick, or leaving the page, replaces this one).
        runLatest(async () => {
          if (page === 'characters' && routeId === characterId) await openRole(characterId);
        });
      };
      if (page === 'characters' && routeId === characterId) go();
      else whenLeaveOk(go);
    },
  });
  const openRole = async (characterId: string) => {
    quiet++;
    try {
      await workbench!.open(characterId);
    } finally {
      quiet--;
    }
    if (disposed || routeId !== characterId) return;
    picker.select(characterId);
    await showPreview(characterId);
  };
  /** The 预演 column shows for a role this administrator may preview; for anyone else it is not there. */
  const showPreview = async (characterId: string | null) => {
    const column = previewHost;
    column.hidden = !characterId || !previewBench || !canPreview(characterId);
    if (column.hidden) {
      previewBench?.clear();
      return;
    }
    await previewBench!.open(characterId!);
  };
  workbench = characterWorkbench(editorHost, {
    ...workbenchHost,
    badges: () => unread,
    directory: 'none',
    headerHost: q('#wb-head'),
    colourOf: (characterId) => rosterColourOf.get(characterId),
    previewMount: previewHost,
    // Part 37c-1: the 梗 档位 of 说话档案 adds a single-entry setting only for a term the dictionary holds (exact).
    ...(port.cast
      ? {
          memeLookup: async (term: string) =>
            (await port.cast!.memesList({ query: term, year: null, tag: null, state: 'all', page: 1 })).entries.some(
              (entry) => entry.term === term,
            ),
        }
      : {}),
    modalParent: () => q('main'),
    canPreview: (characterId) => !!previewBench && canPreview(characterId),
    onSeed: (characterId, seed) => picker.setSeed(characterId, seed),
    onDirty: () => previewBench?.refresh(),
    onDirectory: (roles) => {
      for (const role of roles) roleNames.set(role.characterId, role.displayName);
      picker.show(roles);
    },
    onView: (id) => {
      if (quiet || page !== 'characters') return;
      routeId = id;
      address.push({ page: 'characters', id });
    },
  });
  const profileImporter = port.profileImport
    ? profileImportView(importHost, {
        api: port.profileImport,
        run,
        toast: (text, tone) => toasts.show(text, tone ?? 'info'),
        disposed: () => disposed,
        // The roster and the open role are read again: new roles, new draft revisions, the code and the checklist.
        onImported: async () => {
          const load = loader();
          if (load) await load();
        },
      })
    : null;
  const arcOrder = port.owner
    ? arcOrderView(arcHost, {
        api: port.owner,
        run,
        toast: (text, tone) => toasts.show(text, tone ?? 'info'),
        disposed: () => disposed,
      })
    : null;
  listen(arcButton, 'click', () => {
    if (disposed || !arcOrder) return;
    if (arcOrder.isOpen()) arcOrder.close();
    else arcOrder.open();
  });
  listen(importRoles, 'click', () => {
    if (disposed) return;
    whenLeaveOk(() => profileImporter?.open());
  });
  listen(newRole, 'click', () => {
    if (disposed) return;
    whenLeaveOk(() => {
      previewBench?.clear();
      previewHost.hidden = true;
      picker.select(null);
      routeId = null;
      workbench!.openNew();
    });
  });
  // Part 37b: the one 说话档案 adopt box (⭐ in 多轮预演 and 测试对话, 加入说话档案 in 共创收件箱).
  const profileOthers = othersReader(port.characters);
  const profileBox = adoptBox({
    characters: port.characters,
    others: profileOthers,
    parent: () => q('main'),
    canEdit: canEditCharacter,
    nameOf: (characterId) => roleNames.get(characterId) ?? '这个角色',
    run,
    toast: (text, tone) => toasts.show(text, tone ?? 'info'),
    errorText: characterAdminError,
    disposed: () => disposed,
  });
  // Part 57: every page's 导出 button is made here (one dialog, one place for the words); a page adds its own choices and filters.
  const makeExport: MakeExport = (choices) =>
    exportButton({
      parent: q('main'),
      api: port.exports,
      choices,
      run: (task) => run(task),
      status: (text) => toasts.show(text, 'ok'),
    });
  previewBench = port.previews
    ? previewWorkbench(previewHost, {
        adopt: (input) => void profileBox.open(input),
        makeExport,
        api: port.previews,
        characters: port.characters,
        member: () => session?.member ?? null,
        run,
        status: (text: string) => {
          if (!disposed) status.textContent = text;
        },
        disposed: () => disposed,
        toast: (text, tone, action) => toasts.show(text, tone ?? 'info', action),
        modalParent: () => q('main'),
        changed: () => void workbench?.syncPreviews().catch(() => {}),
        draftUnsaved: () => workbench?.isDirty() === true,
        saveDraft: () => workbench?.saveDraft(),
        ...(port.owner ? { owner: port.owner, confirm: (options, hostNode) => inlineConfirm(hostNode, options) } : {}),
      })
    : null;
  inbox = port.cocreation
    ? cocreationInbox(q('#admin-cocreation'), {
        api: port.cocreation,
        leaveMs: 220,
        characters: port.characters,
        canManage: () => canCocreation('cocreation.manage'),
        makeExport,
        canEditCharacter,
        adoptProfile: (input) => void profileBox.open(input),
        others: profileOthers,
        ...(port.cocreationWordings ? { wordings: port.cocreationWordings } : {}),
        ...(port.cocreationRelations
          ? {
              relations: port.cocreationRelations,
              canEditCast: () =>
                session?.member.role === 'owner' ||
                (!!session && hasCastPermission(session.member.permissions, 'cast.edit')),
            }
          : {}),
        ...(port.cast
          ? {
              castRevision: () => port.cast!.draft().then((draft) => draft.revision),
              canEditCast: () =>
                session?.member.role === 'owner' ||
                (!!session && hasCastPermission(session.member.permissions, 'cast.edit')),
            }
          : {}),
        ...(port.cocreationPoints
          ? { adoptPoints: () => port.cocreationPoints!().then((points) => points.adoptPoints) }
          : {}),
        run,
        status: (text) => {
          if (!disposed) status.textContent = text;
        },
        disposed: () => disposed,
        onChanged: () => void refreshCounts(),
      })
    : null;
  const castPage = castView(q('#admin-cast'), {
    api: port.cast ?? null,
    characters: port.characters,
    canCreateCharacter: () => {
      const member = session?.member;
      return !!member && (member.role === 'owner' || canCreateCharacter(member.permissions));
    },
    can: (permission) =>
      session?.member.role === 'owner' || (!!session && hasCastPermission(session.member.permissions, permission)),
    run,
    status: (text) => {
      if (!disposed) status.textContent = text;
    },
    confirm: (options, host) => inlineConfirm(host, options),
    toast: (text, tone) => toasts.show(text, tone ?? 'info'),
    disposed: () => disposed,
    download: browserDownload,
  });
  const toasts = toastHost(q('main'));
  toastSink = (text, tone) => void toasts.show(text, tone);
  const unavailable = () => Promise.reject(new Error('ADMIN_SYSTEM_UNAVAILABLE'));
  const overview = overviewView(q('#admin-overview'), {
    load: () => (port.overview ? port.overview() : unavailable()),
    makeExport,
    run,
    disposed: () => disposed,
    chart: port.chart
      ? { load: (metric, range) => port.chart!(metric, range), available: () => canSeePage('costs', access()) }
      : undefined,
    stats: port.playerStats
      ? {
          load: (range) => port.playerStats!(range),
          available: () => canSeePage('costs', access()),
        }
      : undefined,
  });
  const system = systemView(q('#admin-system'), {
    load: () => (port.systemStatus ? port.systemStatus() : unavailable()),
    renewPrices: (requestId) => (port.renewPrices ? port.renewPrices(requestId) : unavailable()),
    topUp: (input) => (port.budgetTopUp ? port.budgetTopUp(input) : unavailable()),
    unknownCalls:
      port.unknownCalls && port.resolveUnknownCall
        ? { load: () => port.unknownCalls!(), resolve: (input) => port.resolveUnknownCall!(input) }
        : undefined,
    isOwner: () => session?.member.role === 'owner',
    makeExport,
    run,
    confirm: (options, host) => inlineConfirm(host, options),
    toast: (text) => toasts.show(text, 'ok'),
    newRequestId: () => globalThis.crypto.randomUUID(),
    disposed: () => disposed,
  });
  const costs = costsView(q('#admin-costs'), {
    load: (range) => (port.costs ? port.costs(range) : unavailable()),
    spend: port.spendByType ? (range) => port.spendByType!(range) : undefined,
    makeExport,
    run,
    disposed: () => disposed,
  });
  const points = pointsView(q('#admin-points'), {
    preview: (to, amount) => (port.pointsPreview ? port.pointsPreview(to, amount) : unavailable()),
    grant: (input) => (port.pointsGrant ? port.pointsGrant(input) : unavailable()),
    errorText: adminAccountError,
    resetPreview: () => (port.resetPreview ? port.resetPreview() : unavailable()),
    reset: (requestId) => (port.resetPoints ? port.resetPoints(requestId) : unavailable()),
    ...(port.cocreationPoints && port.saveCocreationPoints
      ? { cocreation: { read: () => port.cocreationPoints!(), save: (input) => port.saveCocreationPoints!(input) } }
      : {}),
    isOwner: () => session?.member.role === 'owner',
    run,
    confirm: (options, host) => inlineConfirm(host, options),
    toast: (text) => toasts.show(text, 'ok'),
    newRequestId: () => globalThis.crypto.randomUUID(),
    disposed: () => disposed,
  });
  const memes = memesView(q('#admin-memes'), {
    api:
      port.cast ?? (new Proxy({}, { get: () => () => Promise.reject(new Error('ADMIN_MEMES_UNAVAILABLE')) }) as never),
    makeExport,
    canEdit: () =>
      session?.member.role === 'owner' || (!!session && hasCastPermission(session.member.permissions, 'cast.edit')),
    newRequestId: () => globalThis.crypto.randomUUID(),
    disposed: () => disposed,
    toast: (text) => toasts.show(text, 'ok'),
    // Part 37c-1b: the permanent delete of his own entries asks in place.
    confirm: (options, host) => inlineConfirm(host, options),
  });
  const broadcast = broadcastView(q('#admin-broadcast'), {
    api:
      port.broadcast ??
      (new Proxy({}, { get: () => () => Promise.reject(new Error('ADMIN_BROADCAST_UNAVAILABLE')) }) as never),
    makeExport,
    run,
    confirm: (options, host) => inlineConfirm(host, options),
    toast: (text) => toasts.show(text, 'ok'),
    newRequestId: () => globalThis.crypto.randomUUID(),
    disposed: () => disposed,
  });
  const tiers = inviteTiersView(q('#admin-invites'), {
    port,
    isOwner: () => session?.member.role === 'owner',
    makeExport,
    run,
    confirm: (options, host) => inlineConfirm(host, options),
    toast: (text) => toasts.show(text, 'ok'),
    newRequestId: () => globalThis.crypto.randomUUID(),
    disposed: () => disposed,
  });
  const models = modelsView(q('#admin-models'), {
    load: () => (port.modelSettings ? port.modelSettings() : Promise.reject(new Error('ADMIN_MODELS_UNAVAILABLE'))),
    save: (input) =>
      port.saveModelSettings ? port.saveModelSettings(input) : Promise.reject(new Error('ADMIN_MODELS_UNAVAILABLE')),
    ...(port.reviewModel && port.saveReviewModel
      ? { review: { load: () => port.reviewModel!(), save: (input) => port.saveReviewModel!(input) } }
      : {}),
    ...(port.writerSetting && port.saveWriterSetting
      ? { writer: { load: () => port.writerSetting!(), save: (input) => port.saveWriterSetting!(input) } }
      : {}),
    isOwner: () => session?.member.role === 'owner',
    run,
    confirm: (options, host) => inlineConfirm(host, options),
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
    makeExport,
    status: (text) => {
      if (!disposed) status.textContent = text;
    },
    disposed: () => disposed,
    adoptLine: (input) => void profileBox.open(input),
    ...(port.owner
      ? {
          owner: port.owner,
          isOwner: () => session?.member.role === 'owner',
          confirm: (options, host) => inlineConfirm(host, options),
          toast: (text, tone) => toasts.show(text, tone ?? 'info'),
        }
      : {}),
  });
  const feedbackPage = feedbackView(q('#admin-feedback'), {
    api: port.feedback ?? {
      counts: () => Promise.reject(new Error('ADMIN_FEEDBACK_UNAVAILABLE')),
      list: () => Promise.reject(new Error('ADMIN_FEEDBACK_UNAVAILABLE')),
      heard: () => Promise.reject(new Error('ADMIN_FEEDBACK_UNAVAILABLE')),
      audio: () => Promise.reject(new Error('ADMIN_FEEDBACK_UNAVAILABLE')),
    },
    run,
    makeExport,
    status: (text) => {
      if (!disposed) status.textContent = text;
    },
    disposed: () => disposed,
  });
  const members = membersView({
    head: q('#admin-members-head'),
    presetHost: q('#admin-new-permissions'),
    gridHost: q('#admin-new-grid'),
    nameInput: q<HTMLInputElement>('#admin-member-label'),
    issueButton: q<HTMLButtonElement>('#admin-member-issue button[type="submit"]'),
    reasonHost: q('#admin-issue-reason'),
    table: q('#admin-members-table'),
    list: q('#admin-members-list'),
    shown: (item) =>
      (!!port.cocreation || !item.startsWith('cocreation.')) &&
      (session?.features?.chatReview === true || !item.startsWith('conversations.')),
    permissionControls,
    run,
    busy: () => lockedBy(q<HTMLButtonElement>('#admin-member-issue button[type="submit"]')),
    api: port,
    showSecret,
    status: (text) => {
      if (!disposed) status.textContent = text;
    },
    disposed: () => disposed,
    permissionLimit: ADMIN_PERMISSION_LIMIT,
    totalPermissions: ADMIN_PERMISSION_ITEMS.length,
  });
  const clearManagement = () => {
    tiers.clear();
    members.clear();
    workbench?.clear();
    previewBench?.clear();
    castPage?.clear();
    picker.clear();
    overview.clear();
    system.clear();
    costs.clear();
    points.clear();
    broadcast.clear();
    memes.clear();
    reviews.clear();
    models.clear();
    inbox?.clear();
    unread = {};
  };
  const adoptSession = (current: AccountAdminSession) => {
    // Part 59: the same administrator signing in again (another tab, a re-verification) only brings a new CSRF token: nothing is reset
    // (it used to clear the page and send it to 我的账号). A DIFFERENT administrator resets everything, and their kept edits go.
    if (session && session.member.id !== current.member.id) {
      clearAllKeptEdits();
      clearSecrets();
      clearManagement();
      bindId = null;
      resetId = null;
      page = 'account';
      status.textContent = '登录身份或会话已改变，已清除上一会话的本页资料与请求；没有自动提交。';
    }
    session = current;
  };
  for (const button of root.querySelectorAll<HTMLElement>('[data-page]'))
    listen(button, 'click', (event) => {
      const click = event as MouseEvent;
      // Let the browser open a link in a new tab; everything else is handled here so unsaved edits are guarded.
      if (click.metaKey || click.ctrlKey || click.shiftKey || click.button === 1) return;
      event.preventDefault();
      if (disposed) return;
      // Already on this page: nothing to do (each page has its own refresh button).
      if (isAdminPage(button.dataset.page!) && sameRoute({ page: button.dataset.page, id: null }, here())) return;
      whenLeaveOk(() => {
        if (!navigate(button.dataset.page!)) return;
        openLoad();
      });
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
    // Back, Forward or an edited address with unsaved changes: the address goes back at once, the question is asked, and the move
    // is made only if the answer lets it.
    if (page === 'characters' && workbench && !workbench.canLeave()) {
      address.replace(before);
      whenLeaveOk(() => {
        if (!navigate(wanted.page, wanted.id)) return;
        openLoad();
      });
      return;
    }
    if (!navigate(wanted.page, wanted.id, { replaceUrl: true })) {
      address.replace(before);
      return;
    }
    openLoad();
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
    if (session?.member.role !== 'owner') return;
    await members.issue(value('admin-member-label').trim());
  });
  listen(q('#admin-secret-close'), 'click', clearSecrets);
  listen(q('#admin-logout'), 'click', () => {
    whenLeaveOk(() => {
      void run(async () => {
        cancelLoad();
        clearSecrets();
        // Part 59: an explicit sign-out removes the edits this browser kept (a session that merely expired keeps them).
        clearAllKeptEdits();
        await port.logout();
        if (disposed) return;
        session = null;
        clearManagement();
        navigate('login');
        address.replace(null);
        status.textContent = '已退出登录。';
      });
    });
  });
  /**
   * Part 59: coming back to the tab (or the window) re-reads the session IN THE BACKGROUND. It used to run as a `run`, which sets
   * `busy` and disables EVERY control of the page (the 「not-allowed」 cursor) until the answer came; a slow or hung answer (a
   * Cloudflare challenge, a sleeping connection) froze the page for minutes. Now nothing is disabled, nothing waits for it, the
   * request has a 15 s deadline, and an interruption only raises the connection line.
   */
  let refreshing = false;
  const refresh = () => {
    if (!session || disposed || refreshing) return;
    refreshing = true;
    void port
      .restore()
      .then((current) => {
        if (disposed) return;
        const before = JSON.stringify([session?.member.role, session?.member.permissions]);
        adoptSession(current);
        if (JSON.stringify([current.member.role, current.member.permissions]) === before) return;
        if (current.member.role !== 'owner') {
          members.clear();
          if (page === 'members') page = 'account';
        }
        // A page whose permission was just taken away is no longer offered; the pages that explain themselves stay.
        if (isAdminPage(page) && page !== 'invites' && page !== 'characters' && !canSeePage(page, access())) {
          page = 'account';
          routeId = null;
          address.replace({ page, id: null });
        }
        render();
      })
      .catch(() => {
        /* an interruption raises the connection line; anything else is tried again at the next return */
      })
      .finally(() => {
        refreshing = false;
      });
  };
  // 总览 and 系统状态 reload by themselves every 60 s while the tab is visible and nothing else is running.
  const tick = setInterval(() => {
    if (!session || disposed || (page !== 'overview' && page !== 'system')) return;
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
  const onVisible = () => {
    if (document.visibilityState === 'visible') refresh();
  };
  document.addEventListener('visibilitychange', onVisible);
  cleanups.push(() => document.removeEventListener('visibilitychange', onVisible));
  // Part 59: the admin session slides (8 h after the last request, 24 h at most). While the console is in use but quiet (reading,
  // typing a long text) a request every 10 minutes keeps it alive, so an active owner is never logged out mid-edit.
  let lastActive = Date.now();
  const touched = () => {
    lastActive = Date.now();
  };
  for (const type of ['pointerdown', 'keydown', 'scroll'])
    document.addEventListener(type, touched, { passive: true, capture: true });
  cleanups.push(() => {
    for (const type of ['pointerdown', 'keydown', 'scroll']) document.removeEventListener(type, touched, true);
  });
  const keepAlive = setInterval(() => {
    if (session && !disposed && Date.now() - lastActive < 10 * 60_000) refresh();
  }, 10 * 60_000);
  (keepAlive as { unref?: () => void }).unref?.();
  cleanups.push(() => clearInterval(keepAlive));
  // Part 59: the connection line. While the console cannot reach its API the owner is told once, can verify or sign in again in a
  // popup (the page itself stays where it is), and every 4 s the session is probed: the moment the API answers, the saves that
  // were waiting are sent again (see services/admin-connection.ts).
  const connBox = q<HTMLElement>('#admin-conn');
  const connLine = q<HTMLElement>('#admin-conn-line');
  let probe: ReturnType<typeof setInterval> | null = null;
  const stopProbe = () => {
    if (probe) clearInterval(probe);
    probe = null;
  };
  let reauthPopup: Window | null = null;
  const openReauth = () => {
    const url = reauthUrl(window.location);
    reauthPopup = window.open(url, 'fb-admin-reauth', 'popup=yes,width=560,height=720');
    // Blocked: the 重新验证 link does the same in a new tab.
    q<HTMLElement>('#admin-conn-link').hidden = !!reauthPopup;
  };
  const retryButton = q<HTMLElement>('#admin-conn-retry');
  const paintConnection = (state: 'ok' | 'interrupted', reason?: string | null) => {
    connBox.hidden = state === 'ok' || !session;
    // Part 60: a page whose load timed out is named (the page's name only, never an id) and offers 重试.
    const naming = state === 'interrupted' && failedLoad && failedLoad.page === page ? failedLoad : null;
    retryButton.hidden = !naming;
    connLine.textContent =
      adminConnection.reason === 'access' || reason === 'access'
        ? ACCESS_EXPIRED_LINE
        : naming && !adminConnection.writePending
          ? `「${pageName(naming.page)}」没能加载：连接超时或中断，修改都还在`
          : adminConnection.writePending
            ? INTERRUPTED_LINE
            : INTERRUPTED_LINE_READ;
    if (state === 'interrupted' && (reason ?? adminConnection.reason) === 'access' && !reauthPopup?.closed)
      openReauth();
    if (state === 'ok') {
      // The API answers JSON again: the popup did its job.
      try {
        reauthPopup?.close();
      } catch {
        /* already gone */
      }
      reauthPopup = null;
      q<HTMLElement>('#admin-conn-link').hidden = true;
      retryButton.hidden = true;
      stopProbe();
      // The way is open again: the page that could not load tries once more by itself.
      const again = failedLoad;
      failedLoad = null;
      if (again && !disposed && again.page === page) again.again();
      if (!disposed && [INTERRUPTED_LINE, ACCESS_EXPIRED_LINE].includes(statusLine.textContent))
        statusLine.textContent = '';
    } else if (!probe) {
      probe = setInterval(refresh, 4000);
      (probe as { unref?: () => void }).unref?.();
    }
  };
  cleanups.push(adminConnection.on(paintConnection), stopProbe);
  listen(q('#admin-conn-open'), 'click', openReauth);
  listen(retryButton, 'click', () => {
    const again = failedLoad;
    failedLoad = null;
    if (again && again.page === page) again.again();
    else openLoad();
    connBox.hidden = true;
  });
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
      if (!disposed) render();
    });
  return () => {
    loadControl?.abort();
    disposed = true;
    clearSecrets();
    session = null;
    workbench?.dispose();
    previewBench?.dispose();
    profileImporter?.dispose();
    castPage.dispose();
    toasts.dispose();
    inbox?.dispose();
    for (const cleanup of cleanups) cleanup();
    stopFieldWidths();
    scroll.stop();
    root.replaceChildren();
  };
}

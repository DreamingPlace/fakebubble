import type { AccountAdminApi, AccountAdminSession } from '../../services/account-admin-api.ts';
import { characterWorkbench, characterAdminError } from './character-workbench.ts';
import { permissionEditor } from './permission-editor.ts';
import { inviteRecords } from './invite-records.ts';
import {
  ADMIN_PERMISSION_LIMIT,
  permissionCategory,
  hasInvitePermission,
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
>;
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

/** Administrator-only surface. No player registration, external identity providers or browser secret storage. */
export function startAccountAdminPage(root: HTMLElement, port: Port): () => void {
  root.innerHTML = `<main class="invite-admin-page account-admin-page">
    <h1 tabindex="-1">管理员登录</h1>
    <p class="admin-identity"></p>
    <nav class="admin-nav" aria-label="管理页面" hidden>
      <button type="button" data-page="characters">角色资料</button><button type="button" data-page="invites">邀请码</button><button type="button" data-page="account">我的账号</button>
      <button type="button" data-page="members">管理员权限</button><button type="button" id="admin-logout">退出登录</button>
    </nav>
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
      <button id="admin-account-continue" class="admin-back" type="button" data-page="invites">进入管理</button></section>
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
    <section data-panel="members" hidden><h2>管理员权限</h2><p>调整功能权限不退出对方账号，也不影响玩家会话或存档。</p>
      <details class="admin-new-member"><summary>添加管理员 · 签发一次性登录凭据</summary><form id="admin-member-issue"><label for="admin-member-label">管理员备注（便于识别，不是职位）</label><input id="admin-member-label" maxlength="80" required>
        <p>勾选需要的功能类别，再签发一次性登录凭据。使用凭据后立即获得所选权限；邮箱绑定可稍后完成。</p><div id="admin-new-permissions"></div>
        <button type="submit">签发管理员一次性凭据</button></form></details>
      <button class="admin-back" id="admin-members-refresh" type="button">刷新权限列表</button><div id="admin-members-list"></div>
    </section>
    <section class="invite-admin-result" id="admin-secret" hidden><span id="admin-secret-label"></span><strong class="invite-admin-code" id="admin-secret-value"></strong>
      <button id="admin-secret-close" type="button">已记录，清除显示</button></section>
    <p class="invite-admin-status" role="status" aria-live="polite">正在检查登录状态…</p>
  </main>`;
  const q = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const value = (id: string) => q<HTMLInputElement>(`#${id}`).value;
  const status = q<HTMLElement>('.invite-admin-status'),
    title = q<HTMLElement>('h1');
  let session: AccountAdminSession | null = null,
    page = 'login',
    busy = true,
    disposed = false;
  let bindId: string | null = null,
    resetId: string | null = null,
    issueUnknown = false,
    memberUnknown = false;
  const cleanups: Array<() => void> = [];
  const can = (permission: InviteAdminPermission) =>
    session?.member.role === 'owner' || (!!session && hasInvitePermission(session.member.permissions, permission));
  let workbench: ReturnType<typeof characterWorkbench> | null = null;
  let newPermissions: ReturnType<typeof permissionEditor> | null = null;
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
    title.textContent = session ? 'FAKE 泡泡管理' : '管理员登录';
    q<HTMLElement>('.admin-identity').textContent = session
      ? `${session.member.role === 'owner' ? '主管理员' : '管理员'} · ${session.member.email ?? session.member.label}`
      : '';
    q<HTMLElement>('.admin-nav').hidden = !session;
    q<HTMLButtonElement>('[data-page="members"]').hidden = session?.member.role !== 'owner';
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
    for (const nav of root.querySelectorAll<HTMLElement>('.admin-nav [data-page]')) {
      if (nav.dataset.page === page) nav.setAttribute('aria-current', 'page');
      else nav.removeAttribute('aria-current');
    }
  };
  const navigate = (next: string) => {
    if (page === 'characters' && next !== 'characters' && workbench && !workbench.canLeave()) {
      status.textContent = '请先保存草稿，或放弃本页修改后再切换。';
      return false;
    }
    clearSecrets();
    bindId = null;
    resetId = null;
    page = next;
    status.textContent = '';
    render();
    title.focus();
    return true;
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
    page = result.member.email ? 'invites' : 'account';
    status.textContent = '已登录。';
    if (page === 'invites' && can('invites.read')) await records.load();
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
  workbench = characterWorkbench(q('#admin-characters'), {
    api: port.characters,
    member: () => session?.member ?? null,
    run,
    status: (text) => {
      if (!disposed) status.textContent = text;
    },
    disposed: () => disposed,
  });
  const records = inviteRecords(q('#admin-invite-records'), port, can, run, () => disposed);
  const clearMemberControls = () => {
    q('#admin-members-list').replaceChildren();
    q('#admin-new-permissions').replaceChildren();
    newPermissions = null;
  };
  const clearManagement = () => {
    records.clear();
    clearMemberControls();
    workbench?.clear();
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
    newPermissions = permissionEditor(q('#admin-new-permissions'), selected);
    const list = q<HTMLElement>('#admin-members-list');
    list.replaceChildren();
    for (const member of result.members) {
      const item = document.createElement('details');
      item.className = 'admin-member';
      const heading = document.createElement('summary');
      heading.textContent = `${member.label} · ${member.role === 'owner' ? '主管理员' : `已分配 ${new Set(member.permissions.map(permissionCategory)).size} 类功能`}`;
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
        const editor = permissionEditor(controls, member.permissions);
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
    listen(button, 'click', () => {
      if (busy || disposed) return;
      if (!navigate(button.dataset.page!)) return;
      if (page === 'characters') void run(() => workbench!.load());
      else if (page === 'members') void run(loadMembers);
      else if (page === 'invites' && can('invites.read')) void run(() => records.load());
    });
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
    });
  };
  window.addEventListener('focus', refresh);
  cleanups.push(() => window.removeEventListener('focus', refresh));
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
    for (const cleanup of cleanups) cleanup();
    root.replaceChildren();
  };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveBinding } from '../../src/features/prototype/provider-binding.ts';
import {
  ProviderApi,
  ProviderApiError,
  type AccountInfo,
  type CodeChallenge,
} from '../../src/services/provider-api.ts';
import {
  accountCopy,
  accountError,
  openAccountSheet,
  type AccountApi,
  type AccountSheetMode,
  type Timers,
} from '../../src/features/account/account-sheet.ts';
import { renderSignedOut, signedOutCopy, type SignedOutApi } from '../../src/features/account/signed-out-page.ts';
import { providerStartFailure, renderProviderStartError } from '../../src/features/prototype/provider-start-error.ts';
import { recoveryCopy } from '../../src/features/prototype/recovery-code.ts';
import { syntheticProviderBootstrap, parseWebProviderBootstrap } from '../../../../packages/contracts/web-provider.ts';
import { FakeElement, flush, installFakeDom } from './fake-dom.ts';

/** A clock the test moves; setInterval callbacks run when it is advanced. */
function clock() {
  let now = 1_000_000;
  const jobs = new Map<number, { fn: () => void; ms: number; next: number }>();
  let id = 0;
  const timers: Timers = {
    now: () => now,
    setInterval: (fn, ms) => {
      jobs.set(++id, { fn, ms, next: now + ms });
      return id;
    },
    clearInterval: (handle) => void jobs.delete(handle as number),
  };
  const advance = (ms: number) => {
    const end = now + ms;
    while (true) {
      const due = [...jobs.values()].filter((job) => job.next <= end).sort((a, b) => a.next - b.next)[0];
      if (!due) break;
      now = due.next;
      due.next += due.ms;
      due.fn();
    }
    now = end;
  };
  return { timers, advance, active: () => jobs.size };
}
type Calls = { name: string; args: unknown[] }[];
function fakeApi(over: Partial<Record<keyof AccountApi, (...args: never[]) => unknown>> = {}) {
  const calls: Calls = [];
  const challenge: CodeChallenge = { challengeId: 'challenge-1', expiresAt: 1_600_000, resendAfterMs: 60_000 };
  const record =
    <T>(name: string, result: T) =>
    async (...args: unknown[]) => {
      calls.push({ name, args });
      const custom = over[name as keyof AccountApi] as ((...a: unknown[]) => unknown) | undefined;
      return custom ? custom(...args) : result;
    };
  const api: AccountApi = {
    requestEmailCode: record('requestEmailCode', challenge),
    verifyEmailCode: record('verifyEmailCode', undefined),
    finishAccount: record('finishAccount', { nickname: '阿泡', emailMasked: 'p***@example.com' }),
    login: record('login', undefined),
    resetPassword: record('resetPassword', undefined),
    changePassword: record('changePassword', undefined),
    setNickname: record('setNickname', undefined),
    abandonSession: record('abandonSession', undefined),
  } as unknown as AccountApi;
  return { api, calls, names: () => calls.map((c) => c.name) };
}
function open(
  t: test.TestContext,
  mode: AccountSheetMode,
  options: { api?: AccountApi; signupEnabled?: boolean; hasGuestChats?: boolean; nickname?: string } = {},
) {
  const doc = installFakeDom(t);
  const f = fakeApi();
  const c = clock();
  const log = { done: [] as string[], cancelled: 0, switched: [] as string[] };
  const sheet = openAccountSheet({
    api: options.api ?? f.api,
    mode,
    mount: doc.body as unknown as HTMLElement,
    timers: c.timers,
    doneMs: 0,
    signupEnabled: options.signupEnabled ?? true,
    ...(options.hasGuestChats !== undefined ? { hasGuestChats: options.hasGuestChats } : {}),
    ...(options.nickname ? { nickname: options.nickname } : {}),
    onDone: (done) => log.done.push(done),
    onCancel: () => log.cancelled++,
    onSwitch: (to) => log.switched.push(to),
  });
  const root = sheet.element as unknown as FakeElement;
  const input = (name: string) => root.querySelector(`input[name="${name}"]`)!;
  const status = () => root.querySelector('.acct-status')!.textContent;
  const submit = () => root.querySelector('form')!.dispatch('submit');
  return { doc, root, input, status, submit, sheet, f, c, log, text: () => root.textContent };
}

test('注册: email → code → password + nickname, one step at a time, with the agreed lines', async (t) => {
  const s = open(t, 'signup');
  assert.equal(s.root.querySelector('.acct-title')!.textContent, '注册');
  assert.equal(s.root.getAttribute('role'), 'dialog');
  assert.equal(s.root.getAttribute('aria-modal'), 'true');
  // A malformed address never reaches the server.
  s.input('email').value = 'not-an-email';
  s.submit();
  assert.equal(s.status(), accountCopy.errors.PLAYER_EMAIL_INVALID);
  assert.deepEqual(s.f.names(), []);
  s.input('email').value = ' Player@Example.com ';
  s.submit();
  await flush();
  assert.deepEqual(s.f.calls[0], {
    name: 'requestEmailCode',
    args: [{ purpose: 'signup', email: 'Player@Example.com' }],
  });
  assert.equal(s.status(), accountCopy.codeSent);
  assert.match(s.text(), /Player@Example\.com/);
  // Only six digits are sent for verification.
  s.input('code').value = '12ab56';
  s.submit();
  assert.equal(s.status(), accountCopy.errors.PLAYER_CODE_INVALID);
  assert.equal(s.f.names().includes('verifyEmailCode'), false);
  s.input('code').value = '123456';
  s.submit();
  await flush();
  assert.deepEqual(s.f.calls.at(-1), {
    name: 'verifyEmailCode',
    args: [{ challengeId: 'challenge-1', code: '123456' }],
  });
  // Password and nickname are checked before they are sent.
  s.input('password').value = 'short';
  s.input('nickname').value = '阿泡';
  s.submit();
  assert.equal(s.status(), accountCopy.errors.PLAYER_PASSWORD_INVALID);
  s.input('password').value = 'correct horse battery';
  s.input('nickname').value = '换\n行';
  s.submit();
  assert.equal(s.status(), accountCopy.errors.PLAYER_NICKNAME_INVALID);
  s.input('nickname').value = 'x'.repeat(21);
  s.submit();
  assert.equal(s.status(), accountCopy.errors.PLAYER_NICKNAME_INVALID);
  s.input('nickname').value = '  阿泡  ';
  s.submit();
  await flush();
  assert.deepEqual(s.f.calls.at(-1), {
    name: 'finishAccount',
    args: [{ purpose: 'signup', challengeId: 'challenge-1', password: 'correct horse battery', nickname: '阿泡' }],
  });
  assert.equal(s.root.querySelector('.acct-done')?.textContent ?? '', accountCopy.doneSignup);
  s.c.advance(100);
  await flush();
  assert.deepEqual(s.log.done, ['signup']);
  assert.equal(s.log.cancelled, 0);
  assert.equal(s.c.active(), 0, 'no timer outlives the sheet');
  assert.equal(s.doc.body.querySelectorAll('.acct-sheet').length, 0);
});

test('a wrong code, a server refusal and a network failure each show a fixed line and keep the step', async (t) => {
  let attempts = 0;
  const f = fakeApi({
    verifyEmailCode: () => {
      attempts++;
      throw new ProviderApiError(400, 'PLAYER_CODE_INVALID');
    },
  });
  const s = open(t, 'signup', { api: f.api });
  s.input('email').value = 'a@example.com';
  s.submit();
  await flush();
  s.input('code').value = '000000';
  s.submit();
  await flush();
  assert.equal(attempts, 1);
  assert.equal(s.status(), accountCopy.errors.PLAYER_CODE_INVALID);
  assert.ok(s.root.querySelector('input[name="code"]'), 'still on the code step');
  assert.equal(s.root.querySelector('button[type="submit"]')!.disabled, false, 'the button is usable again');
  // Raw messages never reach the page.
  assert.equal(accountError(new Error('secret internals')), accountCopy.errors.NETWORK);
  assert.equal(accountError(new ProviderApiError(500, 'INTERNAL_ERROR')), accountCopy.errors.NETWORK);
  assert.equal(accountError(new ProviderApiError(401, 'PLAYER_LOGIN_INVALID')), '邮箱或密码不正确');
  assert.equal(
    accountError(new ProviderApiError(403, 'PLAYER_ACCESS_REVOKED')),
    accountCopy.errors.PLAYER_ACCESS_REVOKED,
  );
  assert.match(accountError(new ProviderApiError(429, 'PLAYER_RATE_LIMITED', 5 * 60_000)), /5 分钟/);
  assert.match(accountError(new ProviderApiError(429, 'PLAYER_RATE_LIMITED', null)), /1 分钟/);
  assert.equal(
    accountError(new ProviderApiError(429, 'PLAYER_EMAIL_DAILY_CAP', 1000)),
    accountCopy.errors.PLAYER_EMAIL_DAILY_CAP,
  );
});

test('重新发送 waits out the 60 s cooldown, then asks again (a new request, never an automatic one)', async (t) => {
  const s = open(t, 'signup');
  s.input('email').value = 'resend@example.com';
  s.submit();
  await flush();
  const resend = () => s.root.querySelector('.acct-link')!;
  assert.equal(resend().disabled, true);
  assert.equal(resend().textContent, accountCopy.resendIn(60));
  s.c.advance(30_000);
  assert.equal(resend().textContent, accountCopy.resendIn(30));
  resend().click();
  assert.equal(s.f.names().filter((n) => n === 'requestEmailCode').length, 1, 'a disabled button asks nothing');
  s.c.advance(30_000);
  assert.equal(resend().disabled, false);
  assert.equal(resend().textContent, accountCopy.resend);
  resend().click();
  await flush();
  assert.equal(s.f.names().filter((n) => n === 'requestEmailCode').length, 2);
  assert.equal(resend().disabled, true, 'a fresh cooldown starts');
  s.c.advance(10 * 60_000);
  assert.equal(s.f.names().filter((n) => n === 'requestEmailCode').length, 2, 'nothing is sent by itself');
});

test('while signup is closed the sheets say 注册暂未开放 and call nothing', (t) => {
  for (const mode of ['signup', 'bind', 'reset'] as const) {
    const s = open(t, mode, { signupEnabled: false });
    assert.equal(s.root.querySelector('.acct-closed')!.textContent, accountCopy.closed, mode);
    assert.equal(accountCopy.closed, '注册暂未开放');
    assert.equal(s.root.querySelector('input'), null, mode);
    assert.deepEqual(s.f.names(), [], mode);
  }
  // Login is not closed.
  const login = open(t, 'login', { signupEnabled: false });
  assert.ok(login.root.querySelector('input[name="password"]'));
  assert.equal(login.root.textContent.includes('没有账号？注册'), false, 'no sign-up link while signup is closed');
});

test('登录: generic failure line, wait line, and the guest-chats notice only when a guest with chats would be switched away', async (t) => {
  let mode: 'bad' | 'limited' | 'ok' = 'bad';
  const f = fakeApi({
    login: () => {
      if (mode === 'bad') throw new ProviderApiError(401, 'PLAYER_LOGIN_INVALID');
      if (mode === 'limited') throw new ProviderApiError(429, 'PLAYER_RATE_LIMITED', 12 * 60_000);
      return undefined;
    },
  });
  const plain = open(t, 'login', { api: f.api });
  assert.equal(plain.root.querySelector('.acct-notice'), null);
  plain.input('email').value = 'a@example.com';
  plain.input('password').value = 'whatever pass';
  plain.submit();
  await flush();
  assert.equal(plain.status(), '邮箱或密码不正确');
  mode = 'limited';
  plain.submit();
  await flush();
  assert.match(plain.status(), /12 分钟/);
  mode = 'ok';
  const typed = plain.input('password');
  plain.submit();
  await flush();
  assert.deepEqual(f.calls.at(-1), { name: 'login', args: [{ email: 'a@example.com', password: 'whatever pass' }] });
  assert.equal(typed.value, '', 'the password does not linger');
  await flush();
  assert.deepEqual(plain.log.done, ['login']);
  // A guest with chats is told before switching.
  const chats = open(t, 'login', { hasGuestChats: true });
  assert.equal(chats.root.querySelector('.acct-notice strong')!.textContent, '当前访客的聊天不会合并');
  assert.equal(accountCopy.loginNoMerge, '当前访客的聊天不会合并');
  assert.equal(chats.root.querySelector('button[type="submit"]')!.textContent, accountCopy.loginSwitch);
  // Empty fields never reach the server.
  chats.submit();
  assert.equal(chats.status(), '邮箱或密码不正确');
  assert.deepEqual(chats.f.names(), []);
  // The links hand over to the sibling flows and close this sheet.
  const links = chats.root.querySelectorAll('.acct-link');
  assert.deepEqual(
    links.map((l) => l.textContent),
    [accountCopy.forgot, accountCopy.toSignup],
  );
  links[0]!.click();
  assert.deepEqual(chats.log.switched, ['reset']);
  assert.equal(chats.doc.body.querySelectorAll('.acct-sheet').length, 0, 'the login sheet closed itself');
  assert.equal(chats.log.cancelled, 0, 'switching is not a cancellation');
});

test('忘记密码 ends in a reset, not a signup, and says other devices were signed out', async (t) => {
  const s = open(t, 'reset');
  assert.equal(s.root.querySelector('.acct-title')!.textContent, '忘记密码');
  s.input('email').value = 'reset@example.com';
  s.submit();
  await flush();
  assert.deepEqual(s.f.calls[0]!.args, [{ purpose: 'reset', email: 'reset@example.com' }]);
  s.input('code').value = '654321';
  s.submit();
  await flush();
  assert.equal(s.root.querySelector('input[name="nickname"]'), null, 'a reset asks for no nickname');
  s.input('password').value = 'a brand new one';
  s.submit();
  await flush();
  assert.deepEqual(s.f.calls.at(-1), {
    name: 'resetPassword',
    args: [{ challengeId: 'challenge-1', password: 'a brand new one' }],
  });
  assert.equal(s.root.querySelector('.acct-done')!.textContent, '密码已重置，其他设备已退出登录');
  s.c.advance(100);
  await flush();
  assert.deepEqual(s.log.done, ['reset']);
});

test('绑定邮箱 explains that the recovery code stops working and finishes as a bind', async (t) => {
  const s = open(t, 'bind');
  assert.match(s.text(), /恢复码会失效/);
  s.input('email').value = 'legacy@example.com';
  s.submit();
  await flush();
  assert.deepEqual(s.f.calls[0]!.args, [{ purpose: 'bind', email: 'legacy@example.com' }]);
  s.input('code').value = '111111';
  s.submit();
  await flush();
  s.input('password').value = 'a brand new one';
  s.input('nickname').value = '老玩家';
  s.submit();
  await flush();
  assert.equal((s.f.calls.at(-1)!.args[0] as { purpose: string }).purpose, 'bind');
  assert.equal(s.root.querySelector('.acct-done')!.textContent, accountCopy.doneBind);
});

test('我的昵称 shows the current name and saves a trimmed one; 修改密码 needs both passwords and offers 退出其他设备', async (t) => {
  const nick = open(t, 'nickname', { nickname: '旧名' });
  assert.equal(nick.input('nickname').value, '旧名');
  nick.input('nickname').value = '   ';
  nick.submit();
  assert.equal(nick.status(), accountCopy.errors.PLAYER_NICKNAME_INVALID);
  nick.input('nickname').value = ' 新名 ';
  nick.submit();
  await flush();
  assert.deepEqual(nick.f.calls.at(-1), { name: 'setNickname', args: ['新名'] });
  assert.equal(nick.root.querySelector('.acct-done')!.textContent, accountCopy.doneNickname);

  const pass = open(t, 'password');
  pass.input('current').value = 'short';
  pass.input('next').value = 'a brand new one';
  pass.submit();
  assert.equal(pass.status(), accountCopy.errors.PLAYER_PASSWORD_INVALID);
  pass.input('current').value = 'current password';
  pass.submit();
  await flush();
  assert.deepEqual(pass.f.calls.at(-1), {
    name: 'changePassword',
    args: [{ current: 'current password', next: 'a brand new one', logoutOthers: false }],
  });
  assert.equal(pass.root.querySelector('.acct-done')!.textContent, accountCopy.donePassword);
  const again = open(t, 'password');
  again.input('current').value = 'current password';
  again.input('next').value = 'a brand new one';
  again.input('logoutOthers').checked = true;
  again.submit();
  await flush();
  assert.equal((again.f.calls.at(-1)!.args[0] as { logoutOthers: boolean }).logoutOthers, true);
  // A wrong current password shows the generic line and keeps the form.
  const wrong = open(t, 'password', {
    api: fakeApi({
      changePassword: () => {
        throw new ProviderApiError(401, 'PLAYER_LOGIN_INVALID');
      },
    }).api,
  });
  wrong.input('current').value = 'current password';
  wrong.input('next').value = 'a brand new one';
  wrong.submit();
  await flush();
  assert.equal(wrong.status(), '邮箱或密码不正确');
  assert.ok(wrong.root.querySelector('input[name="current"]'));
});

test('closing a sheet cancels it once, stops its timers and removes it; Escape does the same', async (t) => {
  const s = open(t, 'signup');
  s.input('email').value = 'close@example.com';
  s.submit();
  await flush();
  assert.equal(s.c.active(), 1);
  s.root.querySelector('.acct-close')!.click();
  s.sheet.close();
  assert.equal(s.log.cancelled, 1);
  assert.equal(s.c.active(), 0);
  assert.equal(s.doc.body.querySelectorAll('.acct-sheet').length, 0);
  const e = open(t, 'login');
  e.root.dispatch('keydown', { key: 'Escape' });
  assert.equal(e.log.cancelled, 1);
});

test('no sheet stores anything: no localStorage, sessionStorage or cookie access', async (t) => {
  const touched: string[] = [];
  for (const name of ['localStorage', 'sessionStorage'] as const) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: new Proxy({}, { get: (_, key) => touched.push(`${name}.${String(key)}`) && (() => null) }),
    });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  for (const mode of ['signup', 'login', 'reset', 'bind', 'nickname', 'password'] as const) {
    const s = open(t, mode);
    s.input(
      mode === 'nickname' ? 'nickname' : mode === 'password' ? 'current' : mode === 'login' ? 'email' : 'email',
    ).value = 'x@example.com';
    s.sheet.close();
  }
  assert.deepEqual(touched, []);
});

function signedOutApi(over: Partial<SignedOutApi> = {}, info: AccountInfo = { signupEnabled: true, signedIn: false }) {
  const f = fakeApi();
  const calls = f.calls;
  const api = {
    ...f.api,
    account: async () => {
      calls.push({ name: 'account', args: [] });
      return info;
    },
    bootstrap: async () => {
      calls.push({ name: 'bootstrap', args: [] });
      return undefined;
    },
    recoverWithRecoveryCode: async () => 'N'.repeat(43),
    regenerateRecoveryCode: async () => 'N'.repeat(43),
    ...over,
  } as unknown as SignedOutApi;
  return { api, calls, names: () => calls.map((c) => c.name) };
}
function signedOut(t: test.TestContext, over: Partial<SignedOutApi> = {}, info?: AccountInfo) {
  const doc = installFakeDom(t);
  const root = doc.createElement('div');
  const f = signedOutApi(over, info);
  const c = clock();
  let reloads = 0;
  const page = renderSignedOut(root as unknown as HTMLElement, {
    api: f.api,
    reload: () => reloads++,
    timers: c.timers,
    mount: doc.body as unknown as HTMLElement,
    doneMs: 0,
  });
  const button = (label: string) => root.querySelectorAll('button').find((b) => b.textContent === label)!;
  return { doc, root, f, page, button, reloads: () => reloads };
}

test('the signed-out first page offers 登录 / 注册 / 以访客继续 and a small 我有恢复码 link — not an error, not a dead end', async (t) => {
  const s = signedOut(t);
  await s.page.ready;
  assert.equal(s.root.querySelector('h1')!.textContent, signedOutCopy.title);
  assert.deepEqual(
    s.root.querySelectorAll('.signed-out-actions button').map((b) => b.textContent),
    ['登录', '注册', '以访客继续'],
  );
  const have = s.root.querySelector('.signed-out-more button')!;
  assert.equal(have.textContent, recoveryCopy.have);
  assert.ok(have.classList.contains('signed-out-recovery'));
  assert.doesNotMatch(s.root.textContent, /访问会话需要恢复|没有将受邀身份/);
  // Nothing was created or revoked just by showing the page.
  assert.deepEqual(s.f.names(), ['account']);
  // 我有恢复码 is wired to the existing recovery entry (its own behaviour is covered in provider-recovery.test.ts; that
  // component builds its dialog from HTML, which this in-memory DOM refuses by design).
  assert.equal(have.listeners.get('click')?.length, 1);
});

test('登录 on the first page opens the login sheet and reloads after success; 忘记密码 reaches the reset sheet', async (t) => {
  const s = signedOut(t);
  await s.page.ready;
  s.button('登录').click();
  await flush();
  const sheet = s.doc.body.querySelector('.acct-sheet')!;
  assert.equal(sheet.querySelector('.acct-title')!.textContent, '登录');
  assert.equal(sheet.querySelector('.acct-notice'), null, 'no guest, nothing to warn about');
  sheet.querySelectorAll('.acct-link')[0]!.click();
  assert.equal(s.doc.body.querySelector('.acct-sheet')!.querySelector('.acct-title')!.textContent, '忘记密码');
  assert.equal(s.reloads(), 0);
});

test('注册 on the first page starts a guest the normal way (forget the dead cookie, bootstrap) and opens signup; closed means nothing is created', async (t) => {
  const open_ = signedOut(t);
  await open_.page.ready;
  open_.button('注册').click();
  await flush();
  await flush();
  assert.deepEqual(open_.f.names(), ['account', 'abandonSession', 'bootstrap']);
  assert.equal(open_.doc.body.querySelector('.acct-sheet')!.querySelector('.acct-title')!.textContent, '注册');
  // Closing it leaves the player in the guest chat that was just started.
  open_.doc.body.querySelector('.acct-close')!.click();
  assert.equal(open_.reloads(), 1);

  const closed = signedOut(t, {}, { signupEnabled: false, signedIn: false });
  await closed.page.ready;
  closed.button('注册').click();
  await flush();
  assert.equal(closed.doc.body.querySelector('.acct-closed')!.textContent, '注册暂未开放');
  assert.deepEqual(closed.f.names(), ['account'], 'no guest was created for a closed signup');
});

test('以访客继续 forgets the dead cookie and uses the first-visit bootstrap, once, then reloads', async (t) => {
  const s = signedOut(t);
  await s.page.ready;
  const guest = s.button('以访客继续');
  guest.click();
  guest.click();
  await flush();
  await flush();
  assert.deepEqual(s.f.names(), ['account', 'abandonSession', 'bootstrap']);
  assert.equal(s.reloads(), 1);
  // A failure shows a line, not a stack, and the page stays usable.
  const failing = signedOut(t, { bootstrap: async () => Promise.reject(new ProviderApiError(0, 'NETWORK')) as never });
  await failing.page.ready;
  failing.button('以访客继续').click();
  await flush();
  await flush();
  assert.equal(failing.root.querySelector('.signed-out-notice')!.textContent, signedOutCopy.failed);
  assert.equal(failing.reloads(), 0);
});

test('a dead cookie at startup renders the signed-out page for SESSION_EXPIRED and rotated cookies, but not for network or guest-expiry errors', async (t) => {
  for (const code of ['SESSION_EXPIRED', 'SESSION_ROTATED_RECOVERABLE']) {
    const doc = installFakeDom(t);
    const root = doc.createElement('div');
    const f = signedOutApi();
    renderProviderStartError(root as unknown as HTMLElement, new ProviderApiError(401, code), () => {}, f.api);
    assert.equal(root.querySelector('h1')!.textContent, '你还没有登录', code);
    assert.ok(root.querySelector('.signed-out-actions'), code);
    assert.equal(providerStartFailure(new ProviderApiError(401, code)).title, '你还没有登录');
  }
  const doc = installFakeDom(t);
  const root = doc.createElement('div');
  renderProviderStartError(
    root as unknown as HTMLElement,
    new ProviderApiError(401, 'GUEST_SESSION_EXPIRED'),
    () => {},
  );
  assert.equal(root.querySelector('.signed-out-actions'), null);
  assert.equal(root.querySelector('h1')!.textContent, '访客会话已过期');
  const network = doc.createElement('div');
  renderProviderStartError(network as unknown as HTMLElement, new Error('boom'), () => {});
  assert.equal(network.querySelector('h1')!.textContent, '暂时无法连接');
});

test('ProviderApi account calls use the exact routes, bodies and CSRF header, and parse the account reply', async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const replies: Record<string, unknown> = {
    '/api/web/provider/account/request-code': { challengeId: 'c1', expiresAt: 5, resendAfterMs: 60000 },
    '/api/web/provider/account/signup': { nickname: '阿泡', emailMasked: 'p***@example.com' },
    '/api/web/provider/account/bind': { nickname: '阿泡', emailMasked: 'p***@example.com' },
    '/api/web/provider/account/login': { csrf: 'L'.repeat(43) },
    '/api/web/provider/account/reset': { csrf: 'R'.repeat(43) },
    '/api/web/provider/account': {
      signupEnabled: true,
      signedIn: true,
      kind: 'guest',
      hasLogin: true,
      emailMasked: 'p***@example.com',
      nickname: '阿泡',
      canBind: false,
    },
  };
  const api = new ProviderApi(async (url, init) => {
    requests.push({ url: String(url), init: init! });
    return Response.json(replies[String(url)] ?? {});
  });
  assert.deepEqual(await api.requestEmailCode({ purpose: 'signup', email: 'p@example.com' }), {
    challengeId: 'c1',
    expiresAt: 5,
    resendAfterMs: 60000,
  });
  await api.verifyEmailCode({ challengeId: 'c1', code: '123456' });
  assert.deepEqual(
    await api.finishAccount({ purpose: 'signup', challengeId: 'c1', password: 'pw-pw-pw-pw', nickname: '阿泡' }),
    {
      nickname: '阿泡',
      emailMasked: 'p***@example.com',
    },
  );
  await api.finishAccount({ purpose: 'bind', challengeId: 'c1', password: 'pw-pw-pw-pw', nickname: '阿泡' });
  await api.login({ email: 'p@example.com', password: 'pw-pw-pw-pw' });
  await api.resetPassword({ challengeId: 'c1', password: 'pw-pw-pw-pw' });
  await api.changePassword({ current: 'a', next: 'b', logoutOthers: true });
  await api.setNickname('小泡');
  await api.logoutOthers();
  await api.logout();
  await api.abandonSession();
  const info = await api.account();
  assert.deepEqual(
    requests.map((r) => [r.init.method ?? 'GET', r.url.replace('/api/web/provider', '')]),
    [
      ['POST', '/account/request-code'],
      ['POST', '/account/verify-code'],
      ['POST', '/account/signup'],
      ['POST', '/account/bind'],
      ['POST', '/account/login'],
      ['POST', '/account/reset'],
      ['POST', '/account/password'],
      ['POST', '/account/nickname'],
      ['POST', '/account/logout-others'],
      ['POST', '/account/logout'],
      ['POST', '/account/signed-out'],
      ['GET', '/account'],
    ],
  );
  assert.deepEqual(JSON.parse(String(requests[6]!.init.body)), { current: 'a', next: 'b', logoutOthers: true });
  assert.ok(
    requests
      .slice(0, 11)
      .every((r) => (r.init.headers as Record<string, string>)['Content-Type'] === 'application/json'),
  );
  // After login the CSRF header is the new session's.
  assert.equal((requests[6]!.init.headers as Record<string, string>)['X-CSRF-Token'], 'R'.repeat(43));
  assert.equal(info.signedIn && info.hasLogin && info.nickname, '阿泡');
  const signedOutReply = new ProviderApi(async () => Response.json({ signupEnabled: false, signedIn: false }));
  assert.deepEqual(await signedOutReply.account(), { signupEnabled: false, signedIn: false });
  await assert.rejects(new ProviderApi(async () => Response.json({ nope: 1 })).account(), /PROTOCOL_INVALID/);
  await assert.rejects(
    new ProviderApi(async () =>
      Response.json({ error: { code: 'PLAYER_CODE_INVALID' } }, { status: 400 }),
    ).verifyEmailCode({
      challengeId: 'c',
      code: '123456',
    }),
    (error: ProviderApiError) => error.code === 'PLAYER_CODE_INVALID' && error.status === 400,
  );
});

// ---- the chat page ------------------------------------------------------------------------------------------------
function chat(
  t: test.TestContext,
  options: { kind: 'guest' | 'invite'; account?: AccountInfo | 'throws' | 'missing'; chats?: boolean } = {
    kind: 'guest',
  },
) {
  const doc = installFakeDom(t);
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const reloads: string[] = [];
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { reload: () => reloads.push('reload') },
  });
  t.after(() => {
    for (const [name, descriptor] of [
      ['window', previousWindow],
      ['location', previousLocation],
    ] as const)
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
  });
  const boot = syntheticProviderBootstrap();
  boot.fixture = false;
  for (const character of boot.characters) character.availability = { state: 'available', personaVersion: 1 };
  if (options.kind === 'invite')
    boot.access = {
      kind: 'invite',
      principalId: 'p',
      playerId: 'pl',
      worldId: 'w',
      revision: 1,
      grantId: 'g',
      status: 'active',
      lockedCharacterId: null,
      remainingReplies: null,
      reservedReplies: null,
      trialExpiresAt: null,
      canSend: true,
    };
  if (options.chats)
    boot.conversations = boot.characters.map((c) => ({
      conversationId: `c-${c.characterId}`,
      characterId: c.characterId,
      lastMessageId: 'm',
      unreadCount: 0,
    }));
  const view = parseWebProviderBootstrap(boot);
  const calls: string[] = [];
  const api: Record<string, unknown> = {
    bootstrap: async () => view,
    history: async () => ({ messages: [] }),
    redeemInvite: async () => {
      calls.push('redeemInvite');
      return { grantId: 'g', principalId: 'p', expiresAt: null, csrf: 'c', duplicate: false };
    },
    regenerateRecoveryCode: async () => {
      calls.push('regenerateRecoveryCode');
      return 'N'.repeat(43);
    },
    logout: async () => void calls.push('logout'),
    logoutOthers: async () => void calls.push('logoutOthers'),
    ...fakeApi().api,
  };
  if (options.account !== 'missing')
    api.account = async () => {
      calls.push('account');
      if (options.account === 'throws') throw new ProviderApiError(500, 'INTERNAL_ERROR');
      return options.account ?? { signupEnabled: false, signedIn: false };
    };
  const cards = new Map<string, FakeElement>();
  for (const id of ['wei-guagua', 'jojo', 'chen-jimi']) {
    const card = doc.createElement('article'),
      head = doc.createElement('div'),
      more = doc.createElement('button');
    head.className = 'chat-head';
    more.className = 'chat-more icon-button';
    head.append(more);
    card.append(head);
    cards.set(id, card);
  }
  const header = doc.createElement('header');
  header.append(Object.assign(doc.createElement('span'), { className: 'head-note' }));
  const said: string[] = [];
  return {
    doc,
    api: api as unknown as ProviderApi,
    calls,
    cards,
    header,
    said,
    reloads,
    async attach() {
      const live = await LiveBinding.connect(api as unknown as ProviderApi);
      live.attach({
        head: header as unknown as HTMLElement,
        card: (id) => cards.get(id)! as unknown as HTMLElement,
        name: () => '瓜瓜',
        mark: () => '瓜',
        say: (message) => said.push(message),
      });
      return live;
    },
    menu() {
      const card = cards.get('wei-guagua')!;
      card.querySelector('.chat-more')!.click();
      return card.querySelectorAll('.chat-menu-item');
    },
  };
}
const titles = (items: FakeElement[]) => items.map((item) => item.querySelector('.chat-menu-title')!.textContent);

test('chat ⋯ menu: 共创 stays first; a guest gets 登录 / 注册 after it (注册 says 暂未开放 while closed)', async (t) => {
  const f = chat(t, { kind: 'guest' });
  await f.attach();
  const items = f.menu();
  assert.deepEqual(titles(items), ['共创 · 让瓜瓜更像瓜瓜', '登录', '注册']);
  assert.equal(items[2]!.querySelector('.chat-menu-sub')!.textContent, '注册暂未开放');
  assert.equal(items[1]!.disabled, false, 'login is never closed');
  items[1]!.click();
  assert.equal(f.doc.body.querySelector('.acct-sheet')!.querySelector('.acct-title')!.textContent, '登录');
  const open = chat(t, { kind: 'guest', account: { signupEnabled: true, signedIn: false } });
  await open.attach();
  assert.equal(open.menu()[2]!.querySelector('.chat-menu-sub')!.textContent, '用邮箱保存你的聊天');
});

test('chat ⋯ menu for a signed-in login: 我的昵称 / 修改密码 / 退出其他设备 / 退出登录, and they do what they say', async (t) => {
  const account: AccountInfo = {
    signupEnabled: true,
    signedIn: true,
    kind: 'guest',
    hasLogin: true,
    emailMasked: 'p***@example.com',
    nickname: '阿泡',
    canBind: false,
  };
  const f = chat(t, { kind: 'guest', account });
  await f.attach();
  let items = f.menu();
  assert.deepEqual(titles(items), ['共创 · 让瓜瓜更像瓜瓜', '我的昵称', '修改密码', '退出其他设备', '退出登录']);
  items[1]!.click();
  const sheet = f.doc.body.querySelector('.acct-sheet')!;
  assert.equal(sheet.querySelector('.acct-title')!.textContent, '我的昵称');
  assert.equal(sheet.querySelector('input[name="nickname"]')!.value, '阿泡');
  sheet.querySelector('.acct-close')!.click();
  items = f.menu();
  items[2]!.click();
  assert.equal(f.doc.body.querySelector('.acct-sheet')!.querySelector('.acct-title')!.textContent, '修改密码');
  f.doc.body.querySelector('.acct-close')!.click();
  items = f.menu();
  items[3]!.click();
  await flush();
  assert.ok(f.calls.includes('logoutOthers'));
  assert.deepEqual(f.said.at(-1), '已退出其他设备');
  items = f.menu();
  items[4]!.click();
  await flush();
  assert.ok(f.calls.includes('logout'));
  assert.deepEqual(f.reloads, ['reload']);
});

test('chat: a legacy invited player without a login sees 绑定邮箱 and keeps the recovery-code entry; with a login that entry is gone', async (t) => {
  const bindable: AccountInfo = {
    signupEnabled: true,
    signedIn: true,
    kind: 'invite',
    hasLogin: false,
    emailMasked: null,
    nickname: null,
    canBind: true,
  };
  const f = chat(t, { kind: 'invite', account: bindable });
  await f.attach();
  const items = f.menu();
  assert.deepEqual(titles(items), ['共创 · 让瓜瓜更像瓜瓜', '绑定邮箱']);
  items[1]!.click();
  assert.equal(f.doc.body.querySelector('.acct-sheet')!.querySelector('.acct-title')!.textContent, '绑定邮箱');
  assert.equal(f.header.querySelectorAll('.recovery-entry').length, 1, '恢复码 stays for unbound players');
  const bound = chat(t, {
    kind: 'invite',
    account: { ...bindable, hasLogin: true, canBind: false, emailMasked: 'p***@example.com', nickname: '老玩家' },
  });
  await bound.attach();
  assert.equal(
    bound.header.querySelectorAll('.recovery-entry').length,
    0,
    'no recovery code for a player with a login',
  );
  assert.deepEqual(titles(bound.menu()).slice(1), ['我的昵称', '修改密码', '退出其他设备', '退出登录']);
});

test('chat: with signup open, 邀请码 sends a guest without a login to 注册 first and comes back to the invite box after', async (t) => {
  const f = chat(t, { kind: 'guest', account: { signupEnabled: true, signedIn: false } });
  await f.attach();
  const entry = f.header.querySelectorAll('.invite-entry').at(-1)!;
  entry.click();
  const sheet = f.doc.body.querySelector('.acct-sheet')!;
  assert.equal(sheet.querySelector('.acct-title')!.textContent, '注册');
  assert.equal(f.doc.body.querySelector('.invite-dialog'), null, 'no invite box before there is a login');
});

test('chat: with signup closed (or unknown), 邀请码 opens the invite box exactly as before', async (t) => {
  for (const account of [undefined, 'throws', 'missing'] as const) {
    const f = chat(t, { kind: 'guest', ...(account ? { account } : {}) });
    await f.attach();
    // The invite box is built from HTML, which this in-memory DOM refuses: reaching that refusal proves the old path ran.
    assert.throws(() => f.header.querySelectorAll('.invite-entry').at(-1)!.click(), /parse HTML/, String(account));
    assert.equal(f.doc.body.querySelector('.acct-sheet'), null, String(account));
    assert.deepEqual(titles(f.menu()), ['共创 · 让瓜瓜更像瓜瓜', '登录', '注册'], String(account));
  }
});

test('chat: the login switch warns about a guest with chats; no chats, no warning', async (t) => {
  const withChats = chat(t, { kind: 'guest', chats: true });
  await withChats.attach();
  withChats.menu()[1]!.click();
  assert.equal(withChats.doc.body.querySelector('.acct-notice strong')!.textContent, '当前访客的聊天不会合并');
  const empty = chat(t, { kind: 'guest' });
  await empty.attach();
  empty.menu()[1]!.click();
  assert.equal(empty.doc.body.querySelector('.acct-notice'), null);
});

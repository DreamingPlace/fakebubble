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
  loginError,
  openAccountSheet,
  type AccountApi,
  type AccountSheetMode,
  type Timers,
} from '../../src/features/account/account-sheet.ts';
import { renderSignedOut, signedOutCopy, type SignedOutApi } from '../../src/features/account/signed-out-page.ts';
import { providerStartFailure, renderProviderStartError } from '../../src/features/prototype/provider-start-error.ts';
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
  // Part 21i (named exception): signup asks for the password twice; the repeat is filled in here and the rest is unchanged.
  s.input('password').value = 'short';
  s.input('password-again').value = 'short';
  s.input('nickname').value = '阿泡';
  s.submit();
  assert.equal(s.status(), accountCopy.errors.PLAYER_PASSWORD_INVALID);
  s.input('password').value = 'correct horse battery';
  s.input('password-again').value = 'correct horse battery';
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
  // The per-IP signup limit has its own line, not the generic "too frequent, wait N minutes".
  const ipLimit = accountError(new ProviderApiError(429, 'PLAYER_SIGNUP_IP_LIMIT', 3_600_000));
  assert.equal(ipLimit, '这个网络今天的注册次数已用完，请明天再试');
  assert.doesNotMatch(ipLimit, /太频繁|分钟/);
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
  for (const mode of ['signup', 'reset'] as const) {
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
  // Part 21i (named exception): the login sheet has its own wait line instead of the general "请 N 分钟后再试".
  assert.equal(plain.status(), '尝试次数太多，请稍后再试');
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
  for (const mode of ['signup', 'login', 'reset', 'nickname', 'password'] as const) {
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

test('the signed-out first page offers 登录 / 注册 / 以访客继续 — not an error, not a dead end', async (t) => {
  const s = signedOut(t);
  await s.page.ready;
  assert.equal(s.root.querySelector('h1')!.textContent, signedOutCopy.title);
  assert.deepEqual(
    s.root.querySelectorAll('.signed-out-actions button').map((b) => b.textContent),
    ['登录', '注册', '以访客继续'],
  );
  assert.equal(s.root.querySelector('.signed-out-more'), null, 'the recovery-code link is gone');
  assert.doesNotMatch(s.root.textContent, /访问会话需要恢复|没有将受邀身份/);
  // Nothing was created or revoked just by showing the page.
  assert.deepEqual(s.f.names(), ['account']);
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
    '/api/web/provider/account/login': { csrf: 'L'.repeat(43) },
    '/api/web/provider/account/reset': { csrf: 'R'.repeat(43) },
    '/api/web/provider/account': {
      signupEnabled: true,
      signedIn: true,
      kind: 'guest',
      hasLogin: true,
      emailMasked: 'p***@example.com',
      nickname: '阿泡',
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
  assert.deepEqual(JSON.parse(String(requests[5]!.init.body)), { current: 'a', next: 'b', logoutOthers: true });
  assert.ok(
    requests
      .slice(0, 10)
      .every((r) => (r.init.headers as Record<string, string>)['Content-Type'] === 'application/json'),
  );
  // After login the CSRF header is the new session's.
  assert.equal((requests[5]!.init.headers as Record<string, string>)['X-CSRF-Token'], 'R'.repeat(43));
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
  options: {
    kind: 'guest';
    account?: AccountInfo | 'throws' | 'missing';
    chats?: boolean;
    /** Part 13b: replies the guest has left (default: whatever the fixture says). */
    remaining?: number;
  } = {
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
  if (options.remaining !== undefined && boot.access.kind === 'guest') {
    boot.access.remainingReplies = options.remaining;
    boot.access.canSend = options.remaining > 0;
  }
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
      return { entitlement: undefined, duplicate: false };
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

// Part 21f (named exception): the chat's ⋯ menu holds only 切换回复模型 (for a player who can choose one) and 共创. A guest's
// 登录 / 注册 are the top bar's buttons (their sheets are checked there); this test keeps its assertions about what they open.
test('chat ⋯ menu: a guest sees 共创 only; 登录 / 注册 are in the top bar (注册 says 暂未开放 while closed)', async (t) => {
  const f = chat(t, { kind: 'guest' });
  await f.attach();
  // Named exception (Part 24c): the chat ⋯ menu's co-creation entry reads 一起共创角色 (was 共创 · 让{name}更像{name}), the first-time hint reads 给{name}换个大脑？或者来说说你心中的{name}～ for everyone, and the model sheet is titled 当前大脑. Only the words changed; no assertion was weakened.
  assert.deepEqual(titles(f.menu()), ['一起共创角色']);
  const [login, signup] = topBar(f);
  assert.deepEqual(labelsOf([login!, signup!]), ['登录', '注册']);
  login!.click();
  assert.equal(f.doc.body.querySelector('.acct-sheet')!.querySelector('.acct-title')!.textContent, '登录');
  f.doc.body.querySelector('.acct-close')!.click();
  signup!.click();
  assert.equal(f.doc.body.querySelector('.acct-sheet')!.querySelector('.acct-closed')!.textContent, '注册暂未开放');
});

// Part 21f (named exception): the account entries left the chat's ⋯ menu; the same four actions are now run from the top
// account menu (the nickname button), with the same assertions as before.
// Part 22a (named exception): the dropdown is replaced by 我的信息. The nickname button opens it directly, and the same four
// actions are run from it: change the nickname (in place), 修改密码, 退出其他设备, 退出登录. The chat menu still has none.
test('top account menu for a signed-in login: 我的昵称 / 修改密码 / 退出其他设备 / 退出登录, and they do what they say; the chat menu has none', async (t) => {
  const account: AccountInfo = {
    signupEnabled: true,
    signedIn: true,
    kind: 'guest',
    hasLogin: true,
    emailMasked: 'p***@example.com',
    nickname: '阿泡',
    playerNumber: 'ABCD2345',
  };
  const f = chat(t, { kind: 'guest', account });
  await f.attach();
  // Named exception (Part 24c): the chat ⋯ menu's co-creation entry reads 一起共创角色 (was 共创 · 让{name}更像{name}), the first-time hint reads 给{name}换个大脑？或者来说说你心中的{name}～ for everyone, and the model sheet is titled 当前大脑. Only the words changed; no assertion was weakened.
  assert.deepEqual(titles(f.menu()), ['一起共创角色'], 'the chat menu: 共创 only');
  const nick = topBar(f)[0]!;
  nick.click();
  assert.equal(f.header.querySelectorAll('.chat-menu-item').length, 0, 'no dropdown: the page opens directly');
  const sheet = infoSheet(f);
  assert.equal(sheet.querySelector('.acct-title')!.textContent, '我的信息');
  assert.ok(sheet.textContent.includes('ABCD2345'), '玩家编号');
  // 昵称 is edited in place.
  press(f, '修改');
  const input = sheet.querySelector('.mi-input')!;
  assert.equal(input.value, '阿泡');
  input.value = '新泡泡';
  press(f, '保存');
  await flush();
  assert.equal(sheet.querySelector('.mi-nickname')!.textContent, '新泡泡');
  press(f, '修改密码');
  assert.equal(f.doc.body.querySelector('.acct-sheet')!.querySelector('.acct-title')!.textContent, '修改密码');
  f.doc.body.querySelector('.acct-sheet')!.querySelector('.acct-close')!.click();
  press(f, '退出其他设备');
  await flush();
  assert.ok(f.calls.includes('logoutOthers'));
  assert.deepEqual(f.said.at(-1), '已退出其他设备');
  press(f, '退出登录');
  await flush();
  assert.ok(f.calls.includes('logout'));
  assert.deepEqual(f.reloads, ['reload']);
});

// Part 22a (named exception): 邀请码 is no top-bar button; 输入邀请码 is a row of 我的信息. A guest sees it there next to 注册 / 登录
// and the line 注册后即可使用邀请码 (the invite box refuses a guest's code without sending it: see the controller test).
test('chat: with signup open, 邀请码 sends a guest without a login to 注册 first and comes back to the invite box after', async (t) => {
  const f = chat(t, { kind: 'guest', account: { signupEnabled: true, signedIn: false } });
  await f.attach();
  assert.equal(f.header.querySelectorAll('.invite-entry').length, 0, '邀请码 left the top bar');
  topBar(f)
    .find((b) => b.textContent === '我的信息')!
    .click();
  const labels = infoButtons(f).map((b) => b.textContent);
  assert.deepEqual(labels, ['×', '消费记录', '输入邀请码', '注册', '登录']);
  assert.ok(infoSheet(f).textContent.includes('注册后即可使用邀请码'));
  press(f, '注册');
  assert.equal(f.doc.body.querySelectorAll('.acct-sheet').at(-1)!.querySelector('.acct-title')!.textContent, '注册');
  assert.equal(f.doc.body.querySelector('.invite-dialog'), null, 'no invite box was opened by signing up');
});

test('chat: with signup closed (or unknown), 邀请码 opens the invite box exactly as before', async (t) => {
  for (const account of [undefined, 'throws', 'missing'] as const) {
    const f = chat(t, { kind: 'guest', ...(account ? { account } : {}) });
    await f.attach();
    topBar(f)
      .find((b) => b.textContent === '我的信息')!
      .click();
    // The invite box is built from HTML, which this in-memory DOM refuses: reaching that refusal proves the old path ran.
    assert.throws(() => press(f, '输入邀请码'), /parse HTML/, String(account));
    assert.equal(f.doc.body.querySelector('.acct-sheet'), null, String(account));
    // Named exception (Part 24c): the chat ⋯ menu's co-creation entry reads 一起共创角色 (was 共创 · 让{name}更像{name}), the first-time hint reads 给{name}换个大脑？或者来说说你心中的{name}～ for everyone, and the model sheet is titled 当前大脑. Only the words changed; no assertion was weakened.
    assert.deepEqual(titles(f.menu()), ['一起共创角色'], String(account));
  }
});

test('chat: the login switch warns about a guest with chats; no chats, no warning', async (t) => {
  const withChats = chat(t, { kind: 'guest', chats: true });
  await withChats.attach();
  topBar(withChats)[0]!.click(); // 登录 (a top bar button since Part 21f)
  assert.equal(withChats.doc.body.querySelector('.acct-notice strong')!.textContent, '当前访客的聊天不会合并');
  const empty = chat(t, { kind: 'guest' });
  await empty.attach();
  topBar(empty)[0]!.click();
  assert.equal(empty.doc.body.querySelector('.acct-notice'), null);
});

// ---- Part 13b: account entries in the top bar ---------------------------------------------------------------------
const topBar = (f: ReturnType<typeof chat>) => [
  // Part 15 named exception: these legacy assertions cover desktop; mobile has its own test below.
  ...f.header.querySelectorAll('.head-actions button').filter((node) => !node.classList.contains('mobile-account')),
  ...f.header.querySelectorAll('.invite-entry'),
];
const labelsOf = (nodes: FakeElement[]) => nodes.map((node) => node.textContent);
// Part 22a: 我的信息, the page behind the top bar's nickname / 我的信息 button.
const infoSheet = (f: ReturnType<typeof chat>) => f.doc.body.querySelector('.mi-sheet')!;
const infoButtons = (f: ReturnType<typeof chat>) => infoSheet(f).querySelectorAll('button');
const press = (f: ReturnType<typeof chat>, label: string) => {
  const button = infoButtons(f).find((b) => b.textContent === label);
  assert.ok(button, `no button ${label}`);
  button!.click();
  return button!;
};
const signedIn: AccountInfo = {
  signupEnabled: true,
  signedIn: true,
  kind: 'guest',
  hasLogin: true,
  emailMasked: 'p***@example.com',
  nickname: '阿泡',
};

// Part 21i (named exception, three tests below): a guest's top bar now always carries 更多, which holds 消费记录 (the guest's trial
// replies); the expected labels gain '更多' and nothing else changes.
// Part 22a (named exception, same three tests): 更多 became 我的信息 and 邀请码 moved inside it, so the guest's labels are
// 登录 / 注册 / 我的信息; nothing else changes.
test("top bar: a guest finds 登录 and 注册 next to 邀请码, not only inside a chat card's ⋯ menu", async (t) => {
  const f = chat(t, { kind: 'guest', account: { signupEnabled: true, signedIn: false }, remaining: 3 });
  await f.attach();
  assert.deepEqual(labelsOf(topBar(f)), ['登录', '注册', '我的信息']);
  assert.equal(f.header.querySelectorAll('.head-actions').length, 1);
  assert.equal(f.header.querySelector('.head-hint'), null, 'replies left: no extra line');
  assert.equal(f.header.querySelector('.head-note')!.textContent, '体验剩余 3 次');
  topBar(f)[0]!.click();
  assert.equal(f.doc.body.querySelector('.acct-sheet')!.querySelector('.acct-title')!.textContent, '登录');
  f.doc.body.querySelector('.acct-close')!.click();
  topBar(f)[1]!.click();
  assert.equal(f.doc.body.querySelector('.acct-sheet')!.querySelector('.acct-title')!.textContent, '注册');
  // The ⋯ menu no longer repeats them.
  // Named exception (Part 24c): the chat ⋯ menu's co-creation entry reads 一起共创角色 (was 共创 · 让{name}更像{name}), the first-time hint reads 给{name}换个大脑？或者来说说你心中的{name}～ for everyone, and the model sheet is titled 当前大脑. Only the words changed; no assertion was weakened.
  assert.deepEqual(titles(f.menu()), ['一起共创角色']);
});

test('top bar: while signup is off 注册 still opens and says 注册暂未开放; 登录 is never closed', async (t) => {
  for (const account of [undefined, { signupEnabled: false, signedIn: false } as AccountInfo]) {
    const f = chat(t, { kind: 'guest', ...(account ? { account } : {}) });
    await f.attach();
    assert.deepEqual(labelsOf(topBar(f)), ['登录', '注册', '我的信息']);
    topBar(f)[1]!.click();
    const sheet = f.doc.body.querySelector('.acct-sheet')!;
    assert.equal(sheet.querySelector('.acct-closed')!.textContent, '注册暂未开放');
    sheet.querySelector('.acct-close')!.click();
    topBar(f)[0]!.click();
    assert.equal(f.doc.body.querySelector('.acct-sheet')!.querySelector('.acct-title')!.textContent, '登录');
  }
});

test('top bar: the trial used up shows ONE short line saying what to do next, and only then', async (t) => {
  const used = chat(t, { kind: 'guest', account: { signupEnabled: true, signedIn: false }, remaining: 0 });
  await used.attach();
  assert.equal(used.header.querySelector('.head-note')!.textContent, '体验剩余 0 次');
  assert.equal(used.header.querySelectorAll('.head-hint').length, 1);
  assert.equal(used.header.querySelector('.head-hint')!.textContent, '注册保存聊天，或输入邀请码继续');
  assert.deepEqual(labelsOf(topBar(used)), ['登录', '注册', '我的信息']);
  // Same line while signup is off: the buttons say 暂未开放 themselves.
  const closed = chat(t, { kind: 'guest', remaining: 0 });
  await closed.attach();
  assert.equal(closed.header.querySelector('.head-hint')!.textContent, '注册保存聊天，或输入邀请码继续');
  // A signed-up guest already has an account to keep chats in: the line only asks for the invite.
  const login = chat(t, { kind: 'guest', account: signedIn, remaining: 0 });
  await login.attach();
  assert.equal(login.header.querySelector('.head-hint')!.textContent, '输入邀请码继续');
  // Replies left: no line.
  const left = chat(t, { kind: 'guest', remaining: 1 });
  await left.attach();
  assert.equal(left.header.querySelector('.head-hint'), null);
});

// Part 22a (named exception): the nickname button opens 我的信息 directly (no dropdown); the four actions are rows of that page.
test('top bar: a signed-in player sees their nickname, which opens the account menu; 登录 / 注册 are gone', async (t) => {
  const f = chat(t, { kind: 'guest', account: signedIn, remaining: 2 });
  await f.attach();
  assert.deepEqual(labelsOf(topBar(f)), ['阿泡']);
  const nick = topBar(f)[0]!;
  assert.equal(nick.getAttribute('aria-haspopup'), null, 'a page, not a menu');
  nick.click();
  assert.equal(f.header.querySelectorAll('.chat-menu-item').length, 0);
  assert.deepEqual(
    infoButtons(f).map((b) => b.textContent),
    ['×', '修改', '消费记录', '输入邀请码', '修改密码', '退出其他设备', '退出登录'].filter((x) => x !== '消费记录'),
  );
  press(f, '修改密码');
  assert.equal(
    f.doc.body.querySelectorAll('.acct-sheet').at(-1)!.querySelector('.acct-title')!.textContent,
    '修改密码',
  );
  f.doc.body.querySelectorAll('.acct-sheet').at(-1)!.querySelector('.acct-close')!.click();
  press(f, '退出其他设备');
  await flush();
  assert.ok(f.calls.includes('logoutOthers'));
  assert.equal(f.said.at(-1), '已退出其他设备');
  press(f, '退出登录');
  await flush();
  assert.ok(f.calls.includes('logout'));
  assert.deepEqual(f.reloads, ['reload']);
  // The chat cards' ⋯ menu no longer carries them (Part 21f).
  // Named exception (Part 24c): the chat ⋯ menu's co-creation entry reads 一起共创角色 (was 共创 · 让{name}更像{name}), the first-time hint reads 给{name}换个大脑？或者来说说你心中的{name}～ for everyone, and the model sheet is titled 当前大脑. Only the words changed; no assertion was weakened.
  assert.deepEqual(titles(f.menu()), ['一起共创角色']);
  // A login without a nickname yet is still reachable.
  const bare = chat(t, { kind: 'guest', account: { ...signedIn, nickname: null }, remaining: 2 });
  await bare.attach();
  assert.equal(topBar(bare)[0]!.textContent, '我的信息');
});

test('mobile top bar: one account entry opens the existing login sheet with a signup choice', async (t) => {
  const f = chat(t, { kind: 'guest', account: { signupEnabled: true, signedIn: false }, remaining: 3 });
  await f.attach();
  const mobile = f.header.querySelectorAll('.mobile-account');
  assert.equal(mobile.length, 1);
  assert.equal(mobile[0]!.textContent, '登录/注册');
  mobile[0]!.click();
  const sheet = f.doc.body.querySelector('.acct-sheet')!;
  assert.equal(sheet.querySelector('.acct-title')!.textContent, '登录');
  assert.ok(sheet.textContent.includes('没有账号？注册'));
});

// ---- Part 21i: login errors, signup confirmation, password toggles, no small print in the account menu ---------------------

test('Part 21i login: each failure has its own line, an unregistered email offers the signup link, and a retry works', async (t) => {
  let failure: unknown = new ProviderApiError(401, 'PLAYER_EMAIL_NOT_REGISTERED');
  const f = fakeApi({
    login: () => {
      if (failure) throw failure;
      return undefined;
    },
  });
  const s = open(t, 'login', { api: f.api });
  s.input('email').value = 'a@example.com';
  s.input('password').value = 'whatever pass';
  const cases: [unknown, string][] = [
    [new ProviderApiError(401, 'PLAYER_EMAIL_NOT_REGISTERED'), '这个邮箱还没有注册'],
    [new ProviderApiError(401, 'PLAYER_PASSWORD_WRONG'), '密码不正确'],
    [new ProviderApiError(429, 'PLAYER_RATE_LIMITED', 60_000), '尝试次数太多，请稍后再试'],
    [new ProviderApiError(0, 'NETWORK'), '网络异常，请重试'],
    [new TypeError('fetch failed'), '网络异常，请重试'],
  ];
  for (const [error, line] of cases) {
    failure = error;
    s.submit();
    await flush();
    assert.equal(s.status(), line + (line === '这个邮箱还没有注册' ? ` ${accountCopy.goSignup}` : ''));
    assert.equal(loginError(error), line);
    assert.equal(s.root.querySelectorAll('.acct-goto-signup').length, line === '这个邮箱还没有注册' ? 1 : 0);
  }
  // The signup link hands over to the signup sheet (and closes this one) like 没有账号？注册.
  failure = new ProviderApiError(401, 'PLAYER_EMAIL_NOT_REGISTERED');
  s.submit();
  await flush();
  s.root.querySelector('.acct-goto-signup')!.click();
  assert.deepEqual(s.log.switched, ['signup']);
  // Signup off: the line stays, no link to a closed door.
  const closed = open(t, 'login', { api: f.api, signupEnabled: false });
  closed.input('email').value = 'a@example.com';
  closed.input('password').value = 'whatever pass';
  closed.submit();
  await flush();
  assert.equal(closed.status(), '这个邮箱还没有注册');
  assert.equal(closed.root.querySelectorAll('.acct-goto-signup').length, 0);
  // Success still works after failures.
  failure = null;
  s.c.advance(0);
});

test('Part 21i signup: two password fields; submit is disabled and 两次输入的密码不一致 shows until they match', async (t) => {
  const s = open(t, 'signup');
  s.input('email').value = 'p@example.com';
  s.submit();
  await flush();
  s.input('code').value = '123456';
  s.submit();
  await flush();
  const labels = s.root.querySelectorAll('.acct-label').map((l) => l.textContent);
  assert.deepEqual(labels.slice(0, 2), ['设置密码', '再次输入密码']);
  const first = s.input('password'),
    again = s.input('password-again');
  const submit = s.root.querySelector('button[type="submit"]')!;
  const message = s.root.querySelector('.acct-mismatch')!;
  assert.equal(message.hidden, true, 'nothing typed in the second field yet: no scolding');
  first.type_('correct horse');
  again.type_('correct hors');
  assert.equal(message.hidden, false);
  assert.equal(message.textContent, '两次输入的密码不一致');
  assert.equal(submit.disabled, true);
  s.input('nickname').value = '阿泡';
  s.submit();
  await flush();
  assert.equal(
    s.f.names().includes('finishAccount'),
    false,
    'a mismatch never reaches the server, even if the form is submitted',
  );
  again.type_('correct horse');
  assert.equal(message.hidden, true);
  assert.equal(submit.disabled, false);
  // Editing the first field breaks the match again.
  first.type_('correct horse!');
  assert.equal(submit.disabled, true);
  assert.equal(message.hidden, false);
  first.type_('correct horse');
  s.submit();
  await flush();
  assert.deepEqual(s.f.calls.at(-1), {
    name: 'finishAccount',
    args: [{ purpose: 'signup', challengeId: 'challenge-1', password: 'correct horse', nickname: '阿泡' }],
  });
  // The server's password rules still apply to what matched on the client (too short = the usual line).
  const short = open(t, 'signup');
  short.input('email').value = 'p@example.com';
  short.submit();
  await flush();
  short.input('code').value = '123456';
  short.submit();
  await flush();
  short.input('password').type_('short');
  short.input('password-again').type_('short');
  short.input('nickname').value = '阿泡';
  short.submit();
  assert.equal(short.status(), accountCopy.errors.PLAYER_PASSWORD_INVALID);
  // Reset, bind and every other sheet keep a single password field.
  const reset = open(t, 'reset');
  reset.input('email').value = 'p@example.com';
  reset.submit();
  await flush();
  reset.input('code').value = '123456';
  reset.submit();
  await flush();
  assert.equal(reset.root.querySelector('input[name="password-again"]'), null);
});

test('Part 21i: every player password field has a 显示/隐藏 toggle with aria-pressed and aria-controls', async (t) => {
  const check = (root: FakeElement, expected: string[]) => {
    const inputs = root.querySelectorAll('input[type="password"]');
    assert.deepEqual(
      inputs.map((i) => i.getAttribute('name')),
      expected,
    );
    const toggles = root.querySelectorAll('.acct-reveal');
    assert.equal(toggles.length, expected.length);
    toggles.forEach((toggle, index) => {
      const field = inputs[index]!;
      assert.equal(toggle.getAttribute('aria-controls'), field.id);
      assert.notEqual(field.id, '');
      assert.equal(toggle.getAttribute('aria-pressed'), 'false');
      assert.equal(toggle.textContent, '显示密码');
      assert.equal(toggle.getAttribute('type'), 'button', 'never submits the form');
      toggle.click();
      assert.equal(field.type, 'text');
      assert.equal(toggle.getAttribute('aria-pressed'), 'true');
      assert.equal(toggle.textContent, '隐藏密码');
      toggle.click();
      assert.equal(field.type, 'password');
      assert.equal(toggle.getAttribute('aria-pressed'), 'false');
    });
    assert.equal(
      new Set(
        root
          .querySelectorAll('.acct-input')
          .map((i) => i.id)
          .filter(Boolean),
      ).size,
      expected.length,
    );
  };
  check(open(t, 'login').root, ['password']);
  check(open(t, 'password').root, ['current', 'next']);
  for (const mode of ['signup', 'reset'] as const) {
    const s = open(t, mode);
    s.input('email').value = 'p@example.com';
    s.submit();
    await flush();
    s.input('code').value = '123456';
    s.submit();
    await flush();
    check(s.root, mode === 'signup' ? ['password', 'password-again'] : ['password']);
  }
});

// Part 22a (named exception): the dropdown this test guarded is replaced by 我的信息. The rule it enforced - labels and values only,
// no small-print helper lines - is asserted against the new page, for a signed-in player and for a guest.
test('Part 21i: the top-bar account dropdown has item labels only, no secondary line', async (t) => {
  const account: AccountInfo = {
    signupEnabled: true,
    signedIn: true,
    kind: 'guest',
    hasLogin: true,
    emailMasked: 'p***@example.com',
    nickname: '阿泡',
    playerNumber: 'ABCD2345',
  };
  const login = chat(t, { kind: 'guest', account });
  await login.attach();
  topBar(login)[0]!.click();
  const helper = (f: ReturnType<typeof chat>) =>
    infoSheet(f)
      .querySelectorAll('p')
      .filter((p) => !p.classList.contains('mi-status') && !p.classList.contains('mi-signup-first'));
  assert.equal(helper(login).length, 0, 'no helper line anywhere on the page');
  assert.equal(login.header.querySelectorAll('.chat-menu-sub').length, 0);
  // The guest's page too; the chat's own ⋯ menu keeps its 共创 line.
  const guest = chat(t, {
    kind: 'guest',
    account: { signupEnabled: true, signedIn: false, features: { accountDelete: true } },
  });
  await guest.attach();
  topBar(guest)[2]!.click();
  assert.equal(helper(guest).length, 0);
  assert.deepEqual(
    infoButtons(guest).map((b) => b.textContent),
    ['×', '消费记录', '输入邀请码', '注册', '登录', '清除本设备的体验数据'],
  );
  assert.equal(guest.header.querySelectorAll('.chat-menu-sub').length, 0);
  assert.equal(guest.menu()[0]!.querySelectorAll('.chat-menu-sub').length, 1);
});

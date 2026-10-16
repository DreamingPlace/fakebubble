import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveBinding } from '../../src/features/prototype/provider-binding.ts';
import { appendLegalLinks, footerNote } from '../../src/features/prototype/legal-links.ts';
import { ProviderApi, ProviderApiError, type AccountInfo, type HumanCheck } from '../../src/services/provider-api.ts';
import {
  accountCopy,
  openAccountSheet,
  type AccountApi,
  type AccountSheetMode,
} from '../../src/features/account/account-sheet.ts';
import { renderSignedOut, signedOutCopy, type SignedOutApi } from '../../src/features/account/signed-out-page.ts';
import { providerStartFailure, renderProviderStartError } from '../../src/features/prototype/provider-start-error.ts';
import { syntheticProviderBootstrap, parseWebProviderBootstrap } from '../../../../packages/contracts/web-provider.ts';
import { FakeElement, flush, installFakeDom } from './fake-dom.ts';

const noTimers = { now: () => 0, setInterval: () => 0, clearInterval: () => {} };

// ---- ProviderApi: account info, deletion route, Turnstile -------------------------------------------------------------

test('GET /account: the Part 17 features and the grace line are parsed, and absent when the server sends none', async () => {
  const signedIn = {
    signupEnabled: true,
    signedIn: true,
    kind: 'guest',
    hasLogin: false,
    emailMasked: null,
    nickname: null,
    canBind: false,
  };
  const plain = await new ProviderApi(async () => Response.json(signedIn)).account();
  assert.deepEqual(plain, { ...signedIn });
  assert.equal(Object.hasOwn(plain, 'features'), false);
  const full = await new ProviderApi(async () =>
    Response.json({
      ...signedIn,
      features: { accountDelete: true, legal: true, grace: true, turnstileSiteKey: '0x4AAAAAAA', junk: 1 },
      grace: { endsAt: 1_800_000_000_000 },
    }),
  ).account();
  assert.deepEqual(full.signedIn && full.features, {
    accountDelete: true,
    legal: true,
    grace: true,
    turnstileSiteKey: '0x4AAAAAAA',
  });
  assert.deepEqual(full.signedIn && full.grace, { endsAt: 1_800_000_000_000 });
  // A site key that is not a plain token is ignored, not trusted.
  const bad = await new ProviderApi(async () =>
    Response.json({ signupEnabled: true, signedIn: false, features: { turnstileSiteKey: '<script>' } }),
  ).account();
  assert.deepEqual(bad, { signupEnabled: true, signedIn: false });
});

test('deleteAccount posts the password and the typed word, and forgets the CSRF token', async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const api = new ProviderApi(async (url, init) => {
    requests.push({ url: String(url), init: init! });
    return Response.json(
      String(url).endsWith('/bootstrap')
        ? { ...syntheticProviderBootstrap(), csrf: 'C'.repeat(43) }
        : { deleted: true, complete: true },
    );
  });
  await api.bootstrap();
  await api.deleteAccount({ password: 'pw-pw-pw-pw', confirm: '删除' });
  assert.equal(requests[1]!.url, '/api/web/provider/account/delete');
  assert.deepEqual(JSON.parse(String(requests[1]!.init.body)), { password: 'pw-pw-pw-pw', confirm: '删除' });
  assert.equal((requests[1]!.init.headers as Record<string, string>)['X-CSRF-Token'], 'C'.repeat(43));
  await assert.rejects(
    new ProviderApi(async () => Response.json({ nope: 1 })).deleteAccount({ password: '', confirm: '清除' }),
    /PROTOCOL_INVALID/,
  );
});

function turnstileFetcher(sequence: Record<string, Response[]>) {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    const path = String(url).replace('/api/web/provider', '');
    seen.push({ url: path, headers: init.headers as Record<string, string> });
    const next = sequence[path]?.shift();
    return next ?? Response.json({ error: { code: 'INTERNAL_ERROR' } }, { status: 500 });
  }) as unknown as typeof fetch;
  return { fetcher, seen };
}
const required = () => Response.json({ error: { code: 'TURNSTILE_REQUIRED' } }, { status: 403 });
const siteInfo = () =>
  Response.json({ signupEnabled: true, signedIn: false, features: { turnstileSiteKey: '0x4AAAAAAA' } });

test('Turnstile: the page repeats the SAME request once with a fresh token; nothing else carries the header', async () => {
  const boot = { ...syntheticProviderBootstrap(), csrf: 'C'.repeat(43) };
  const { fetcher, seen } = turnstileFetcher({
    '/bootstrap': [required(), Response.json(boot)],
    '/account': [siteInfo()],
    '/account/login': [required(), Response.json({ csrf: 'L'.repeat(43) })],
    '/account/request-code': [required(), Response.json({ challengeId: 'c1', expiresAt: 5, resendAfterMs: 60000 })],
  });
  const asked: [string, string][] = [];
  const api = new ProviderApi(fetcher);
  api.setHumanCheck(async (siteKey, action) => {
    asked.push([siteKey, action]);
    return `token-${action}`;
  });
  await api.bootstrap();
  await api.login({ email: 'p@example.com', password: 'pw-pw-pw-pw' });
  await api.requestEmailCode({ purpose: 'signup', email: 'p@example.com' });
  assert.deepEqual(asked, [
    ['0x4AAAAAAA', 'guest'],
    ['0x4AAAAAAA', 'login'],
    ['0x4AAAAAAA', 'code'],
  ]);
  // First try without the header, the retry with it - and only that one carries it.
  assert.deepEqual(
    seen.filter((s) => s.url !== '/account').map((s) => [s.url, s.headers['X-Turnstile-Token'] ?? null]),
    [
      ['/bootstrap', null],
      ['/bootstrap', 'token-guest'],
      ['/account/login', null],
      ['/account/login', 'token-login'],
      ['/account/request-code', null],
      ['/account/request-code', 'token-code'],
    ],
  );
});

test('Turnstile: no widget, no site key, a widget failure or a second refusal all end in a short, fixed error - never a loop', async () => {
  const cases: [string, ReturnType<typeof turnstileFetcher>, HumanCheck | null, string][] = [
    [
      'without a widget the original error stays',
      turnstileFetcher({ '/bootstrap': [required()] }),
      null,
      'TURNSTILE_REQUIRED',
    ],
    [
      'a server that names no site key',
      turnstileFetcher({
        '/bootstrap': [required()],
        '/account': [Response.json({ signupEnabled: true, signedIn: false })],
      }),
      async () => 'x',
      'TURNSTILE_REQUIRED',
    ],
    [
      'the widget cannot load',
      turnstileFetcher({ '/bootstrap': [required()], '/account': [siteInfo()] }),
      async () => {
        throw new Error('blocked');
      },
      'TURNSTILE_FAILED',
    ],
    [
      'the server refuses the fresh token too',
      turnstileFetcher({
        '/bootstrap': [required(), Response.json({ error: { code: 'TURNSTILE_FAILED' } }, { status: 403 })],
        '/account': [siteInfo()],
      }),
      async () => 'bad',
      'TURNSTILE_FAILED',
    ],
  ];
  for (const [name, { fetcher, seen }, check, code] of cases) {
    const api = new ProviderApi(fetcher);
    api.setHumanCheck(check);
    await assert.rejects(api.bootstrap(), (error: ProviderApiError) => error.code === code, name);
    assert.ok(seen.filter((s) => s.url === '/bootstrap').length <= 2, `${name}: at most one retry`);
  }
  // A request that never needed a token is untouched: same headers as before Part 17.
  const { fetcher, seen } = turnstileFetcher({
    '/account': [Response.json({ signupEnabled: false, signedIn: false })],
  });
  await new ProviderApi(fetcher).account();
  assert.deepEqual(seen[0]!.headers, {});
});

test('the start screen turns a failed human check into a short retry, not a dead end', () => {
  for (const code of ['TURNSTILE_FAILED', 'TURNSTILE_REQUIRED'])
    assert.deepEqual(providerStartFailure(new ProviderApiError(403, code)), {
      title: '人机验证没通过',
      detail: '请再试一次。没有创建任何聊天，也没有发送消息。',
      action: '重试',
    });
  assert.equal(providerStartFailure(new ProviderApiError(503, 'TURNSTILE_UNAVAILABLE')).title, '验证服务暂时不可用');
});

// ---- the sheets ---------------------------------------------------------------------------------------------------------

function sheet(
  t: test.TestContext,
  mode: AccountSheetMode,
  extra: Partial<Parameters<typeof openAccountSheet>[0]> = {},
) {
  const doc = installFakeDom(t);
  const calls: [string, unknown][] = [];
  const api = {
    requestEmailCode: async (input: unknown) => (
      calls.push(['requestEmailCode', input]), { challengeId: 'c', expiresAt: 1, resendAfterMs: 60000 }
    ),
    deleteAccount: async (input: unknown) => void calls.push(['deleteAccount', input]),
  } as unknown as AccountApi;
  const done: string[] = [];
  const opened = openAccountSheet({
    api,
    mode,
    mount: doc.body as unknown as HTMLElement,
    timers: noTimers,
    doneMs: 0,
    signupEnabled: true,
    onDone: (m) => done.push(m),
    ...extra,
  });
  const root = opened.element as unknown as FakeElement;
  return {
    doc,
    root,
    calls,
    done,
    input: (name: string) => root.querySelector(`input[name="${name}"]`)!,
    status: () => root.querySelector('.acct-status')!.textContent,
    submit: () => root.querySelector('form')!.dispatch('submit'),
  };
}

test('signup: the consent line with both links appears only when the legal pages are published', (t) => {
  const on = sheet(t, 'signup', { legal: true });
  const line = on.root.querySelector('.acct-legal')!;
  assert.equal(line.textContent, '注册即表示你同意《用户协议》和《隐私政策》');
  assert.deepEqual(
    line.querySelectorAll('a').map((a) => [a.getAttribute('href'), a.getAttribute('target'), a.getAttribute('rel')]),
    [
      ['/terms.html', '_blank', 'noopener'],
      ['/privacy.html', '_blank', 'noopener'],
    ],
  );
  assert.equal(sheet(t, 'signup').root.querySelector('.acct-legal'), null);
  assert.equal(sheet(t, 'signup', { legal: false }).root.querySelector('.acct-legal'), null);
  // The sign-in and reset sheets do not carry it: it is the signup screen's line.
  assert.equal(sheet(t, 'login', { legal: true }).root.querySelector('.acct-legal'), null);
  assert.equal(sheet(t, 'reset', { legal: true }).root.querySelector('.acct-legal'), null);
});

test('signup after the grace period names that the earlier trial chats expired', (t) => {
  const s = sheet(t, 'signup', { notice: signedOutCopy.expired });
  assert.equal(s.root.querySelector('.acct-expired')!.textContent, '之前的体验聊天已过期');
  assert.equal(sheet(t, 'signup').root.querySelector('.acct-expired'), null);
});

test('删除我的账号: password and the typed word 删除 are both required; success shows the final confirmation', async (t) => {
  const s = sheet(t, 'delete');
  assert.equal(s.root.querySelector('.acct-title')!.textContent, '删除我的账号');
  assert.match(s.root.querySelector('.acct-warning')!.textContent, /永久删除.*无法恢复/);
  s.input('password').value = 'pw-pw-pw-pw';
  s.input('confirm').value = '删';
  s.submit();
  assert.equal(s.status(), accountCopy.errors.ACCOUNT_DELETE_CONFIRM_INVALID);
  s.input('password').value = 'short';
  s.input('confirm').value = '删除';
  s.submit();
  assert.equal(s.status(), accountCopy.errors.PLAYER_LOGIN_INVALID);
  assert.deepEqual(s.calls, [], 'nothing is sent until both fields are right');
  s.input('password').value = 'pw-pw-pw-pw';
  s.input('confirm').value = ' 删除 ';
  s.submit();
  await flush();
  assert.deepEqual(s.calls, [['deleteAccount', { password: 'pw-pw-pw-pw', confirm: '删除' }]]);
  assert.equal(s.root.querySelector('.acct-done')!.textContent, '账号和聊天数据已删除。谢谢你来过。');
  assert.deepEqual(s.done, ['delete']);
  assert.equal(s.input('password')?.value ?? '', '', 'the password does not stay in the page');
});

test('删除 failures keep the sheet and show a fixed line', async (t) => {
  const doc = installFakeDom(t);
  const api = {
    deleteAccount: async () => {
      throw new ProviderApiError(401, 'PLAYER_LOGIN_INVALID');
    },
  } as unknown as AccountApi;
  const opened = openAccountSheet({
    api,
    mode: 'delete',
    mount: doc.body as unknown as HTMLElement,
    timers: noTimers,
    doneMs: 0,
  });
  const root = opened.element as unknown as FakeElement;
  root.querySelector('input[name="password"]')!.value = 'pw-pw-pw-pw';
  root.querySelector('input[name="confirm"]')!.value = '删除';
  root.querySelector('form')!.dispatch('submit');
  await flush();
  assert.equal(root.querySelector('.acct-status')!.textContent, '邮箱或密码不正确');
  assert.ok(root.querySelector('form'), 'the form is still there');
});

test('清除本设备的体验数据: a guest confirms with a button, no password, and the word 清除 goes along', async (t) => {
  const s = sheet(t, 'clear');
  assert.equal(s.root.querySelector('.acct-title')!.textContent, '清除本设备的体验数据');
  assert.equal(s.root.querySelector('input[name="password"]'), null);
  s.submit();
  await flush();
  assert.deepEqual(s.calls, [['deleteAccount', { password: '', confirm: '清除' }]]);
  assert.deepEqual(s.done, ['clear']);
});

// ---- the signed-out page --------------------------------------------------------------------------------------------------

function signedOutPage(t: test.TestContext, info: AccountInfo, options: { expired?: boolean; erased?: string } = {}) {
  const doc = installFakeDom(t);
  const root = doc.createElement('div');
  const calls: string[] = [];
  const api = {
    requestEmailCode: async () => ({ challengeId: 'c', expiresAt: 1, resendAfterMs: 60000 }),
    account: async () => info,
    bootstrap: async () => void calls.push('bootstrap'),
    abandonSession: async () => void calls.push('abandonSession'),
    recoverWithRecoveryCode: async () => 'N'.repeat(43),
    regenerateRecoveryCode: async () => 'N'.repeat(43),
  } as unknown as SignedOutApi;
  const page = renderSignedOut(root as unknown as HTMLElement, {
    api,
    reload: () => calls.push('reload'),
    timers: noTimers,
    mount: doc.body as unknown as HTMLElement,
    doneMs: 0,
    ...options,
  });
  return {
    doc,
    root,
    calls,
    page,
    button: (label: string) => root.querySelectorAll('button').find((b) => b.textContent === label)!,
  };
}

test('signed-out page after the grace period: says the earlier chats expired; 注册 starts a fresh guest and its sheet says it too', async (t) => {
  const s = signedOutPage(t, { signupEnabled: true, signedIn: false, features: { legal: true } }, { expired: true });
  await s.page.ready;
  assert.equal(s.root.querySelector('.signed-out-expired')!.textContent, '之前的体验聊天已过期');
  assert.deepEqual(
    s.root
      .querySelector('.signed-out-legal')!
      .querySelectorAll('a')
      .map((a) => a.getAttribute('href')),
    ['/terms.html', '/privacy.html'],
  );
  s.button('注册').click();
  await flush();
  await flush();
  assert.deepEqual(s.calls, ['abandonSession', 'bootstrap'], 'a fresh guest through the normal first-visit path');
  const sheetRoot = s.doc.body.querySelector('.acct-sheet')!;
  assert.equal(sheetRoot.querySelector('.acct-expired')!.textContent, '之前的体验聊天已过期');
  assert.equal(sheetRoot.querySelector('.acct-legal')!.textContent, '注册即表示你同意《用户协议》和《隐私政策》');
});

test('signed-out page: without the flags nothing new is shown', async (t) => {
  const s = signedOutPage(t, { signupEnabled: true, signedIn: false });
  await s.page.ready;
  assert.equal(s.root.querySelector('.signed-out-expired'), null);
  assert.equal(s.root.querySelector('.signed-out-erased'), null);
  assert.equal(s.root.querySelector('.signed-out-legal')!.hidden, true);
  s.button('注册').click();
  await flush();
  await flush();
  const sheetRoot = s.doc.body.querySelector('.acct-sheet')!;
  assert.equal(sheetRoot.querySelector('.acct-expired'), null);
  assert.equal(sheetRoot.querySelector('.acct-legal'), null);
});

test('after an erasure the first page names it instead of leaving a bare sign-in screen', async (t) => {
  const s = signedOutPage(t, { signupEnabled: true, signedIn: false }, { erased: accountCopy.doneDelete });
  await s.page.ready;
  assert.equal(s.root.querySelector('.signed-out-erased')!.textContent, '账号和聊天数据已删除。谢谢你来过。');
});

test('a guest cookie that outlived its grace period lands on the signed-out page with the expiry line', async (t) => {
  const doc = installFakeDom(t);
  const root = doc.createElement('div');
  const api = {
    account: async () => ({ signupEnabled: true, signedIn: false }),
    bootstrap: async () => undefined,
    abandonSession: async () => undefined,
  } as unknown as SignedOutApi;
  renderProviderStartError(
    root as unknown as HTMLElement,
    new ProviderApiError(401, 'GUEST_GRACE_ENDED'),
    () => {},
    api,
  );
  assert.equal(root.querySelector('h1')!.textContent, signedOutCopy.title);
  assert.equal(root.querySelector('.signed-out-expired')!.textContent, '之前的体验聊天已过期');
  // The old behaviour for the flag-off answer is unchanged.
  const old = doc.createElement('div');
  renderProviderStartError(
    old as unknown as HTMLElement,
    new ProviderApiError(401, 'GUEST_SESSION_EXPIRED'),
    () => {},
    api,
  );
  assert.equal(old.querySelector('h1')!.textContent, '访客会话已过期');
});

// ---- the chat page: menu entries, grace line, footer ------------------------------------------------------------------

function chat(
  t: test.TestContext,
  account: AccountInfo,
  options: { expired?: boolean; canSend?: boolean; remaining?: number } = {},
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
  if (boot.access.kind === 'guest' && options.canSend !== undefined) boot.access.canSend = options.canSend;
  if (boot.access.kind === 'guest' && options.remaining !== undefined) boot.access.remainingReplies = options.remaining;
  if (options.expired && boot.access.kind === 'guest') {
    boot.access.canSend = false;
    boot.access.trialExpiresAt = Date.now() - 3 * 86_400_000;
  }
  const view = parseWebProviderBootstrap(boot);
  const calls: string[] = [];
  const api = {
    bootstrap: async () => view,
    history: async () => ({ messages: [] }),
    account: async () => account,
    deleteAccount: async () => void calls.push('deleteAccount'),
  } as unknown as ProviderApi;
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
  return {
    doc,
    calls,
    header,
    reloads,
    cards,
    async attach() {
      const live = await LiveBinding.connect(api);
      live.attach({
        head: header as unknown as HTMLElement,
        card: (id) => cards.get(id)! as unknown as HTMLElement,
        name: () => '瓜瓜',
        mark: () => '瓜',
        say: () => {},
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
const login: AccountInfo = {
  signupEnabled: true,
  signedIn: true,
  kind: 'guest',
  hasLogin: true,
  emailMasked: 'p***@example.com',
  nickname: '阿泡',
  canBind: false,
};

// Part 21f (named exception): the account entries left the chat's ⋯ menu (it is 共创 and the model picker only). 删除我的账号
// is now an entry of the top account menu (the nickname button) and 清除本设备的体验数据 of the guest's 更多 button; the
// assertions about WHEN they exist are unchanged.
const topMenu = (f: ReturnType<typeof chat>, label?: string) => {
  const button = f.header
    .querySelectorAll('.head-actions button')
    .find((node) => (label ? node.textContent === label : node.getAttribute('aria-haspopup') === 'menu'))!;
  button.click();
  return f.header.querySelectorAll('.chat-menu-item');
};
test('menu: 删除我的账号 / 清除本设备的体验数据 exist only when the server says account deletion is on', async (t) => {
  const off = chat(t, login);
  await off.attach();
  assert.deepEqual(titles(off.menu()), ['共创 · 让瓜瓜更像瓜瓜']);
  assert.deepEqual(titles(topMenu(off)), ['我的昵称', '修改密码', '退出其他设备', '退出登录']);
  const on = chat(t, { ...login, features: { accountDelete: true } });
  await on.attach();
  assert.deepEqual(titles(on.menu()), ['共创 · 让瓜瓜更像瓜瓜']);
  const items = topMenu(on);
  assert.deepEqual(titles(items), ['我的昵称', '修改密码', '退出其他设备', '退出登录', '删除我的账号']);
  items[4]!.click();
  assert.equal(on.doc.body.querySelector('.acct-sheet')!.querySelector('.acct-title')!.textContent, '删除我的账号');

  const guestOff = chat(t, { signupEnabled: true, signedIn: false });
  await guestOff.attach();
  assert.deepEqual(titles(guestOff.menu()), ['共创 · 让瓜瓜更像瓜瓜']);
  assert.equal(guestOff.header.querySelectorAll('.head-more').length, 0, 'no 更多 button without account deletion');
  const guest = chat(t, { signupEnabled: true, signedIn: false, features: { accountDelete: true } });
  await guest.attach();
  assert.deepEqual(titles(guest.menu()), ['共创 · 让瓜瓜更像瓜瓜']);
  const guestItems = topMenu(guest, '更多');
  assert.deepEqual(titles(guestItems), ['清除本设备的体验数据']);
  guestItems[0]!.click();
  assert.equal(
    guest.doc.body.querySelector('.acct-sheet')!.querySelector('.acct-title')!.textContent,
    '清除本设备的体验数据',
  );
});

test('after 删除 the tab ends on the signed-out first page with the final confirmation, and does not reload into a new guest', async (t) => {
  const f = chat(t, { ...login, features: { accountDelete: true } });
  const app = f.doc.createElement('div');
  app.setAttribute('id', 'app');
  f.doc.body.append(app);
  await f.attach();
  topMenu(f)[4]!.click();
  const sheetRoot = f.doc.body.querySelector('.acct-sheet')!;
  sheetRoot.querySelector('input[name="password"]')!.value = 'pw-pw-pw-pw';
  sheetRoot.querySelector('input[name="confirm"]')!.value = '删除';
  sheetRoot.querySelector('form')!.dispatch('submit');
  await flush();
  // The real sheet shows the confirmation for ~2 s before it hands over; wait it out with the real clock.
  await new Promise((resolve) => setTimeout(resolve, 2400));
  assert.deepEqual(f.calls, ['deleteAccount']);
  assert.deepEqual(f.reloads, [], 'no reload: a reload would start a brand new guest');
  assert.equal(app.querySelector('.signed-out-erased')?.textContent, '账号和聊天数据已删除。谢谢你来过。');
});

test('grace: a guest past its trial sees the agreed line and keeps 注册; a signed-up or fresh guest does not', async (t) => {
  const grace: AccountInfo = {
    signupEnabled: true,
    signedIn: true,
    kind: 'guest',
    hasLogin: false,
    emailMasked: null,
    nickname: null,
    canBind: false,
    features: { grace: true },
    grace: { endsAt: Date.now() + 4 * 86_400_000 },
  };
  const f = chat(t, grace, { expired: true });
  await f.attach();
  const hint = f.header.querySelector('.grace-hint')!;
  assert.equal(hint.textContent, '体验已结束 · 注册即可保存并找回你的聊天（7 天内）');
  assert.ok(
    f.header.querySelectorAll('button').some((b) => b.textContent === '注册'),
    '注册 stays in the top bar',
  );
  const { grace: _gone, ...withoutGrace } = grace as Extract<AccountInfo, { signedIn: true }>;
  const fresh = chat(t, withoutGrace);
  await fresh.attach();
  assert.equal(fresh.header.querySelector('.grace-hint'), null);
  const kept = chat(t, { ...login, features: { grace: true } }, { expired: true });
  await kept.attach();
  assert.equal(kept.header.querySelector('.grace-hint'), null);
});

test('footer: the legal links appear only with the flag, in the footer line', (t) => {
  for (const legal of [undefined, false, true]) {
    const doc = installFakeDom(t);
    const note = doc.createElement('footer');
    note.className = 'preview-note';
    note.textContent = '邀请体验 · 回复由AI生成';
    appendLegalLinks(note as unknown as Element, legal);
    const links = note
      .querySelectorAll('a')
      .map((a) => [a.textContent, a.getAttribute('href'), a.getAttribute('target')]);
    assert.deepEqual(
      links,
      legal
        ? [
            ['用户协议', '/terms.html', '_blank'],
            ['隐私政策', '/privacy.html', '_blank'],
          ]
        : [],
    );
    if (!legal) assert.equal(note.textContent, '邀请体验 · 回复由AI生成', 'the footer is exactly as before');
  }
  appendLegalLinks(null, true);
});

test('footer: 免费体验 with the free tier on (legal links after it), the old 邀请体验 line with it off', (t) => {
  for (const [freeTier, legal, expected] of [
    [true, true, '免费体验 · 回复由AI生成 · 用户协议 · 隐私政策'],
    [false, true, '邀请体验 · 回复由AI生成 · 用户协议 · 隐私政策'],
    [true, false, '免费体验 · 回复由AI生成'],
    [undefined, false, '邀请体验 · 回复由AI生成'],
  ] as const) {
    const doc = installFakeDom(t);
    const note = doc.createElement('footer');
    note.textContent = footerNote(freeTier);
    appendLegalLinks(note as unknown as Element, legal);
    assert.equal(note.textContent, expected);
  }
});

// ---- Part 17b: the signup bonus ---------------------------------------------------------------------------------------

test('GET /account: the signup bonus feature is a small positive integer, nothing else is trusted', async () => {
  const reply = (features: unknown) =>
    new ProviderApi(async () => Response.json({ signupEnabled: true, signedIn: false, features })).account();
  assert.deepEqual(await reply({ signupBonus: 10 }), {
    signupEnabled: true,
    signedIn: false,
    features: { signupBonus: 10 },
  });
  for (const bad of [0, -1, 10.5, '10', 1001, null])
    assert.deepEqual(await reply({ signupBonus: bad }), { signupEnabled: true, signedIn: false }, String(bad));
});

test('signup sheet: says what the signup gives, and the done line names the bonus that was granted', async (t) => {
  const on = sheet(t, 'signup', { bonus: 10 });
  assert.equal(on.root.querySelector('.acct-bonus')!.textContent, '注册即送 10 条免费消息，可以和任何角色聊。');
  assert.equal(sheet(t, 'signup').root.querySelector('.acct-bonus'), null);
  assert.equal(sheet(t, 'login', { bonus: 10 }).root.querySelector('.acct-bonus'), null);
  assert.equal(accountCopy.doneSignupBonus(10), '注册成功，已送你 10 条免费消息');
});

test('free replies: a signed-up player sees how many are left; used up says to enter an invite, a guest is offered the bonus', async (t) => {
  const signedUp: AccountInfo = { ...login, features: { signupBonus: 10 } };
  const f = chat(t, signedUp, { canSend: true, remaining: 12 });
  await f.attach();
  assert.equal(f.header.querySelector('.head-note')!.textContent, '免费消息剩余 12 条');
  const guest = chat(t, { signupEnabled: true, signedIn: false, features: { signupBonus: 10 } }, { canSend: true });
  await guest.attach();
  assert.equal(
    guest.header.querySelector('.head-note')!.textContent,
    '体验剩余 3 次',
    'a guest keeps the trial wording',
  );
  // Used up: a signed-up player is told to enter an invite; a guest is offered the bonus.
  const spent = chat(t, signedUp, { canSend: false, remaining: 0 });
  await spent.attach();
  assert.equal(spent.header.querySelector('.head-note')!.textContent, '免费消息已用完');
  assert.equal(spent.header.querySelector('.head-hint')!.textContent, '免费消息已用完，输入邀请码继续');
  const guestSpent = chat(
    t,
    { signupEnabled: true, signedIn: false, features: { signupBonus: 10 } },
    { canSend: false, remaining: 0 },
  );
  await guestSpent.attach();
  assert.equal(guestSpent.header.querySelector('.head-hint')!.textContent, '注册即送 10 条免费消息，可以和任何角色聊');
  // Without the offer the page is exactly as before.
  const off = chat(t, login, { canSend: true });
  await off.attach();
  assert.equal(off.header.querySelector('.head-note')!.textContent, '体验剩余 3 次');
  const offSpent = chat(t, login, { canSend: false, remaining: 0 });
  await offSpent.attach();
  assert.equal(offSpent.header.querySelector('.head-hint')!.textContent, '输入邀请码继续');
});

test('free replies used up: the two agreed lines, by who is asking', () => {
  assert.equal(accountCopy.freeUsedUp, '免费消息已用完，输入邀请码继续');
  assert.equal(accountCopy.signupForBonus(10), '注册即送 10 条免费消息，可以和任何角色聊');
});

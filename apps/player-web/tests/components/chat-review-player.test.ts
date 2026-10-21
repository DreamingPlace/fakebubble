import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveBinding } from '../../src/features/prototype/provider-binding.ts';
import { reviewBannerCopy } from '../../src/features/prototype/review-banner.ts';
import { ProviderApi, type AccountInfo } from '../../src/services/provider-api.ts';
import {
  accountCopy,
  openAccountSheet,
  type AccountApi,
  type AccountSheetMode,
} from '../../src/features/account/account-sheet.ts';
import { syntheticProviderBootstrap, parseWebProviderBootstrap } from '../../../../packages/contracts/web-provider.ts';
import { FakeElement, flush, installFakeDom } from './fake-dom.ts';

const noTimers = { now: () => 0, setInterval: () => 0, clearInterval: () => {} };
const guest: AccountInfo = {
  signupEnabled: true,
  signedIn: true,
  kind: 'guest',
  hasLogin: false,
  emailMasked: null,
  nickname: null,
};

// ---- GET /account and the close call ---------------------------------------------------------------------------------

test('GET /account: the review switch and the closed mark are parsed, and absent when the server sends none', async () => {
  const off = await new ProviderApi(async () => Response.json({ ...guest })).account();
  assert.equal(Object.hasOwn(off, 'features'), false);
  assert.equal(Object.hasOwn(off, 'reviewNoticeClosed'), false);
  const on = await new ProviderApi(async () =>
    Response.json({ ...guest, features: { chatReview: true, junk: 1 }, reviewNoticeClosed: false }),
  ).account();
  assert.deepEqual(on.signedIn && on.features, { chatReview: true });
  assert.equal(on.signedIn && on.reviewNoticeClosed, false);
  const closed = await new ProviderApi(async () =>
    Response.json({ ...guest, features: { chatReview: true }, reviewNoticeClosed: true }),
  ).account();
  assert.equal(closed.signedIn && closed.reviewNoticeClosed, true);
});

test('closeReviewNotice is one empty POST with the CSRF token of the session', async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const api = new ProviderApi(async (url, init) => {
    seen.push({ url: String(url), init: init! });
    return Response.json(
      String(url).endsWith('/bootstrap') ? { ...syntheticProviderBootstrap(), csrf: 'C'.repeat(43) } : { closed: true },
    );
  });
  await api.bootstrap();
  await api.closeReviewNotice();
  assert.equal(seen[1]!.url, '/api/web/provider/account/review-notice-close');
  assert.equal(seen[1]!.init.method, 'POST');
  assert.equal(seen[1]!.init.body, '{}');
  assert.equal((seen[1]!.init.headers as Record<string, string>)['X-CSRF-Token'], 'C'.repeat(43));
});

// ---- the chat page ---------------------------------------------------------------------------------------------------

function chat(t: test.TestContext, account: AccountInfo, closeReviewNotice?: () => Promise<void>) {
  const doc = installFakeDom(t);
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  const boot = syntheticProviderBootstrap();
  boot.fixture = false;
  for (const character of boot.characters) character.availability = { state: 'available', personaVersion: 1 };
  const view = parseWebProviderBootstrap(boot);
  const closes: string[] = [];
  const api = {
    bootstrap: async () => view,
    history: async () => ({ messages: [] }),
    account: async () => account,
    closeReviewNotice:
      closeReviewNotice ??
      (async () => {
        closes.push('close');
      }),
  } as unknown as ProviderApi;
  const cards = new Map<string, FakeElement>();
  for (const id of ['wei-guagua', 'jojo', 'chen-jimi']) {
    const card = doc.createElement('article'),
      head = doc.createElement('div'),
      body = doc.createElement('div'),
      composer = doc.createElement('div'),
      box = doc.createElement('textarea'),
      send = doc.createElement('button');
    head.className = 'chat-head';
    body.className = 'chat-body';
    composer.className = 'composer';
    send.className = 'send-button icon-button';
    composer.append(box, send);
    card.append(head, body, composer);
    cards.set(id, card);
  }
  const header = doc.createElement('header');
  header.append(Object.assign(doc.createElement('span'), { className: 'head-note' }));
  return {
    doc,
    cards,
    closes,
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
    banners: () => [...cards.values()].map((card) => card.querySelector('.review-banner')),
  };
}
const on: AccountInfo = { ...guest, features: { chatReview: true }, reviewNoticeClosed: false };

test('banner: one at the top of every chat, with the agreed words and a link to 隐私政策, until the player closes it', async (t) => {
  const f = chat(t, on);
  await f.attach();
  const banners = f.banners();
  assert.equal(banners.filter(Boolean).length, 3);
  for (const banner of banners) {
    assert.equal(
      banner!.querySelector('.review-banner-text')!.textContent,
      '测试期间，管理员可能以匿名编号（如 JOJO-AX01）查看聊天全文，用于改进角色。详见隐私政策',
    );
    const link = banner!.querySelector('a')!;
    assert.equal(link.textContent, '隐私政策');
    assert.equal(link.getAttribute('href'), '/privacy.html');
    assert.equal(banner!.querySelector('.review-banner-close')!.textContent, '×');
  }
  // It sits between the chat header and the messages, never inside the composer.
  const card = f.cards.get('jojo')!;
  assert.deepEqual(
    card.children.map((c) => (c as FakeElement).className.split(' ')[0]),
    ['chat-head', 'review-banner', 'chat-body', 'composer'],
  );
  assert.equal(reviewBannerCopy.privacy, '隐私政策');
});

test('banner: × closes it everywhere, tells the server once, and it stays closed after a reload', async (t) => {
  const f = chat(t, on);
  await f.attach();
  f.cards.get('jojo')!.querySelector('.review-banner-close')!.click();
  await flush();
  assert.deepEqual(f.banners(), [null, null, null]);
  assert.deepEqual(f.closes, ['close'], 'one call, not one per chat');
  // A reload asks the server again: it remembers the close per player.
  const reloaded = chat(t, { ...on, reviewNoticeClosed: true });
  await reloaded.attach();
  assert.deepEqual(reloaded.banners(), [null, null, null]);
  assert.deepEqual(reloaded.closes, []);
});

test('banner: absent with the flag off, and a failed close call never breaks the page', async (t) => {
  const off = chat(t, guest);
  await off.attach();
  assert.deepEqual(off.banners(), [null, null, null]);
  const failing = chat(t, on, async () => {
    throw new Error('offline');
  });
  await failing.attach();
  failing.cards.get('wei-guagua')!.querySelector('.review-banner-close')!.click();
  await flush();
  assert.deepEqual(failing.banners(), [null, null, null], 'hidden for this visit regardless');
  // The composer is untouched by the banner either way: same elements, nothing disabled by it.
  for (const card of failing.cards.values()) {
    assert.ok(card.querySelector('textarea') && card.querySelector('.send-button'));
    assert.notEqual(card.querySelector('textarea')!.getAttribute('disabled'), 'true');
  }
});

// ---- the sheets --------------------------------------------------------------------------------------------------------

function sheet(
  t: test.TestContext,
  mode: AccountSheetMode,
  extra: Partial<Parameters<typeof openAccountSheet>[0]> = {},
  stubs: Record<string, (input: unknown) => unknown> = {},
) {
  const doc = installFakeDom(t);
  const calls: [string, unknown][] = [];
  const api = {
    requestEmailCode: async (input: unknown) => (
      calls.push(['requestEmailCode', input]), { challengeId: 'c', expiresAt: 1, resendAfterMs: 60000 }
    ),
    verifyEmailCode: async (input: unknown) => void calls.push(['verifyEmailCode', input]),
    finishAccount: async (input: unknown) => (
      calls.push(['finishAccount', input]), { nickname: '阿泡', emailMasked: 'p***' }
    ),
    deleteAccount: async (input: unknown) => void calls.push(['deleteAccount', input]),
    ...stubs,
  } as unknown as AccountApi;
  const opened = openAccountSheet({
    api,
    mode,
    mount: doc.body as unknown as HTMLElement,
    timers: noTimers,
    doneMs: 0,
    signupEnabled: true,
    ...extra,
  });
  const root = opened.element as unknown as FakeElement;
  return {
    root,
    calls,
    input: (name: string) => root.querySelector(`input[name="${name}"]`)!,
    status: () => root.querySelector('.acct-status')!.textContent,
    submit: () => root.querySelector('form')!.dispatch('submit'),
  };
}
const SENTENCE = '聊天文字会以匿名编号再保留 180 天，用于改进角色，之后自动删除。';

test('删除 and 清除 sheets: the 180-day sentence is appended to the warning only while the review switch is on', (t) => {
  assert.equal(accountCopy.reviewRetention, SENTENCE);
  for (const mode of ['delete', 'clear'] as const) {
    const withReview = sheet(t, mode, { reviewRetention: true }).root.querySelector('.acct-warning')!.textContent;
    const without = sheet(t, mode).root.querySelector('.acct-warning')!.textContent;
    assert.equal(withReview, without + SENTENCE, mode);
    assert.ok(!without.includes('180'), `${mode} without the switch says nothing new`);
    assert.ok(withReview.endsWith(SENTENCE));
  }
  assert.match(
    sheet(t, 'delete', { reviewRetention: true }).root.querySelector('.acct-warning')!.textContent,
    /^这会立即永久删除你的账号、全部聊天记录、记忆、生成的语音、共创内容和昵称，无法恢复。.*聊天文字会以匿名编号再保留 180 天/,
  );
});

test('signup: the 18+ tick is there only with the legal pages, above the button, required, and goes with the signup request', async (t) => {
  const s = sheet(t, 'signup', { legal: true });
  const tick = s.input('adult');
  assert.equal(tick.getAttribute('type'), 'checkbox');
  assert.notEqual(tick.getAttribute('required'), null, 'a native required checkbox');
  assert.equal(s.root.querySelector('.acct-adult')!.textContent, '我已年满 18 周岁');
  const form = s.root.querySelector('form')!;
  const order = form.querySelectorAll('.acct-adult, .acct-primary').map((e) => e.className.split(' ')[0]);
  assert.deepEqual(order, ['acct-check', 'acct-primary'], 'the tick comes before the submit button');
  s.input('email').value = 'p@example.com';
  // Unticked: refused on the page, nothing is sent.
  s.submit();
  await flush();
  assert.equal(s.status(), accountCopy.errors.AGE_CONFIRMATION_REQUIRED);
  assert.deepEqual(s.calls, []);
  // Ticked: the code goes out, and the signup request later carries adult:true.
  tick.checked = true;
  s.submit();
  await flush();
  assert.deepEqual(s.calls, [['requestEmailCode', { purpose: 'signup', email: 'p@example.com' }]]);
  s.input('code').value = '123456';
  s.submit();
  await flush();
  // Part 21i (named exception): signup asks for the password twice.
  s.input('password').value = 'pw-pw-pw-pw';
  s.input('password-again').value = 'pw-pw-pw-pw';
  s.input('nickname').value = '阿泡';
  s.submit();
  await flush();
  assert.deepEqual(s.calls.at(-1), [
    'finishAccount',
    { purpose: 'signup', challengeId: 'c', password: 'pw-pw-pw-pw', nickname: '阿泡', adult: true },
  ]);
});

test('signup without the legal pages, and every other sheet: no tick, and the request is exactly as before', async (t) => {
  for (const extra of [{}, { legal: false }]) {
    const s = sheet(t, 'signup', extra);
    assert.equal(s.root.querySelector('input[name="adult"]'), null);
    s.input('email').value = 'p@example.com';
    s.submit();
    await flush();
    s.input('code').value = '123456';
    s.submit();
    await flush();
    // Part 21i (named exception): signup asks for the password twice.
    s.input('password').value = 'pw-pw-pw-pw';
    s.input('password-again').value = 'pw-pw-pw-pw';
    s.input('nickname').value = '阿泡';
    s.submit();
    await flush();
    assert.deepEqual(s.calls.at(-1), [
      'finishAccount',
      { purpose: 'signup', challengeId: 'c', password: 'pw-pw-pw-pw', nickname: '阿泡' },
    ]);
  }
  for (const mode of ['login', 'reset', 'nickname', 'password'] as const)
    assert.equal(sheet(t, mode, { legal: true }).root.querySelector('input[name="adult"]'), null, mode);
});

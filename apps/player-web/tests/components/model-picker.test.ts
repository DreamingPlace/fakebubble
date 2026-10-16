import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveBinding } from '../../src/features/prototype/provider-binding.ts';
import { backupNote, modelCopy, modelFooterNote, openModelPicker } from '../../src/features/prototype/model-picker.ts';
import { ProviderApi, type AccountInfo } from '../../src/services/provider-api.ts';
import { PLAYER_MODELS, parseModelChoice, type ModelChoiceInfo } from '../../../../packages/contracts/player-models.ts';
import type { BillingPage } from '../../../../packages/contracts/player-billing.ts';
import { GUIDE_KEY, resetChatGuide } from '../../src/features/cocreation/chat-guide.ts';
import { billingRow } from '../../src/features/account/billing-sheet.ts';
import { syntheticProviderBootstrap, parseWebProviderBootstrap } from '../../../../packages/contracts/web-provider.ts';
import { FakeElement, flush, installFakeDom } from './fake-dom.ts';

const info: ModelChoiceInfo = {
  models: [
    { id: 'deepseek', points: 10, voicePoints: 2 },
    { id: 'gemini', points: 20, voicePoints: 2 },
    { id: 'xai', points: 25, voicePoints: 2 },
  ],
  selected: 'deepseek',
  metered: true,
  balance: 100,
  repliesLeft: 8,
  version: 2,
};
const login: AccountInfo = {
  signupEnabled: true,
  signedIn: true,
  kind: 'guest',
  hasLogin: true,
  emailMasked: 'p***@example.com',
  nickname: '阿泡',
  canBind: false,
  features: { signupBonus: 10 },
};

test('GET /account: the picker state is parsed strictly and absent when the server sends none or junk', async () => {
  const off = await new ProviderApi(async () => Response.json({ ...login })).account();
  assert.equal(Object.hasOwn(off, 'modelChoice'), false);
  const on = await new ProviderApi(async () => Response.json({ ...login, modelChoice: info })).account();
  assert.deepEqual(on.signedIn && on.modelChoice, info);
  for (const junk of [
    { ...info, selected: 'gpt' },
    { ...info, models: [] },
    { ...info, balance: -1 },
    { ...info, models: [{ id: 'xai', points: 25, voicePoints: 2 }] }, // the selected model is not offered
    'x',
  ])
    assert.equal(parseModelChoice(junk), undefined);
  const ignored = await new ProviderApi(async () =>
    Response.json({ ...login, modelChoice: { ...info, balance: 'x' } }),
  ).account();
  assert.equal(Object.hasOwn(ignored, 'modelChoice'), false);
});

test('setModel is one POST with the CSRF token and returns the new state', async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const api = new ProviderApi(async (url, init) => {
    seen.push({ url: String(url), init: init! });
    return Response.json(
      String(url).endsWith('/bootstrap')
        ? { ...syntheticProviderBootstrap(), csrf: 'C'.repeat(43) }
        : { modelChoice: { ...info, selected: 'xai', repliesLeft: 2 } },
    );
  });
  await api.bootstrap();
  const next = await api.setModel('xai');
  assert.equal(seen[1]!.url, '/api/web/provider/account/model');
  assert.equal(seen[1]!.init.method, 'POST');
  assert.equal(seen[1]!.init.body, JSON.stringify({ model: 'xai' }));
  assert.equal((seen[1]!.init.headers as Record<string, string>)['X-CSRF-Token'], 'C'.repeat(43));
  assert.equal(next.selected, 'xai');
});

test('the words: name, one line of character, 约 N 点/条, 语音 +2, the confirm sentence and the balance line', (t) => {
  const doc = installFakeDom(t);
  openModelPicker({ info, api: { setModel: async () => info }, onChanged: () => {}, mount: doc.body as never });
  const cards = doc.body.querySelectorAll('.mp-card');
  assert.equal(cards.length, 3);
  const text = (card: FakeElement) => card.textContent;
  assert.match(text(cards[0]!), /DeepSeek/);
  assert.match(text(cards[0]!), /当前/);
  assert.match(text(cards[1]!), /Gemini 3\.8 Flash/);
  assert.match(text(cards[1]!), /约 20 点\/条/);
  assert.match(text(cards[2]!), /Grok 4\.7/);
  assert.match(text(cards[2]!), /约 25 点\/条/);
  assert.match(text(cards[2]!), /语音 \+2/);
  for (const model of Object.values(PLAYER_MODELS))
    assert.ok(model.blurb.length > 0 && [...model.blurb].length <= 16, 'one short line');
  assert.equal(doc.body.querySelector('.mp-balance')!.textContent, '剩余 100 点 · 约可聊 8 条');
  assert.equal(modelFooterNote(info), '剩余 100 点 · 约可聊 8 条');
  assert.equal(
    modelCopy.confirm('Grok 4.7', 25, 2),
    '之后的消息用 Grok 4.7，约 25 点/条（语音 +2）。记忆和聊天记录不变。',
  );
});

test('switching asks first: cancel changes nothing; confirm switches once, reports the new state and closes', async (t) => {
  const doc = installFakeDom(t);
  const calls: string[] = [];
  const changed: ModelChoiceInfo[] = [];
  const said: string[] = [];
  const picker = openModelPicker({
    info,
    api: {
      setModel: async (id) => {
        calls.push(id);
        return { ...info, selected: id, repliesLeft: 2 };
      },
    },
    onChanged: (next) => changed.push(next),
    say: (message) => said.push(message),
    mount: doc.body as never,
  });
  const grok = () => doc.body.querySelector('[data-model="xai"]')!;
  grok().click();
  assert.equal(
    doc.body.querySelector('.mp-confirm')!.textContent,
    '之后的消息用 Grok 4.7，约 25 点/条（语音 +2）。记忆和聊天记录不变。',
  );
  assert.deepEqual(calls, [], 'nothing is sent before the confirmation');
  doc.body
    .querySelectorAll('button')
    .find((b) => b.textContent === '取消')!
    .click();
  assert.ok(doc.body.querySelector('.mp-card'), 'back to the list');
  assert.deepEqual(calls, []);
  // Choosing the current model is not a switch.
  doc.body.querySelector('[data-model="deepseek"]')!.click();
  assert.equal(doc.body.querySelector('.mp-confirm'), null);
  grok().click();
  doc.body
    .querySelectorAll('button')
    .find((b) => b.textContent === '确认切换')!
    .click();
  await flush();
  assert.deepEqual(calls, ['xai']);
  assert.equal(changed[0]!.selected, 'xai');
  assert.deepEqual(said, ['已切换为 Grok 4.7']);
  assert.equal(doc.body.querySelector('.mp-sheet'), null, 'closed');
  picker.close();
});

test('a failed switch keeps the sheet open, says so, and can be retried', async (t) => {
  const doc = installFakeDom(t);
  let fail = true;
  openModelPicker({
    info,
    api: {
      setModel: async (id) => {
        if (fail) throw new Error('offline');
        return { ...info, selected: id };
      },
    },
    onChanged: () => {},
    mount: doc.body as never,
  });
  doc.body.querySelector('[data-model="gemini"]')!.click();
  const sure = () => doc.body.querySelectorAll('button').find((b) => b.textContent === '确认切换')!;
  sure().click();
  await flush();
  assert.equal(doc.body.querySelector('.acct-status')!.textContent, '没能切换，稍后再试试');
  assert.ok(doc.body.querySelector('.mp-sheet'));
  fail = false;
  sure().click();
  await flush();
  assert.equal(doc.body.querySelector('.mp-sheet'), null);
});

// Part 21f (named exception): the note names the models: "{chosen} 繁忙，由 {actual} 回复 · 按 {billed} 计费".
test('the backup note is plain text and names the models; an invited player is told no billing', (t) => {
  installFakeDom(t);
  assert.equal(
    backupNote({ chosen: 'gemini', actual: 'deepseek' }, true).textContent,
    'Gemini 3.8 Flash 繁忙，由 DeepSeek 回复 · 按 DeepSeek 计费',
  );
  assert.equal(
    backupNote({ chosen: 'xai', actual: 'gemini' }, true).textContent,
    'Grok 4.7 繁忙，由 Gemini 3.8 Flash 回复 · 按 Gemini 3.8 Flash 计费',
  );
  // A backup dearer than the chosen model never raises the price: billed as the chosen (cheaper) one.
  assert.equal(
    backupNote({ chosen: 'deepseek', actual: 'gemini' }, true).textContent,
    'DeepSeek 繁忙，由 Gemini 3.8 Flash 回复 · 按 DeepSeek 计费',
  );
  assert.equal(
    backupNote({ chosen: 'gemini', actual: 'deepseek' }, false).textContent,
    'Gemini 3.8 Flash 繁忙，由 DeepSeek 回复',
  );
});

test('the picker shows a speed hint per model from one constant', (t) => {
  const doc = installFakeDom(t);
  openModelPicker({ info, api: { setModel: async () => info }, onChanged: () => {}, mount: doc.body as never });
  const speeds = doc.body.querySelectorAll('.mp-card').map((card) => card.querySelector('.mp-speed')!.textContent);
  assert.deepEqual(speeds, ['较快', '较快', '较慢，约20秒']);
  assert.deepEqual(
    Object.values(PLAYER_MODELS).map((model) => model.speed),
    speeds,
  );
});

// ---- the chat page: three small hooks -----------------------------------------------------------------------------------

function chat(t: test.TestContext, account: AccountInfo, options: { invited?: boolean } = {}) {
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
  Object.assign(boot.access, { canSend: true, remainingReplies: 5 });
  if (options.invited)
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
  boot.conversations = [
    { conversationId: 'conversation-1', characterId: 'wei-guagua', lastMessageId: 'm1', unreadCount: 0 },
  ];
  const view = parseWebProviderBootstrap(boot);
  const history = (reply: Record<string, unknown> | null) => ({
    messages:
      reply === null
        ? []
        : [
            {
              messageId: 'm1',
              conversationId: view.conversations[0]!.conversationId,
              characterId: view.conversations[0]!.characterId,
              operationId: 'op',
              replyOrdinal: 0,
              author: 'character',
              origin: 'narrative',
              text: '回复',
              createdAt: 1,
              audio: { revision: 1, status: 'ready', mediaId: 'media', durationMs: 2000, errorCode: null },
              ...reply,
            },
          ],
    before: null,
    hasMore: false,
  });
  let replyExtra: Record<string, unknown> | null = null;
  let current = account;
  const calls: string[] = [];
  let billingData: BillingPage | null = null;
  const api = {
    bootstrap: async () => view,
    history: async () => history(replyExtra),
    account: async () => {
      calls.push('account');
      return current;
    },
    setModel: async () => info,
    billing: async (page: number) => {
      calls.push(`billing:${page}`);
      if (!billingData) throw new Error('offline');
      return billingData;
    },
    submitCocreation: async () => ({ submissionId: 's', answered: 1, duplicate: false }),
  } as unknown as ProviderApi;
  const cards = new Map<string, FakeElement>();
  for (const id of ['wei-guagua', 'jojo', 'chen-jimi']) {
    const card = doc.createElement('article'),
      head = doc.createElement('div'),
      body = doc.createElement('div'),
      list = doc.createElement('div'),
      composer = doc.createElement('div'),
      box = doc.createElement('textarea'),
      send = doc.createElement('button'),
      more = doc.createElement('button');
    head.className = 'chat-head';
    more.className = 'chat-more';
    head.append(more);
    body.className = 'chat-body';
    list.className = 'sent-messages';
    body.append(list);
    composer.className = 'composer';
    send.className = 'send-button icon-button';
    composer.append(box, send);
    card.append(head, body, composer);
    cards.set(id, card);
  }
  cards.get('wei-guagua')!.classList.add('is-active');
  const header = doc.createElement('header');
  const note = Object.assign(doc.createElement('span'), { className: 'head-note' });
  header.append(note);
  const said: string[] = [];
  return {
    doc,
    cards,
    note,
    header,
    said,
    calls,
    setAccount: (next: AccountInfo) => {
      current = next;
    },
    setBilling: (page: BillingPage) => {
      billingData = page;
    },
    /** The player comes back to the page (a reply landed, the tab regained focus): the page re-reads the state. */
    returnToPage: async () => {
      (globalThis as unknown as { window: EventTarget }).window.dispatchEvent(new Event('focus'));
      await flush();
    },
    /** Opens the chat ⋯ menu of the first card; returns its entries. */
    menu: (id = 'wei-guagua') => {
      const card = cards.get(id)!;
      card.querySelector('.chat-more')!.click();
      return card.querySelectorAll('.chat-menu-item');
    },
    /** The chat is opened (the card turns into the chat view and the page opens its conversation). */
    async openChat(live: LiveBinding, id = 'wei-guagua') {
      const card = cards.get(id)!;
      card.classList.add('is-chat');
      await live.open(id as never, card as unknown as HTMLElement);
      await flush();
    },
    setReply: (extra: Record<string, unknown>) => {
      replyExtra = extra;
    },
    async attach() {
      const live = await LiveBinding.connect(api);
      live.attach({
        head: header as unknown as HTMLElement,
        card: (id) => cards.get(id)! as unknown as HTMLElement,
        name: () => '瓜瓜',
        mark: () => '瓜',
        say: (message) => said.push(message),
      });
      await flush();
      return live;
    },
  };
}

test('page hook 1: the footer says 剩余 X 点 · 约可聊 Y 条 with the picker on, and the old free-replies line without it', async (t) => {
  const on = chat(t, { ...login, modelChoice: info });
  await on.attach();
  assert.equal(on.note.textContent, '剩余 100 点 · 约可聊 8 条');
  const off = chat(t, login);
  await off.attach();
  assert.match(off.note.textContent, /^免费消息(剩余 \d+ 条|已用完)$/, 'flag off: exactly today');
});

test('page hook 2: a one-time notice says the withdrawn model was replaced by DeepSeek', async (t) => {
  const f = chat(t, { ...login, modelChoice: { ...info, notice: 'model_withdrawn' } });
  await f.attach();
  assert.deepEqual(f.said, ['之前选的模型暂时不提供了，已改用 DeepSeek']);
  const quiet = chat(t, { ...login, modelChoice: info });
  await quiet.attach();
  assert.deepEqual(quiet.said, []);
});

test('page hook 3: a reply written by the backup model says so, once; an ordinary reply does not', async (t) => {
  const backup = chat(t, { ...login, modelChoice: info });
  // (The shared fake DOM refuses innerHTML, so the reply is a text-delivered one: the hook is the same condition.)
  backup.setReply({ viaBackup: { chosen: 'gemini', actual: 'deepseek' }, deliveryFallback: 'text', audio: null });
  await backup.attach();
  const notes = [...backup.cards.values()].flatMap((card) => card.querySelectorAll('.backup-note'));
  assert.equal(notes.length, 1);
  assert.equal(notes[0]!.textContent, 'Gemini 3.8 Flash 繁忙，由 DeepSeek 回复 · 按 DeepSeek 计费');
  const plain = chat(t, { ...login, modelChoice: info });
  plain.setReply({ deliveryFallback: 'text', audio: null });
  await plain.attach();
  assert.equal([...plain.cards.values()].flatMap((card) => card.querySelectorAll('.backup-note')).length, 0);
});

test('an invited player picks a model without prices or balance: nothing is charged', (t) => {
  const doc = installFakeDom(t);
  const free: ModelChoiceInfo = { ...info, metered: false, balance: 0, repliesLeft: 0 };
  openModelPicker({ info: free, api: { setModel: async () => free }, onChanged: () => {}, mount: doc.body as never });
  assert.equal(doc.body.querySelectorAll('.mp-prices').length, 0);
  assert.equal(doc.body.querySelector('.mp-balance')!.textContent, '');
  doc.body.querySelector('[data-model="xai"]')!.click();
  assert.equal(doc.body.querySelector('.mp-confirm')!.textContent, '之后的消息用 Grok 4.7。记忆和聊天记录不变。');
  assert.equal(modelCopy.menuSub(free), 'DeepSeek');
});

// ---- Part 21f: the chat ⋯ menu, the first-time guide, a current balance, 消费记录 ------------------------------------------

const titlesOf = (items: FakeElement[]) => items.map((item) => item.querySelector('.chat-menu-title')!.textContent);
const guestAccount: AccountInfo = { signupEnabled: true, signedIn: false };
const invitedAccount: AccountInfo = {
  signupEnabled: true,
  signedIn: true,
  kind: 'invite',
  hasLogin: false,
  emailMasked: null,
  nickname: null,
  canBind: false,
  modelChoice: { ...info, metered: false, balance: 0, repliesLeft: 0 },
};

test('chat ⋯ menu: 切换回复模型 and 共创 only, in that order; a guest has 共创 only; no account entries in either', async (t) => {
  const signedUp = chat(t, { ...login, modelChoice: info });
  await signedUp.attach();
  const items = signedUp.menu();
  assert.deepEqual(titlesOf(items), ['切换回复模型', '共创 · 让瓜瓜更像瓜瓜']);
  assert.equal(items[0]!.querySelector('.chat-menu-sub')!.textContent, 'DeepSeek · 约 10 点/条');
  items[0]!.click();
  assert.ok(signedUp.doc.body.querySelector('.mp-sheet'), 'the picker opens');
  const guest = chat(t, guestAccount);
  await guest.attach();
  assert.deepEqual(titlesOf(guest.menu()), ['共创 · 让瓜瓜更像瓜瓜']);
  const invited = chat(t, invitedAccount);
  await invited.attach();
  assert.deepEqual(titlesOf(invited.menu()), ['切换回复模型', '共创 · 让瓜瓜更像瓜瓜']);
  // Flag off (a login without a picker): 共创 only, the account entries are in the top menu.
  const noPicker = chat(t, login);
  await noPicker.attach();
  assert.deepEqual(titlesOf(noPicker.menu()), ['共创 · 让瓜瓜更像瓜瓜']);
});

test('first-time guide: a bubble at ⋯ when a chat is first opened; tap or opening the menu dismisses it for good (localStorage)', async (t) => {
  const store = new Map<string, string>();
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });
  resetChatGuide();
  const f = chat(t, { ...login, modelChoice: info });
  const live = await f.attach();
  const head = () => f.cards.get('wei-guagua')!.querySelector('.chat-head')!;
  assert.equal(head().querySelectorAll('.chat-guide').length, 0, 'not before a chat is opened');
  await f.openChat(live);
  assert.equal(head().querySelectorAll('.chat-guide').length, 1);
  assert.equal(head().querySelector('.chat-guide')!.textContent, '点这里可以切换回复模型，或和角色一起共创');
  // Tapping the bubble dismisses it and remembers.
  head().querySelector('.chat-guide')!.click();
  assert.equal(head().querySelectorAll('.chat-guide').length, 0);
  assert.equal(store.get(GUIDE_KEY), '1');
  // A later page load does not show it again.
  resetChatGuide();
  const again = chat(t, { ...login, modelChoice: info });
  await again.openChat(await again.attach());
  assert.equal(again.cards.get('wei-guagua')!.querySelectorAll('.chat-guide').length, 0);

  // Opening the menu dismisses it too; a guest is told about 共创 only.
  store.clear();
  resetChatGuide();
  const guest = chat(t, guestAccount);
  await guest.openChat(await guest.attach());
  const bubble = guest.cards.get('wei-guagua')!.querySelector('.chat-guide')!;
  assert.equal(bubble.textContent, '点这里可以和角色一起共创');
  guest.menu();
  assert.equal(guest.cards.get('wei-guagua')!.querySelectorAll('.chat-guide').length, 0);
  assert.equal(store.get(GUIDE_KEY), '1');
});

test('first-time guide: when storage fails it is shown once per page load, never twice', async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      throw new Error('blocked');
    },
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });
  resetChatGuide();
  const f = chat(t, guestAccount);
  const live = await f.attach();
  await f.openChat(live);
  const head = () => f.cards.get('wei-guagua')!.querySelector('.chat-head')!;
  assert.equal(head().querySelectorAll('.chat-guide').length, 1, 'shown despite the failing storage');
  head().querySelector('.chat-guide')!.click();
  assert.equal(head().querySelectorAll('.chat-guide').length, 0);
  await f.openChat(live);
  await f.openChat(live, 'jojo');
  assert.equal(
    [...f.cards.values()].flatMap((card) => card.querySelectorAll('.chat-guide')).length,
    0,
    'not again on this page load',
  );
});

test('the balance on the page is the settled one: it is re-read when the player returns after a reply landed', async (t) => {
  const f = chat(t, { ...login, modelChoice: { ...info, balance: 78, repliesLeft: 6 } });
  await f.attach();
  assert.equal(f.note.textContent, '剩余 78 点 · 约可聊 6 条');
  // The reply was written by the backup model: 22 were charged at admission, 10 came back at settlement.
  f.setAccount({ ...login, modelChoice: { ...info, balance: 88, repliesLeft: 7 } });
  await f.returnToPage();
  assert.equal(f.note.textContent, '剩余 88 点 · 约可聊 7 条');
  assert.equal(f.calls.filter((call) => call === 'account').length, 2);
  // Without the picker nothing extra is fetched.
  const plain = chat(t, login);
  await plain.attach();
  await plain.returnToPage();
  assert.equal(plain.calls.filter((call) => call === 'account').length, 1);
});

const billingData = (over: Partial<BillingPage> = {}): BillingPage => ({
  metered: true,
  balance: 76,
  month: {
    byModel: [
      { model: 'xai', points: 25, replies: 1 },
      { model: 'deepseek', points: 12, replies: 1 },
    ],
    byCharacter: [{ characterId: 'wei-guagua', points: 37, replies: 2 }],
  },
  items: [
    {
      kind: 'reply',
      at: Date.UTC(2026, 9, 16, 4, 5),
      characterId: 'wei-guagua',
      model: 'deepseek',
      backupFor: 'gemini',
      voice: true,
      points: 12,
      free: false,
    },
    { kind: 'failed', at: Date.UTC(2026, 9, 15, 4, 5), characterId: 'wei-guagua', refunded: 22, free: false },
    { kind: 'bonus', at: Date.UTC(2026, 9, 14, 4, 5), points: 100 },
  ],
  page: 1,
  hasMore: false,
  ...over,
});

test('消费记录: top account menu entry opens the page with balance, this month by model and character, and the rows', async (t) => {
  const f = chat(t, { ...login, modelChoice: info });
  f.setBilling(billingData());
  await f.attach();
  const nick = f.header.querySelectorAll('.head-actions button')[0]!;
  nick.click();
  const entries = f.header.querySelectorAll('.chat-menu-item');
  assert.equal(titlesOf(entries)[0], '消费记录', 'first entry of the top account menu');
  entries[0]!.click();
  await flush();
  const sheet = f.doc.body.querySelector('.bl-sheet')!;
  assert.equal(sheet.querySelector('.bl-balance')!.textContent, '当前剩余 76 点');
  const tables = sheet.querySelectorAll('.bl-table');
  assert.equal(tables.length, 2);
  assert.match(tables[0]!.textContent, /Grok 4\.7/);
  assert.match(tables[1]!.textContent, /瓜瓜/);
  const rows = sheet.querySelectorAll('.bl-row');
  assert.equal(rows.length, 3);
  assert.equal(rows[0]!.querySelector('.bl-points')!.textContent, '−12 点');
  assert.match(rows[0]!.textContent, /DeepSeek（Gemini 3\.8 Flash 繁忙，已改用）/);
  assert.match(rows[0]!.textContent, /瓜瓜/);
  assert.match(rows[0]!.textContent, /语音/);
  assert.match(rows[1]!.textContent, /回复失败，已退还 22 点/);
  assert.match(rows[2]!.textContent, /注册赠送/);
  assert.equal(rows[2]!.querySelector('.bl-points')!.textContent, '+100 点');
  assert.ok(sheet.textContent.includes('只显示最近 90 天'));
  assert.equal(sheet.querySelector('.bl-pager')!.hidden, true, 'one page: no pager');
  assert.doesNotMatch(sheet.textContent, /\$|美元|元|principal|operation/);
});

test('消费记录 rows: free replies say 不计点, no-voice says 无语音, paging goes through the API, failures offer a retry', async (t) => {
  const name = () => '瓜瓜';
  assert.deepEqual(
    billingRow(
      { kind: 'reply', at: 1_000_000, characterId: 'wei-guagua', model: 'gemini', voice: false, points: 0, free: true },
      name,
    ).points,
    '不计点',
  );
  assert.match(
    billingRow(
      {
        kind: 'reply',
        at: 1_000_000,
        characterId: 'wei-guagua',
        model: 'gemini',
        voice: false,
        points: 20,
        free: false,
      },
      name,
    ).sub,
    /Gemini 3\.8 Flash · 无语音/,
  );
  assert.equal(
    billingRow({ kind: 'failed', at: 1_000_000, characterId: 'x', refunded: 0, free: true }, name).sub,
    '回复失败',
  );
  const f = chat(t, { ...invitedAccount }, { invited: true });
  f.setBilling(
    billingData({ metered: false, balance: null, page: 1, hasMore: true, month: { byModel: [], byCharacter: [] } }),
  );
  await f.attach();
  f.header.querySelectorAll('.head-actions button')[0]!.click(); // 我的账号 (an invited player without a login)
  const entries = f.header.querySelectorAll('.chat-menu-item');
  assert.deepEqual(titlesOf(entries), ['消费记录']);
  entries[0]!.click();
  await flush();
  const sheet = f.doc.body.querySelector('.bl-sheet')!;
  assert.equal(sheet.querySelector('.bl-balance')!.textContent, '你的聊天不计点');
  assert.equal(sheet.querySelectorAll('.bl-table').length, 0);
  assert.equal(sheet.querySelector('.bl-pager')!.hidden, false);
  assert.equal(sheet.querySelector('.bl-prev')!.disabled, true);
  f.setBilling(
    billingData({ metered: false, balance: null, page: 2, hasMore: false, month: { byModel: [], byCharacter: [] } }),
  );
  sheet.querySelector('.bl-next')!.click();
  await flush();
  assert.deepEqual(
    f.calls.filter((call) => call.startsWith('billing')),
    ['billing:1', 'billing:2'],
  );
  assert.equal(sheet.querySelector('.bl-next')!.disabled, true);
  // A failure says so and offers a retry.
  const broken = chat(t, { ...login, modelChoice: info });
  await broken.attach();
  broken.header.querySelectorAll('.head-actions button')[0]!.click();
  broken.header.querySelectorAll('.chat-menu-item')[0]!.click();
  await flush();
  const failed = broken.doc.body.querySelector('.bl-sheet')!;
  assert.match(failed.querySelector('.bl-status')!.textContent, /没能加载，稍后再试试/);
  broken.setBilling(billingData());
  failed.querySelector('.bl-status button')!.click();
  await flush();
  assert.equal(failed.querySelectorAll('.bl-row').length, 3);
});

test('消费记录 is not offered to a guest or to a login without a points account', async (t) => {
  const guest = chat(t, guestAccount);
  await guest.attach();
  assert.equal(
    guest.header.querySelectorAll('.head-actions button').filter((b) => b.textContent === '我的账号').length,
    0,
  );
  const noPoints = chat(t, login);
  await noPoints.attach();
  noPoints.header.querySelectorAll('.head-actions button')[0]!.click();
  assert.ok(!titlesOf(noPoints.header.querySelectorAll('.chat-menu-item')).includes('消费记录'));
});

test('ProviderApi.billing posts the page and the clock offset, and parses strictly', async () => {
  const seen: { url: string; body: unknown }[] = [];
  const api = new ProviderApi(async (url, init) => {
    seen.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return Response.json(JSON.parse(JSON.stringify(billingData())));
  });
  const page = await api.billing(2);
  assert.equal(seen[0]!.url, '/api/web/provider/billing/history');
  assert.equal((seen[0]!.body as { page: number }).page, 2);
  assert.ok(Number.isInteger((seen[0]!.body as { tzOffsetMinutes: number }).tzOffsetMinutes));
  assert.equal(page.items.length, 3);
  const junk = new ProviderApi(async () => Response.json({ metered: true, items: [{ kind: 'reply' }] }));
  await assert.rejects(junk.billing(1), /PROTOCOL_INVALID/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveBinding } from '../../src/features/prototype/provider-binding.ts';
import { backupNote, modelCopy, modelFooterNote, openModelPicker } from '../../src/features/prototype/model-picker.ts';
import { ProviderApi, type AccountInfo } from '../../src/services/provider-api.ts';
import { PLAYER_MODELS, parseModelChoice, type ModelChoiceInfo } from '../../../../packages/contracts/player-models.ts';
import { syntheticProviderBootstrap, parseWebProviderBootstrap } from '../../../../packages/contracts/web-provider.ts';
import { FakeElement, flush, installFakeDom } from './fake-dom.ts';

const info: ModelChoiceInfo = {
  models: [
    { id: 'deepseek', points: 10, voicePoints: 2 },
    { id: 'gemini', points: 20, voicePoints: 2 },
    { id: 'xai', points: 40, voicePoints: 2 },
  ],
  selected: 'deepseek',
  balance: 100,
  repliesLeft: 8,
  version: 1,
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
    { ...info, models: [{ id: 'xai', points: 40, voicePoints: 2 }] }, // the selected model is not offered
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
  assert.match(text(cards[2]!), /约 40 点\/条/);
  assert.match(text(cards[2]!), /语音 \+2/);
  for (const model of Object.values(PLAYER_MODELS))
    assert.ok(model.blurb.length > 0 && [...model.blurb].length <= 16, 'one short line');
  assert.equal(doc.body.querySelector('.mp-balance')!.textContent, '剩余 100 点 · 约可聊 8 条');
  assert.equal(modelFooterNote(info), '剩余 100 点 · 约可聊 8 条');
  assert.equal(
    modelCopy.confirm('Grok 4.7', 40, 2),
    '之后的消息用 Grok 4.7，约 40 点/条（语音 +2）。记忆和聊天记录不变。',
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
    '之后的消息用 Grok 4.7，约 40 点/条（语音 +2）。记忆和聊天记录不变。',
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

test('the backup note is plain text', (t) => {
  installFakeDom(t);
  const note = backupNote();
  assert.equal(note.textContent, '由备用模型回复');
});

// ---- the chat page: three small hooks -----------------------------------------------------------------------------------

function chat(t: test.TestContext, account: AccountInfo) {
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
  const api = {
    bootstrap: async () => view,
    history: async () => history(replyExtra),
    account: async () => account,
    setModel: async () => info,
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
    said,
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
  const backup = chat(t, login);
  // (The shared fake DOM refuses innerHTML, so the reply is a text-delivered one: the hook is the same condition.)
  backup.setReply({ viaBackup: true, deliveryFallback: 'text', audio: null });
  await backup.attach();
  const notes = [...backup.cards.values()].flatMap((card) => card.querySelectorAll('.backup-note'));
  assert.equal(notes.length, 1);
  assert.equal(notes[0]!.textContent, '由备用模型回复');
  const plain = chat(t, login);
  plain.setReply({ deliveryFallback: 'text', audio: null });
  await plain.attach();
  assert.equal([...plain.cards.values()].flatMap((card) => card.querySelectorAll('.backup-note')).length, 0);
});

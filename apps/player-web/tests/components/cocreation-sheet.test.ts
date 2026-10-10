import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveBinding } from '../../src/features/prototype/provider-binding.ts';
import { ProviderApi, ProviderApiError } from '../../src/services/provider-api.ts';
import { mountChatMenu } from '../../src/features/cocreation/chat-menu.ts';
import {
  BATCH_SIZE,
  cocreationCopy,
  openCocreationSheet,
  resetCocreationDrafts,
  type CocreationApi,
} from '../../src/features/cocreation/cocreation-sheet.ts';
import {
  COCREATION_CARDS,
  COCREATION_FIELD_LABELS,
  COCREATION_TARGET_FIELDS,
  cocreationPrompt,
  type CocreationAnswer,
} from '../../../../packages/contracts/cocreation-cards.ts';
import { parseWebProviderBootstrap, syntheticProviderBootstrap } from '../../../../packages/contracts/web-provider.ts';
import { FakeElement, flush, installFakeDom } from './fake-dom.ts';

const NAME = '瓜瓜';
/** A fixed shuffle: deterministic yet not the identity. */
const seeded =
  (seed = 7) =>
  () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };

function setup(t: test.TestContext, options: { api?: Partial<CocreationApi>; thanksMs?: number; seed?: number } = {}) {
  const doc = installFakeDom(t);
  resetCocreationDrafts();
  t.after(resetCocreationDrafts);
  const storage: string[] = [];
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: new Proxy({}, { get: (_, key) => storage.push(String(key)) && (() => null) }),
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });
  const calls: { characterId: string; requestId: string; answers: CocreationAnswer[] }[] = [];
  const api: CocreationApi = {
    submitCocreation: async (input) => {
      calls.push(structuredClone(input));
      return { submissionId: `s${calls.length}`, answered: input.answers.length, duplicate: false };
    },
    ...options.api,
  };
  let ids = 0;
  const open = () =>
    openCocreationSheet({
      api,
      characterId: 'wei-guagua',
      name: NAME,
      mark: '瓜',
      color: '#D7C8B9',
      ink: '#614C3C',
      mount: doc.body as unknown as HTMLElement,
      random: seeded(options.seed),
      newRequestId: () => `request-${++ids}`,
      thanksMs: options.thanksMs ?? 0,
    });
  const sheet = open();
  const root = () => sheet.element as unknown as FakeElement;
  const card = (id: string) => root().querySelector(`[data-card="${id}"]`);
  const ids_ = () =>
    root()
      .querySelectorAll('.cc-card')
      .map((c) => c.getAttribute('data-card')!);
  const write = (id: string, text: string) => {
    card(id)!.querySelector('.cc-face')!.click();
    card(id)!.querySelector('textarea')!.type_(text);
  };
  const send = () => root().querySelector('.cc-send')!;
  const progress = () => root().querySelector('.cc-progress')!.textContent;
  return { doc, sheet, root, card, ids: ids_, write, send, progress, calls, open, storage };
}
const firstTextCards = (ids: string[]) => ids.filter((id) => id !== 'dialogue' && id !== 'free');

test('the card list is the whole spec: prompts name the character and no routing field is ever shown', (t) => {
  const f = setup(t);
  const prompts = COCREATION_CARDS.map((card) => cocreationPrompt(card, NAME));
  assert.ok(prompts.includes('瓜瓜被夸的时候会怎么嘴硬？'));
  assert.ok(prompts.includes('你觉得瓜瓜现在哪里不像瓜瓜'));
  assert.ok(prompts.includes('瓜瓜的一个小秘密（无伤大雅的那种）'));
  assert.ok(prompts.includes('随便写点什么'));
  assert.ok(prompts.every((prompt) => !prompt.includes('{name}')));
  const attributes = JSON.stringify([...f.root().querySelectorAll('*')].map((e) => [...e.attributes]));
  for (const field of COCREATION_TARGET_FIELDS) {
    assert.ok(!f.root().textContent.includes(field), `${field} is hidden from players`);
    // The free card’s own id is “free”; every other field name must not appear in any attribute either.
    if (field !== 'free') assert.ok(!attributes.includes(field), `${field} is not in any attribute`);
  }
  for (const label of Object.values(COCREATION_FIELD_LABELS)) assert.ok(!f.root().textContent.includes(label), label);
});

test('the sheet opens with one shuffled batch of cards plus the free card, and a gentle progress hint', (t) => {
  const f = setup(t);
  assert.equal(f.root().getAttribute('role'), 'dialog');
  assert.equal(f.root().querySelector('.cc-title')!.textContent, '共创 · 让瓜瓜更像瓜瓜');
  const ids = f.ids();
  assert.equal(ids.length, BATCH_SIZE + 1);
  assert.equal(ids.at(-1), 'free', '“随便写点什么” is always the last card');
  assert.equal(new Set(ids).size, ids.length);
  assert.notDeepEqual(
    firstTextCards(ids),
    COCREATION_CARDS.filter((c) => firstTextCards(ids).includes(c.id)).map((c) => c.id),
    'shuffled, not in list order',
  );
  assert.equal(f.progress(), '写几张都行，不用写完');
  assert.equal(f.send().disabled, true, 'nothing written yet');
  assert.equal(f.send().textContent, '交给瓜瓜');
  assert.equal(f.root().querySelector('.cc-shuffle')!.textContent, '换一批');
  assert.ok(f.doc.documentElement.classList.contains('cc-open'));
  assert.equal(f.doc.body.children.length, 1);
});

test('tapping a card opens an inline editor with a character counter; writing marks it 已写 and counts it', (t) => {
  const f = setup(t);
  const id = firstTextCards(f.ids())[0]!;
  const card = f.card(id)!;
  const editor = card.querySelector('.cc-editor')!;
  assert.equal(editor.hidden, true);
  card.querySelector('.cc-face')!.click();
  assert.equal(editor.hidden, false);
  assert.ok(card.classList.contains('is-open'));
  const area = card.querySelector('textarea')!;
  assert.equal(area.getAttribute('maxlength'), '300');
  assert.equal(card.querySelector('.cc-count')!.textContent, '0/300');
  assert.ok(!card.classList.contains('is-written'));
  area.type_('哎呀妈呀');
  assert.equal(card.querySelector('.cc-count')!.textContent, '4/300');
  assert.ok(card.classList.contains('is-written'), '已写 state');
  assert.equal(card.querySelector('.cc-badge')!.textContent, '已写');
  assert.equal(f.progress(), '已写 1 张');
  assert.equal(f.send().disabled, false);
  card.querySelector('.cc-done')!.click();
  assert.equal(editor.hidden, true, 'closing the editor keeps the text');
  assert.ok(card.classList.contains('is-written'));
  // Only the free card takes a thousand.
  f.card('free')!.querySelector('.cc-face')!.click();
  assert.equal(f.card('free')!.querySelector('textarea')!.getAttribute('maxlength'), '1000');
  assert.equal(f.card('free')!.querySelector('.cc-count')!.textContent, '0/1000');
});

test('line breaks and control characters become spaces, as chat input would refuse them; whitespace alone is not 已写', (t) => {
  const f = setup(t);
  const id = firstTextCards(f.ids())[0]!;
  f.write(id, '第一行\n第二行\t尾');
  assert.equal(f.card(id)!.querySelector('textarea')!.value, '第一行 第二行 尾');
  f.write(id, '   ');
  assert.ok(!f.card(id)!.classList.contains('is-written'));
  assert.equal(f.progress(), '写几张都行，不用写完');
  const enter = f.card(id)!.querySelector('textarea')!.dispatch('keydown', { key: 'Enter' });
  assert.equal(enter.defaultPrevented, true, 'Enter finishes the card instead of adding a line break');
  assert.equal(f.card(id)!.querySelector('.cc-editor')!.hidden, true);
});

test('skipping is always fine, and clearing a written card takes it back out', (t) => {
  const f = setup(t);
  const [a, b] = firstTextCards(f.ids()) as [string, string];
  f.write(a, '写了');
  f.write(b, '也写了');
  assert.equal(f.progress(), '已写 2 张');
  const skip = f.card(b)!.querySelector('.cc-skip')!;
  assert.equal(skip.textContent, '清除这张');
  skip.click();
  assert.equal(f.progress(), '已写 1 张');
  assert.equal(f.card(b)!.querySelector('textarea')!.value, '');
  assert.ok(!f.card(b)!.classList.contains('is-written'));
  assert.equal(f.card(b)!.querySelector('.cc-skip')!.textContent, '跳过');
});

test('one button hands over everything written so far; partial is fine and unwritten cards are simply absent', async (t) => {
  const f = setup(t);
  const [a, b] = firstTextCards(f.ids()) as [string, string];
  f.write(a, '  头一张  ');
  f.write('free', '随便说说');
  f.send().click();
  assert.equal(f.send().textContent, '正在交出去…');
  assert.equal(f.send().disabled, true, 'no double submit');
  await flush();
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0]!.answers, [
    { cardId: a, text: '头一张' },
    { cardId: 'free', text: '随便说说' },
  ]);
  assert.ok(!f.calls[0]!.answers.some((answer) => answer.cardId === b));
  assert.equal(f.calls[0]!.characterId, 'wei-guagua');
  assert.equal(f.calls[0]!.requestId, 'request-1');
  assert.equal(f.root().querySelector('.cc-thanks')!.hidden, false);
  assert.equal(f.root().querySelector('.cc-thanks-title')!.textContent, '瓜瓜收到了你的小纸条', 'the delight moment');
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(f.doc.body.children.length, 0, 'the sheet closes by itself');
  assert.ok(!f.doc.documentElement.classList.contains('cc-open'));
});

test('after a successful hand-over the draft is spent and a new sheet starts empty', async (t) => {
  const f = setup(t);
  f.write(firstTextCards(f.ids())[0]!, '会被交出去');
  f.send().click();
  await flush();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const again = f.open();
  const root = again.element as unknown as FakeElement;
  assert.equal(root.querySelector('.cc-progress')!.textContent, '写几张都行，不用写完');
  assert.ok(root.querySelectorAll('textarea').every((area) => area.value === ''));
});

test('drafts survive closing the sheet while the page is open, live in memory only, and are never sent on close', (t) => {
  const f = setup(t);
  const id = firstTextCards(f.ids())[0]!;
  f.write(id, '先放在这里');
  f.write('free', '还有一点');
  f.root().querySelector('.cc-close')!.click();
  assert.equal(f.doc.body.children.length, 0);
  assert.equal(f.calls.length, 0, 'closing submits nothing');
  const again = f.open();
  const root = again.element as unknown as FakeElement;
  assert.equal(root.querySelector('.cc-progress')!.textContent, '已写 2 张');
  assert.equal(root.querySelector(`[data-card="${id}"] textarea`)!.value, '先放在这里');
  assert.equal(root.querySelector('[data-card="free"] textarea')!.value, '还有一点');
  assert.deepEqual(
    [...root.querySelectorAll('.cc-card')].map((c) => c.getAttribute('data-card')).slice(0, 2),
    [id, 'free'],
    'written cards come first, in the order written',
  );
  assert.deepEqual(f.storage, [], 'nothing touched localStorage');
});

test('Escape closes the sheet', (t) => {
  const f = setup(t);
  f.doc.fire('keydown', { key: 'Escape' });
  assert.equal(f.doc.body.children.length, 0);
  assert.equal(f.sheet.isOpen(), false);
});

test('换一批 draws a fresh set of cards, keeps what is written, and cycles through the whole list', (t) => {
  const f = setup(t);
  const first = f.ids();
  const kept = firstTextCards(first)[0]!;
  f.write(kept, '留下来');
  const before = f.ids();
  f.root().querySelector('.cc-shuffle')!.click();
  const second = f.ids();
  assert.equal(second[0], kept, 'a written card stays at the front');
  assert.equal(f.card(kept)!.querySelector('textarea')!.value, '留下来');
  assert.equal(second.at(-1), 'free');
  const fresh = (list: string[]) => list.filter((id) => id !== kept && id !== 'free');
  assert.ok(
    fresh(second).every((id) => !fresh(before).includes(id)),
    'a new batch shows cards that were not in the last one',
  );
  assert.equal(fresh(second).length, BATCH_SIZE);
  f.root().querySelector('.cc-shuffle')!.click();
  const third = f.ids();
  const seen = new Set([...first, ...second, ...third]);
  for (const card of COCREATION_CARDS) assert.ok(seen.has(card.id), `${card.id} shows up within a few batches`);
  assert.equal(f.progress(), '已写 1 张');
});

test('“对话卡” is two real chat bubbles; both sides are needed, up to two reply bubbles', async (t) => {
  const f = setup(t);
  while (!f.ids().includes('dialogue')) f.root().querySelector('.cc-shuffle')!.click();
  const card = f.card('dialogue')!;
  assert.ok(card.classList.contains('is-dialogue'));
  card.querySelector('.cc-face')!.click();
  assert.equal(card.querySelectorAll('.message-row.outgoing').length, 1, 'the player’s own bubble sits on the right');
  assert.equal(card.querySelectorAll('.message-row.incoming').length, 2, 'the character’s bubbles sit on the left');
  assert.equal(card.querySelector('.message-row.incoming .avatar')!.textContent, '瓜');
  const [you, reply, second] = card.querySelectorAll('textarea') as [FakeElement, FakeElement, FakeElement];
  assert.equal(you.getAttribute('aria-label'), '你说：');
  assert.equal(reply.getAttribute('aria-label'), '瓜瓜会回：1');
  assert.equal(you.getAttribute('maxlength'), '120');
  assert.equal(reply.getAttribute('maxlength'), '120');
  const secondRow = card.querySelectorAll('.message-row.incoming')[1]!;
  assert.equal(secondRow.hidden, true, 'one reply bubble to start with');

  you.type_('你今天好厉害');
  assert.equal(f.progress(), '写几张都行，不用写完', 'one side is not a card yet');
  assert.equal(card.querySelector('.cc-hint')!.hidden, false);
  assert.equal(f.send().disabled, true);
  reply.type_('才没有');
  assert.equal(f.progress(), '已写 1 张');
  assert.equal(card.querySelector('.cc-hint')!.hidden, true);

  const add = card.querySelectorAll('.cc-link').find((b) => b.textContent === cocreationCopy.addReply)!;
  add.click();
  assert.equal(secondRow.hidden, false);
  assert.equal(add.hidden, true, 'no third reply bubble');
  second.type_('哼');
  f.send().click();
  await flush();
  assert.deepEqual(f.calls[0]!.answers, [{ cardId: 'dialogue', player: '你今天好厉害', replies: ['才没有', '哼'] }]);

  const again = f.open();
  assert.equal(again.isOpen(), true);
});

test('a dialogue reply bubble can be dropped again; an empty second reply is never sent', async (t) => {
  const f = setup(t);
  while (!f.ids().includes('dialogue')) f.root().querySelector('.cc-shuffle')!.click();
  const card = f.card('dialogue')!;
  card.querySelector('.cc-face')!.click();
  const [you, reply, second] = card.querySelectorAll('textarea') as [FakeElement, FakeElement, FakeElement];
  you.type_('在吗');
  reply.type_('在');
  card
    .querySelectorAll('.cc-link')
    .find((b) => b.textContent === cocreationCopy.addReply)!
    .click();
  second.type_('又怎么了');
  card
    .querySelectorAll('.cc-link')
    .find((b) => b.textContent === cocreationCopy.dropReply)!
    .click();
  assert.equal(second.value, '');
  assert.equal(card.querySelectorAll('.message-row.incoming')[1]!.hidden, true);
  f.send().click();
  await flush();
  assert.deepEqual(f.calls[0]!.answers, [{ cardId: 'dialogue', player: '在吗', replies: ['在'] }]);
});

test('a failed send keeps the draft, explains itself, and a retry of the same content reuses the request id', async (t) => {
  let fail: unknown = new ProviderApiError(0, 'NETWORK');
  const seen: string[] = [];
  const f = setup(t, {
    api: {
      submitCocreation: async (input) => {
        seen.push(input.requestId);
        if (fail) throw fail;
        return { submissionId: 's', answered: input.answers.length, duplicate: seen.length > 1 };
      },
    },
  });
  const id = firstTextCards(f.ids())[0]!;
  f.write(id, '不要丢');
  f.send().click();
  await flush();
  assert.equal(f.root().querySelector('.cc-notice')!.hidden, false);
  assert.equal(f.root().querySelector('.cc-notice')!.textContent, cocreationCopy.errors.unknown);
  assert.equal(f.send().disabled, false, 'the button is usable again');
  assert.equal(f.send().textContent, '交给瓜瓜');
  assert.equal(f.card(id)!.querySelector('textarea')!.value, '不要丢', 'nothing is lost');
  assert.equal(f.root().querySelector('.cc-thanks')!.hidden, true);

  f.send().click();
  await flush();
  assert.deepEqual(seen, ['request-1', 'request-1'], 'the same content is the same request');
  f.write(id, '改了一点');
  f.send().click();
  await flush();
  assert.equal(seen[2], 'request-2', 'other content is a new request');

  fail = new ProviderApiError(429, 'COCREATION_RATE_LIMITED');
  f.send().click();
  await flush();
  assert.equal(f.root().querySelector('.cc-notice')!.textContent, cocreationCopy.errors.COCREATION_RATE_LIMITED);
  fail = new ProviderApiError(403, 'COCREATION_INVITE_REQUIRED');
  f.send().click();
  await flush();
  assert.equal(f.root().querySelector('.cc-notice')!.textContent, '受邀后才能参与共创。');
  fail = null;
  f.send().click();
  await flush();
  assert.equal(f.root().querySelector('.cc-thanks')!.hidden, false);
  await new Promise((resolve) => setTimeout(resolve, 5)); // the sheet closes itself after the thank-you
});

test('player text is never parsed as markup: it only ever reaches the page through textContent', (t) => {
  const f = setup(t);
  const id = firstTextCards(f.ids())[0]!;
  f.write(id, '<img src=x onerror=alert(1)>');
  // The fake DOM refuses innerHTML with content, so reaching this line already proves no component used it.
  assert.equal(f.card(id)!.querySelector('textarea')!.value, '<img src=x onerror=alert(1)>');
  assert.equal(f.root().querySelectorAll('img').length, 0);
});

// ---- the “⋯” menu --------------------------------------------------------------------------------------------------

test('the menu opens under the button, lists its items from the current access and closes on select, Escape and outside taps', (t) => {
  const doc = installFakeDom(t);
  const head = doc.createElement('div'),
    button = doc.createElement('button');
  head.append(button);
  let allowed = false,
    chosen = 0;
  const menu = mountChatMenu(button as unknown as HTMLElement, head as unknown as HTMLElement, () => [
    {
      label: '共创 · 让瓜瓜更像瓜瓜',
      sub: allowed ? '写下你心中的瓜瓜' : '受邀后可参与',
      disabled: !allowed,
      onSelect: () => chosen++,
    },
  ]);
  button.click();
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  let item = head.querySelector('.chat-menu-item')!;
  assert.equal(item.querySelector('.chat-menu-title')!.textContent, '共创 · 让瓜瓜更像瓜瓜');
  assert.equal(item.querySelector('.chat-menu-sub')!.textContent, '受邀后可参与');
  assert.equal(item.disabled, true);
  item.click();
  assert.equal(chosen, 0, 'a disabled item does nothing');
  assert.equal(menu.isOpen(), true);
  button.click();
  assert.equal(menu.isOpen(), false);
  allowed = true;
  button.click();
  item = head.querySelector('.chat-menu-item')!;
  assert.equal(item.querySelector('.chat-menu-sub')!.textContent, '写下你心中的瓜瓜');
  item.click();
  assert.equal(chosen, 1);
  assert.equal(menu.isOpen(), false);
  button.click();
  doc.fire('keydown', { key: 'Escape' });
  assert.equal(menu.isOpen(), false);
  button.click();
  doc.fire('pointerdown', { target: doc.body });
  assert.equal(menu.isOpen(), false);
});

function binding(t: test.TestContext, access: 'guest' | 'invite' | 'revoked') {
  const doc = installFakeDom(t);
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  resetCocreationDrafts();
  t.after(resetCocreationDrafts);
  const boot = syntheticProviderBootstrap();
  boot.fixture = false;
  for (const character of boot.characters) character.availability = { state: 'available', personaVersion: 1 };
  if (access !== 'guest')
    boot.access = {
      kind: 'invite',
      principalId: 'p',
      playerId: 'pl',
      worldId: 'w',
      revision: 1,
      grantId: 'g',
      status: access === 'invite' ? 'active' : 'revoked',
      lockedCharacterId: null,
      remainingReplies: null,
      reservedReplies: null,
      trialExpiresAt: null,
      canSend: access === 'invite',
    };
  const view = parseWebProviderBootstrap(boot);
  const submitted: unknown[] = [];
  const api = {
    bootstrap: async () => view,
    history: async () => ({ messages: [] }),
    submitCocreation: async (input: unknown) => {
      submitted.push(input);
      return { submissionId: 's', answered: 1, duplicate: false };
    },
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
  return { doc, api, cards, header, submitted };
}

test('in the live chat the ⋯ menu offers 共创 to an invited player and shows it disabled to a guest', async (t) => {
  for (const access of ['guest', 'invite', 'revoked'] as const) {
    const f = binding(t, access);
    const live = await LiveBinding.connect(f.api);
    live.attach({
      head: f.header as unknown as HTMLElement,
      card: (id) => f.cards.get(id)! as unknown as HTMLElement,
      name: () => '瓜瓜',
      mark: () => '瓜',
      say: () => {},
    });
    const card = f.cards.get('wei-guagua')!;
    card.querySelector('.chat-more')!.click();
    const item = card.querySelector('.chat-menu-item')!;
    assert.equal(item.querySelector('.chat-menu-title')!.textContent, '共创 · 让瓜瓜更像瓜瓜', access);
    if (access === 'invite') {
      assert.equal(item.disabled, false);
      assert.equal(item.querySelector('.chat-menu-sub')!.textContent, '写下你心中的瓜瓜');
      item.click();
      assert.equal(f.doc.body.querySelectorAll('.cc-sheet').length, 1, 'the sheet opens');
      assert.match(f.doc.body.querySelector('.cc-title')!.textContent, /让瓜瓜更像瓜瓜/);
    } else {
      assert.equal(item.disabled, true, access);
      assert.equal(item.querySelector('.chat-menu-sub')!.textContent, '受邀后可参与');
      item.click();
      assert.equal(f.doc.body.querySelectorAll('.cc-sheet').length, 0, 'a guest cannot open the sheet');
    }
  }
});

test('ProviderApi.submitCocreation posts the exact body to the provider route with the CSRF header and checks the reply', async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const api = new ProviderApi(async (url, init) => {
    requests.push({ url: String(url), init: init! });
    return Response.json({ submissionId: 's1', answered: 1, duplicate: false }, { status: 201 });
  });
  const answers: CocreationAnswer[] = [{ cardId: 'free', text: '嗯' }];
  assert.deepEqual(await api.submitCocreation({ characterId: 'jojo', requestId: 'r1', answers }), {
    submissionId: 's1',
    answered: 1,
    duplicate: false,
  });
  assert.equal(requests[0]!.url, '/api/web/provider/cocreation/submit');
  assert.equal(requests[0]!.init.method, 'POST');
  assert.deepEqual(JSON.parse(String(requests[0]!.init.body)), { characterId: 'jojo', requestId: 'r1', answers });
  const bad = new ProviderApi(async () => Response.json({ nope: true }));
  await assert.rejects(bad.submitCocreation({ characterId: 'jojo', requestId: 'r', answers }), /PROTOCOL_INVALID/);
  const limited = new ProviderApi(async () =>
    Response.json({ error: { code: 'COCREATION_RATE_LIMITED', retryAfterMs: 5 } }, { status: 429 }),
  );
  await assert.rejects(
    limited.submitCocreation({ characterId: 'jojo', requestId: 'r', answers }),
    (error: ProviderApiError) => error.code === 'COCREATION_RATE_LIMITED' && error.status === 429,
  );
});

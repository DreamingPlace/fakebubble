// Part 39b (named exception, owner decision 2026-11-18): the deck is now the five themes (each showing ONE question from the character's
// wording pool, else the plain default) and the relationship card. The tests of the removed behaviour (a shuffled batch of twelve old
// cards, the free card, the dialogue card, 换一批, the old pair card) are replaced by the tests below; every other test keeps its
// assertions, with the card ids and the "written / cards on offer" count (n / 5) updated.
// Part 47 (named exception, owner decision 2026-11-21): the fixed card 「一天」 sits right after the five themes, so the deck lists six cards
// (the card ids gain 'day') and the progress is "n / 6"; "everything answered today" now also needs a part of 一天 answered. Nothing else changed.
// Part 25a (named exception): the sheet's header is "让{name}更像{name}" (the chat ⋯ menu entry keeps "共创 · …") and the progress is
// "written / cards on offer" ("n / 6": a batch of five plus the free card) instead of "已写 n 张" / "写几张都行，不用写完".
import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveBinding } from '../../src/features/prototype/provider-binding.ts';
import { ProviderApi, ProviderApiError } from '../../src/services/provider-api.ts';
import { mountChatMenu } from '../../src/features/cocreation/chat-menu.ts';
import {
  cocreationCopy,
  openCocreationSheet,
  resetCocreationDrafts,
  type CocreationApi,
} from '../../src/features/cocreation/cocreation-sheet.ts';
import {
  COCREATION_FIELD_LABELS,
  COCREATION_TARGET_FIELDS,
  type CocreationAnswer,
} from '../../../../packages/contracts/cocreation-cards.ts';
import { COCREATION_THEMES, COCREATION_THEME_IDS } from '../../../../packages/contracts/cocreation-wordings.ts';
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
const firstTextCards = (ids: string[]) => ids.filter((id) => id.startsWith('theme-'));
const PLAIN = [
  '你眼中的瓜瓜是什么样的人？',
  '瓜瓜经历过哪些事？',
  '瓜瓜有哪些小习惯？',
  '瓜瓜常挂在嘴边的话',
  '瓜瓜最近在忙什么？',
];
const promptOf = (f: { card: (id: string) => FakeElement | null }, id: string) =>
  f.card(id)!.querySelector('.cc-prompt')!.textContent;

test('the deck is the five themes in order, each with its plain default question while the pool is empty; no routing field is ever shown', async (t) => {
  const f = setup(t);
  await flush();
  assert.deepEqual(f.ids(), [...COCREATION_THEME_IDS, 'day']);
  assert.deepEqual(
    COCREATION_THEMES.map((theme) => theme.label),
    ['认识这个人', '他的经历', '他的习惯', '他的口头禅', '他的近况'],
  );
  assert.deepEqual(
    COCREATION_THEME_IDS.map((id) => promptOf(f, id)),
    PLAIN,
  );
  const attributes = JSON.stringify([...f.root().querySelectorAll('*')].map((e) => [...e.attributes]));
  for (const field of COCREATION_TARGET_FIELDS) {
    assert.ok(!f.root().textContent.includes(field), `${field} is hidden from players`);
    assert.ok(!attributes.includes(`"${field}"`), `${field} is not in any attribute`);
  }
  for (const label of Object.values(COCREATION_FIELD_LABELS)) assert.ok(!f.root().textContent.includes(label), label);
  for (const old of ['生气时', '怎么安慰人', '被夸时', '小秘密', '怪癖', '随便写点什么', '来一段对话'])
    assert.ok(!f.root().textContent.includes(old), `the old card “${old}” is gone`);
});

test('the sheet opens with the five themes and a gentle progress hint; ↻ replaces 换一批', async (t) => {
  const f = setup(t);
  await flush();
  assert.equal(f.root().getAttribute('role'), 'dialog');
  assert.equal(f.root().querySelector('.cc-title')!.textContent, '让瓜瓜更像瓜瓜');
  assert.equal(f.ids().length, 6);
  assert.equal(f.progress(), '0 / 6');
  assert.equal(f.send().disabled, true, 'nothing written yet');
  assert.equal(f.send().textContent, '交给瓜瓜');
  assert.equal(f.root().querySelector('.cc-shuffle')!.getAttribute('aria-label'), '换一换');
  assert.ok(f.doc.documentElement.classList.contains('cc-open'));
  assert.equal(f.doc.body.children.length, 1);
});

test('each theme shows ONE question picked at random from the character’s ENABLED wordings; ↻ picks again; a written card keeps its question', async (t) => {
  const pool = {
    'theme-know': ['{name}给你的第一印象？', '{name}是个怎样的人？', '说说{name}的性格'],
    'theme-experience': [],
    'theme-habit': ['{name}睡前会做什么？'],
    'theme-catchphrase': [],
    'theme-recent': [],
  };
  const asked: string[] = [];
  const f = setup(t, {
    api: {
      cocreationWordings: async (characterId: string) => {
        asked.push(characterId);
        return { themes: pool };
      },
    },
  });
  // Until the pool has answered no question flashes: the cards show nothing, then the real question.
  assert.equal(promptOf(f, 'theme-know'), '');
  await flush();
  assert.deepEqual(asked, ['wei-guagua']);
  assert.ok(['瓜瓜给你的第一印象？', '瓜瓜是个怎样的人？', '说说瓜瓜的性格'].includes(promptOf(f, 'theme-know')));
  assert.equal(promptOf(f, 'theme-habit'), '瓜瓜睡前会做什么？', 'a pool of one shows that one');
  assert.equal(promptOf(f, 'theme-experience'), PLAIN[1], 'an empty pool falls back to the plain default');
  assert.equal(promptOf(f, 'theme-catchphrase'), PLAIN[3]);
  assert.equal(promptOf(f, 'theme-recent'), PLAIN[4]);
  // ↻ visits every wording of a pool in time, and never anything outside it.
  const seen = new Set<string>();
  for (let i = 0; i < 40; i++) {
    f.root().querySelector('.cc-shuffle')!.click();
    seen.add(promptOf(f, 'theme-know'));
  }
  assert.deepEqual([...seen].sort(), ['瓜瓜是个怎样的人？', '瓜瓜给你的第一印象？', '说说瓜瓜的性格'].sort());
  // A written card keeps the question it answers; the others change.
  const kept = promptOf(f, 'theme-know');
  f.write('theme-know', '写了');
  for (let i = 0; i < 10; i++) {
    f.root().querySelector('.cc-shuffle')!.click();
    assert.equal(promptOf(f, 'theme-know'), kept);
  }
});

test('a failing wording lookup changes nothing: the plain defaults are shown', async (t) => {
  const f = setup(t, {
    api: {
      cocreationWordings: async () => {
        throw new ProviderApiError(0, 'NETWORK');
      },
    },
  });
  await flush();
  assert.deepEqual(
    COCREATION_THEME_IDS.map((id) => promptOf(f, id)),
    PLAIN,
  );
});

test('a theme answer carries its theme and the exact question that was shown', async (t) => {
  const f = setup(t, {
    api: { cocreationWordings: async () => ({ themes: { 'theme-know': ['{name}给你的第一印象？'] } as never }) },
  });
  await flush();
  f.write('theme-know', '很会逗人');
  f.write('theme-recent', '在练鼓');
  f.send().click();
  await flush();
  assert.deepEqual(f.calls[0]!.answers, [
    { cardId: 'theme-know', text: '很会逗人', wording: '瓜瓜给你的第一印象？' },
    { cardId: 'theme-recent', text: '在练鼓', wording: '瓜瓜最近在忙什么？' },
  ]);
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
  assert.equal(f.progress(), '1 / 6');
  assert.equal(f.send().disabled, false);
  card.querySelector('.cc-done')!.click();
  assert.equal(editor.hidden, true, 'closing the editor keeps the text');
  assert.ok(card.classList.contains('is-written'));
});

test('line breaks and control characters become spaces, as chat input would refuse them; whitespace alone is not 已写', (t) => {
  const f = setup(t);
  const id = firstTextCards(f.ids())[0]!;
  f.write(id, '第一行\n第二行\t尾');
  assert.equal(f.card(id)!.querySelector('textarea')!.value, '第一行 第二行 尾');
  f.write(id, '   ');
  assert.ok(!f.card(id)!.classList.contains('is-written'));
  assert.equal(f.progress(), '0 / 6');
  const enter = f.card(id)!.querySelector('textarea')!.dispatch('keydown', { key: 'Enter' });
  assert.equal(enter.defaultPrevented, true, 'Enter finishes the card instead of adding a line break');
  assert.equal(f.card(id)!.querySelector('.cc-editor')!.hidden, true);
});

test('skipping is always fine, and clearing a written card takes it back out', (t) => {
  const f = setup(t);
  const [a, b] = firstTextCards(f.ids()) as [string, string];
  f.write(a, '写了');
  f.write(b, '也写了');
  assert.equal(f.progress(), '2 / 6');
  const skip = f.card(b)!.querySelector('.cc-skip')!;
  assert.equal(skip.textContent, '清除这张');
  skip.click();
  assert.equal(f.progress(), '1 / 6');
  assert.equal(f.card(b)!.querySelector('textarea')!.value, '');
  assert.ok(!f.card(b)!.classList.contains('is-written'));
  assert.equal(f.card(b)!.querySelector('.cc-skip')!.textContent, '跳过');
});

test('one button hands over everything written so far; partial is fine and unwritten cards are simply absent', async (t) => {
  const f = setup(t);
  await flush();
  const [a, b, c] = firstTextCards(f.ids()) as [string, string, string];
  f.write(a, '  头一张  ');
  f.write(c, '随便说说');
  f.send().click();
  assert.equal(f.send().textContent, '正在交出去…');
  assert.equal(f.send().disabled, true, 'no double submit');
  await flush();
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0]!.answers, [
    { cardId: a, text: '头一张', wording: PLAIN[0] },
    { cardId: c, text: '随便说说', wording: PLAIN[2] },
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
  assert.equal(root.querySelector('.cc-progress')!.textContent, '0 / 6');
  assert.ok(root.querySelectorAll('textarea').every((area) => area.value === ''));
});

test('drafts survive closing the sheet while the page is open, live in memory only, and are never sent on close', (t) => {
  const f = setup(t);
  const id = firstTextCards(f.ids())[0]!;
  f.write(id, '先放在这里');
  f.write('theme-recent', '还有一点');
  f.root().querySelector('.cc-close')!.click();
  assert.equal(f.doc.body.children.length, 0);
  assert.equal(f.calls.length, 0, 'closing submits nothing');
  const again = f.open();
  const root = again.element as unknown as FakeElement;
  assert.equal(root.querySelector('.cc-progress')!.textContent, '2 / 6');
  assert.equal(root.querySelector(`[data-card="${id}"] textarea`)!.value, '先放在这里');
  assert.equal(root.querySelector('[data-card="theme-recent"] textarea')!.value, '还有一点');
  assert.deepEqual(f.storage, [], 'nothing touched localStorage');
});

test('Escape closes the sheet', (t) => {
  const f = setup(t);
  f.doc.fire('keydown', { key: 'Escape' });
  assert.equal(f.doc.body.children.length, 0);
  assert.equal(f.sheet.isOpen(), false);
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

  // Part 21f (named exception): the limits are COCREATION_DAILY_LIMIT / COCREATION_IP_LIMIT with new copy and there is no
  // invite gate any more (COCREATION_RATE_LIMITED / COCREATION_INVITE_REQUIRED no longer exist).
  fail = new ProviderApiError(429, 'COCREATION_IP_LIMIT');
  f.send().click();
  await flush();
  assert.equal(f.root().querySelector('.cc-notice')!.textContent, '今天的共创次数用完了，明天再来吧');
  fail = new ProviderApiError(429, 'COCREATION_DAILY_LIMIT');
  f.send().click();
  await flush();
  // Part 21i (named exception): the limit is per card, so a refusal names "some questions" and no longer disables the
  // whole sheet; the spent cards are disabled from the usedToday lookup (tested above).
  assert.equal(f.root().querySelector('.cc-notice')!.textContent, '有的问题今天已经回答过了，明天再来吧');
  assert.equal(f.card(id)!.querySelector('textarea')!.value, '改了一点', 'the draft is still there');
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

function binding(t: test.TestContext) {
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

// Part 21f (named exception): 共创 is open to everyone; the old test asserted it disabled for a guest ("受邀后可参与").
test('in the live chat the ⋯ menu offers 共创 to every player', async (t) => {
  for (const access of ['guest'] as const) {
    const f = binding(t);
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
    const items = card.querySelectorAll('.chat-menu-item');
    // Part 25b (named exception): the ⋯ menu also holds 外观 (last); 共创 is still its first and only co-creation entry.
    assert.equal(items.length, 2, `${access}: 共创 and 外观 (no picker without a points account, no account entries)`);
    const item = items[0]!;
    // Named exception (Part 24c): the chat ⋯ menu's co-creation entry reads 一起共创角色 (was 共创 · 让{name}更像{name}), the first-time hint reads 给{name}换个大脑？或者来说说你心中的{name}～ for everyone, and the model sheet is titled 当前大脑. Only the words changed; no assertion was weakened.
    assert.equal(item.querySelector('.chat-menu-title')!.textContent, '一起共创角色', access);
    assert.equal(item.disabled, false, access);
    assert.equal(item.querySelector('.chat-menu-sub')!.textContent, '写下你心中的瓜瓜');
    item.click();
    assert.equal(f.doc.body.querySelectorAll('.cc-sheet').length, 1, `${access}: the sheet opens`);
    assert.match(f.doc.body.querySelector('.cc-title')!.textContent, /让瓜瓜更像瓜瓜/);
    f.doc.body.querySelector('.cc-close')!.click();
  }
});

// Part 21i (named exception): the day limit is per card; this replaces the Part 21f test of the single "今天已提交" banner.
test('the sheet disables the cards already answered today and keeps the rest open', async (t) => {
  const asked: string[] = [];
  const f = setup(t, {
    api: {
      submitCocreation: async () => ({ submissionId: 's', answered: 1, duplicate: false }),
      cocreationToday: async (characterId: string) => {
        asked.push(characterId);
        return { cardIds: ['theme-catchphrase', 'theme-recent'] };
      },
    },
  });
  await flush();
  assert.equal(asked.length, 1);
  const spent = ['theme-catchphrase', 'theme-recent'].map((id) => f.card(id)!);
  for (const card of spent) {
    assert.equal(card.querySelector('.cc-face')!.disabled, true);
    assert.equal(card.querySelector('.cc-cta')!.textContent, '今天已回答，明天再来');
    assert.ok(card.classList.contains('is-used'));
  }
  const open = firstTextCards(f.ids()).filter((id) => id !== 'theme-catchphrase' && id !== 'theme-recent');
  assert.ok(open.length >= 1, 'other cards are still on the deck');
  assert.equal(f.card(open[0]!)!.querySelector('.cc-face')!.disabled, false);
  assert.equal(f.card(open[0]!)!.querySelector('.cc-cta')!.textContent, '写下来');
  assert.equal(f.root().querySelector('.cc-used')!.hidden, true, 'not every card is spent');
  f.write(open[0]!, '想写');
  assert.equal(f.send().disabled, false, 'free to send a fresh card');
});

test('when every card was answered today the sheet says so and cannot send', async (t) => {
  const f = setup(t, {
    api: {
      submitCocreation: async () => ({ submissionId: 's', answered: 1, duplicate: false }),
      cocreationToday: async () => ({ cardIds: [...COCREATION_THEME_IDS, 'day-morning'] }),
    },
  });
  await flush();
  const banner = f.root().querySelector('.cc-used')!;
  assert.equal(banner.hidden, false);
  assert.equal(banner.textContent, '今天的问题都回答过了，明天再来');
  assert.equal(f.send().disabled, true);
  assert.ok(f.ids().every((id) => f.card(id)!.querySelector('.cc-face')!.disabled));
  // A failing lookup changes nothing: the sheet works as before.
  const broken = setup(t, {
    api: {
      submitCocreation: async () => ({ submissionId: 's', answered: 1, duplicate: false }),
      cocreationToday: async () => {
        throw new ProviderApiError(0, 'NETWORK');
      },
    },
  });
  await flush();
  assert.equal(broken.root().querySelector('.cc-used')!.hidden, true);
  assert.equal(broken.card(firstTextCards(broken.ids())[0]!)!.querySelector('.cc-face')!.disabled, false);
});

test('ProviderApi.cocreationToday posts the character and parses the answer strictly', async () => {
  const seen: { url: string; body: string }[] = [];
  const api = new ProviderApi(async (url, init) => {
    seen.push({ url: String(url), body: String(init?.body) });
    return Response.json(String(url).endsWith('today') ? { cardIds: ['quirk'] } : {});
  });
  assert.deepEqual(await api.cocreationToday('jojo'), { cardIds: ['quirk'] });
  assert.equal(seen[0]!.url, '/api/web/provider/cocreation/today');
  assert.deepEqual(JSON.parse(seen[0]!.body), { characterId: 'jojo' });
  const junk = new ProviderApi(async () => Response.json({ cardIds: 'yes' }));
  await assert.rejects(junk.cocreationToday('jojo'), /PROTOCOL_INVALID/);
});

test('ProviderApi.submitCocreation posts the exact body to the provider route with the CSRF header and checks the reply', async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const api = new ProviderApi(async (url, init) => {
    requests.push({ url: String(url), init: init! });
    return Response.json({ submissionId: 's1', answered: 1, duplicate: false }, { status: 201 });
  });
  const answers: CocreationAnswer[] = [{ cardId: 'theme-know', text: '嗯', wording: '你眼中的瓜瓜是什么样的人？' }];
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
    Response.json({ error: { code: 'COCREATION_DAILY_LIMIT', retryAfterMs: 5 } }, { status: 429 }),
  );
  await assert.rejects(
    limited.submitCocreation({ characterId: 'jojo', requestId: 'r', answers }),
    (error: ProviderApiError) => error.code === 'COCREATION_DAILY_LIMIT' && error.status === 429,
  );
});

test('ProviderApi.cocreationWordings posts the character and parses all five themes strictly', async () => {
  const seen: { url: string; body: string }[] = [];
  const themes = Object.fromEntries(
    COCREATION_THEME_IDS.map((id) => [id, id === 'theme-know' ? ['{name}怎么样'] : []]),
  );
  const api = new ProviderApi(async (url, init) => {
    seen.push({ url: String(url), body: String(init?.body) });
    return Response.json({ themes });
  });
  assert.deepEqual(await api.cocreationWordings('jojo'), { themes });
  assert.equal(seen[0]!.url, '/api/web/provider/cocreation/wordings');
  assert.deepEqual(JSON.parse(seen[0]!.body), { characterId: 'jojo' });
  const missing = new ProviderApi(async () => Response.json({ themes: { 'theme-know': [] } }));
  await assert.rejects(missing.cocreationWordings('jojo'), /PROTOCOL_INVALID/);
});

// ---- Part 44: one ONLINE wording per theme, a new random pick each time the cards open ----
const openWith = (t: test.TestContext, themes: Record<string, string[]>, random: () => number) => {
  const doc = installFakeDom(t);
  resetCocreationDrafts();
  t.after(resetCocreationDrafts);
  const api: CocreationApi = {
    submitCocreation: async (input) => ({ submissionId: 's', answered: input.answers.length, duplicate: false }),
    cocreationWordings: async () => ({ themes }),
  };
  const open = () =>
    openCocreationSheet({
      api,
      characterId: 'wei-guagua',
      name: NAME,
      mount: doc.body as unknown as HTMLElement,
      random,
    });
  return { open, doc };
};
const shown = (sheet: { element: unknown }, id: string) =>
  (sheet.element as FakeElement).querySelector(`[data-card="${id}"] .cc-prompt`)?.textContent ?? null;

test('Part 44: a theme shows exactly ONE of its online wordings, and a new pick is made each time the cards open', async (t) => {
  const themes = {
    'theme-know': ['{name}一', '{name}二', '{name}三', '{name}四'],
    'theme-experience': [],
    'theme-habit': ['{name}甲', '{name}乙'],
    'theme-catchphrase': [],
    'theme-recent': [],
  };
  const f = openWith(t, themes, seeded(11));
  const seen = new Set<string>();
  for (let i = 0; i < 40; i++) {
    const sheet = f.open();
    await flush();
    const root = sheet.element as unknown as FakeElement;
    // one card per theme (a theme with no online wording shows its plain default), each with exactly one question
    const ids = root
      .querySelectorAll('.cc-card')
      .map((c) => c.getAttribute('data-card')!)
      .filter((id) => id.startsWith('theme-'));
    assert.deepEqual(ids, [...COCREATION_THEME_IDS]);
    assert.equal(shown(sheet, 'theme-experience'), PLAIN[1], 'no online wording: the plain default');
    assert.equal(root.querySelectorAll('[data-card="theme-know"] .cc-prompt').length, 1);
    const know = shown(sheet, 'theme-know')!;
    assert.ok(['瓜瓜一', '瓜瓜二', '瓜瓜三', '瓜瓜四'].includes(know), know);
    assert.ok(['瓜瓜甲', '瓜瓜乙'].includes(shown(sheet, 'theme-habit')!));
    seen.add(know);
    sheet.close();
  }
  assert.ok(seen.size >= 3, `a new pick on each open visits the pool (${[...seen]})`);
});

test('Part 44: a note already written keeps its wording after the wording goes offline, and across opens', async (t) => {
  let pool: Record<string, string[]> = {
    'theme-know': ['{name}原来的问题'],
    'theme-experience': [],
    'theme-habit': ['{name}另一个'],
    'theme-catchphrase': [],
    'theme-recent': [],
  };
  const doc = installFakeDom(t);
  resetCocreationDrafts();
  t.after(resetCocreationDrafts);
  const sent: CocreationAnswer[][] = [];
  const api: CocreationApi = {
    submitCocreation: async (input) => {
      sent.push(structuredClone(input.answers));
      return { submissionId: 's', answered: input.answers.length, duplicate: false };
    },
    cocreationWordings: async () => ({ themes: pool }),
  };
  const open = () =>
    openCocreationSheet({
      api,
      characterId: 'wei-guagua',
      name: NAME,
      mount: doc.body as unknown as HTMLElement,
      random: seeded(5),
      thanksMs: 0,
    });
  let sheet = open();
  await flush();
  let root = sheet.element as unknown as FakeElement;
  root.querySelector('[data-card="theme-know"] .cc-face')!.click();
  root.querySelector('[data-card="theme-know"] textarea')!.type_('写好了');
  sheet.close();
  // the wording goes offline; the note stays tied to it, and still has its card
  pool = { ...pool, 'theme-know': [] };
  sheet = open();
  await flush();
  root = sheet.element as unknown as FakeElement;
  assert.equal(shown(sheet, 'theme-know'), '瓜瓜原来的问题', 'the written card keeps the question it answered');
  root.querySelector('.cc-send')!.click();
  await flush();
  assert.deepEqual(sent[0], [{ cardId: 'theme-know', text: '写好了', wording: '瓜瓜原来的问题' }]);
});

test('Part 44: a wording that went offline is not in the pool the sheet gets, so it is never shown; the theme falls back to its default', async (t) => {
  const f = openWith(
    t,
    { 'theme-know': [], 'theme-experience': [], 'theme-habit': [], 'theme-catchphrase': [], 'theme-recent': [] },
    seeded(3),
  );
  for (let i = 0; i < 5; i++) {
    const sheet = f.open();
    await flush();
    assert.deepEqual(
      COCREATION_THEME_IDS.map((id) => shown(sheet, id)),
      PLAIN,
    );
    sheet.close();
  }
});

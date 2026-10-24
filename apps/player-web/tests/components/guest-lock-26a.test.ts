import test from 'node:test';
import assert from 'node:assert/strict';
import { guestLockCopy, LiveBinding } from '../../src/features/prototype/provider-binding.ts';
import { ProviderApi, ProviderApiError, type AccountInfo } from '../../src/services/provider-api.ts';
import {
  syntheticProviderBootstrap,
  parseWebProviderBootstrap,
  type WebProviderBootstrap,
} from '../../../../packages/contracts/web-provider.ts';
import { FakeElement, flush, installFakeDom } from './fake-dom.ts';

/** Part 26a: an unregistered guest chats with one 小四四 (GUEST_ONE_CHARACTER_ENABLED); the page says so lightly and never sends. */
const guest: AccountInfo = {
  signupEnabled: true,
  signedIn: true,
  kind: 'guest',
  hasLogin: false,
  emailMasked: null,
  nickname: null,
};
const IDS = ['wei-guagua', 'jojo', 'chen-jimi'] as const;

function bootstrap(lockedCharacterIds?: string[]): WebProviderBootstrap {
  const boot = syntheticProviderBootstrap();
  boot.fixture = false;
  for (const character of boot.characters) character.availability = { state: 'available', personaVersion: 1 };
  if (boot.access.kind !== 'guest') throw Error('fixture');
  boot.access.canSend = true;
  boot.access.remainingReplies = 3;
  if (lockedCharacterIds) boot.access.lockedCharacterIds = lockedCharacterIds as never;
  return parseWebProviderBootstrap(boot);
}

function chat(t: test.TestContext, first: string[] | undefined, submit?: () => Promise<never>) {
  const doc = installFakeDom(t);
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  let current = first;
  let submits = 0;
  const api = {
    bootstrap: async () => bootstrap(current),
    history: async () => ({ messages: [] }),
    account: async () => guest,
    submit: async () => {
      submits++;
      return submit!();
    },
    byRequest: async () => {
      throw new Error('not expected');
    },
  } as unknown as ProviderApi;
  const cards = new Map<string, FakeElement>();
  for (const id of IDS) {
    const card = doc.createElement('article'),
      body = doc.createElement('div'),
      list = doc.createElement('div'),
      composer = doc.createElement('div'),
      box = doc.createElement('textarea'),
      send = doc.createElement('button');
    body.className = 'chat-body';
    list.className = 'sent-messages';
    body.append(list);
    card.className = 'card-slot is-chat';
    composer.className = 'composer';
    send.className = 'send-button icon-button';
    composer.append(box, send);
    card.append(body, composer);
    // The page types into the box and tells the binding; the same wiring as preview.ts.
    box.addEventListener('input', () => {
      send.disabled = !box.value.trim();
      live?.updateComposer(id);
    });
    send.addEventListener('click', () => {
      const value = box.value.trim();
      if (value) void live!.send(id, value, card as unknown as HTMLElement, () => (box.value = ''));
    });
    cards.set(id, card);
  }
  const header = doc.createElement('header');
  header.append(Object.assign(doc.createElement('span'), { className: 'head-note' }));
  const messages: string[] = [];
  let live: LiveBinding | undefined;
  return {
    doc,
    cards,
    messages,
    submits: () => submits,
    serverNow: (ids: string[] | undefined) => {
      current = ids;
    },
    async attach() {
      live = await LiveBinding.connect(api);
      live.attach({
        head: header as unknown as HTMLElement,
        card: (id) => cards.get(id)! as unknown as HTMLElement,
        name: () => '瓜瓜',
        mark: () => '瓜',
        say: (message) => messages.push(message),
      });
      return live;
    },
    note: (id: string) => cards.get(id)!.querySelector('.guest-note'),
    box: (id: string) => cards.get(id)!.querySelector('textarea')!,
    send: (id: string) => cards.get(id)!.querySelector('.send-button')!,
  };
}
const shown = (note: FakeElement | null) => !!note && !note.hidden;

test('a guest with no character yet is asked, lightly, whether this 小四四 is the one — in every chat, with no button', async (t) => {
  const f = chat(t, []);
  await f.attach();
  for (const id of IDS) {
    const note = f.note(id)!;
    assert.ok(shown(note), id);
    assert.equal(note.textContent, '新客人，就决定是这位小四四了吗？');
    assert.equal(note.querySelectorAll('button').length, 0, 'nothing to tap');
    assert.equal(note.getAttribute('role'), 'status');
    // It sits right above the composer, not inside it.
    const card = f.cards.get(id)!;
    assert.deepEqual(
      card.children.map((c) => (c as FakeElement).className.split(' ')[0]),
      ['chat-body', 'guest-note', 'composer'],
    );
  }
  assert.equal(guestLockCopy.first, '新客人，就决定是这位小四四了吗？');
});

test('a guest outside its character can type; tapping send shows 注册就能解锁全部小四四～, sends nothing and keeps the text', async (t) => {
  const f = chat(t, ['jojo']);
  await f.attach();
  assert.equal(shown(f.note('wei-guagua')), false, 'no line until it tries to send');
  assert.equal(shown(f.note('jojo')), false, 'its own character: no line at all');
  const box = f.box('wei-guagua');
  box.type_('你好呀');
  assert.equal(f.send('wei-guagua').disabled, false, 'the send button is tappable');
  f.send('wei-guagua').click();
  await flush();
  const note = f.note('wei-guagua')!;
  assert.ok(shown(note));
  assert.equal(note.textContent, '注册就能解锁全部小四四～');
  assert.equal(note.querySelector('button')!.textContent, '注册');
  assert.equal(f.submits(), 0, 'not sent');
  assert.equal(box.value, '你好呀', 'the input text is kept');
  assert.equal(f.cards.get('wei-guagua')!.querySelector('.sent-messages')!.children.length, 0, 'no phantom bubble');
  // Typing on does not rebuild the line (it would restart the fade-in and swallow a tap).
  const same = f.note('wei-guagua');
  box.type_('你好呀呀');
  assert.equal(f.note('wei-guagua'), same);
  assert.equal(same!.querySelector('button')!.parent, same);
});

test('the word 注册 opens the signup sheet', async (t) => {
  const f = chat(t, ['jojo']);
  await f.attach();
  f.box('chen-jimi').type_('在吗');
  f.send('chen-jimi').click();
  await flush();
  assert.equal(f.doc.body.querySelector('.acct-signup'), null);
  f.note('chen-jimi')!.querySelector('button')!.click();
  await flush();
  assert.ok(f.doc.body.querySelector('.acct-signup'), 'the signup sheet is open');
});

test('a stale page: GUEST_CHARACTER_LOCKED from the server shows the same prompt, never a toast, and keeps the draft', async (t) => {
  const f = chat(t, [], async () => {
    throw new ProviderApiError(403, 'GUEST_CHARACTER_LOCKED');
  });
  await f.attach();
  const box = f.box('wei-guagua');
  box.type_('还是想聊这位');
  // Meanwhile the server learnt the guest chose jojo elsewhere.
  f.serverNow(['jojo']);
  f.send('wei-guagua').click();
  await flush();
  await flush();
  const note = f.note('wei-guagua')!;
  assert.ok(shown(note));
  assert.equal(note.textContent, '注册就能解锁全部小四四～');
  assert.equal(box.value, '还是想聊这位');
  assert.deepEqual(f.messages, [], 'no generic error toast');
});

test('nothing changes for a player the rule does not apply to: no list from the server, no line, send works as before', async (t) => {
  const f = chat(t, undefined, async () => {
    throw new ProviderApiError(403, 'TRIAL_EXHAUSTED');
  });
  await f.attach();
  for (const id of IDS) assert.equal(f.note(id), null, id);
  f.box('wei-guagua').type_('你好');
  f.send('wei-guagua').click();
  await flush();
  await flush();
  assert.equal(f.submits(), 1, 'the message is sent to the server as always');
  assert.equal(f.note('wei-guagua'), null);
});

test('once the guest has sent to its character the opening question is gone', async (t) => {
  const f = chat(t, []);
  const live = await f.attach();
  assert.ok(shown(f.note('jojo')));
  f.serverNow(['jojo']);
  await (live as unknown as { refreshAccess(): Promise<void> }).refreshAccess();
  assert.equal(shown(f.note('jojo')), false);
  assert.equal(shown(f.note('wei-guagua')), false, 'another character: silent until the guest taps send');
});

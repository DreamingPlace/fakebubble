import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveBinding } from '../../src/features/prototype/provider-binding.ts';
import { ProviderApi, ProviderApiError } from '../../src/services/provider-api.ts';
import { syntheticProviderBootstrap, parseWebProviderBootstrap, type WebProviderOperation, type WebProviderMessage } from '../../../../packages/contracts/web-provider.ts';

class NodeStub {
  className = ''; textContent = ''; value = ''; disabled = false; hidden = false;
  private html = ''; readOnly = false; required = false; placeholder = ''; open = false;
  get innerHTML() { return this.html; }
  set innerHTML(value: string) {
    this.html = value;
    if (value.includes('voice-stack')) for (const name of ['.message-avatar', '.play-button', '.transcript-toggle', '.transcript']) this.node(name);
    if (value.includes('id="invite-code"')) for (const name of ['input', 'form', '.invite-cancel', '.invite-recover', 'button[type="submit"]', '.invite-state']) this.node(name);
  }
  showModal() { this.open = true; }
  close() { this.open = false; }
  scrollTop = 0; scrollHeight = 0; clientHeight = 0; dataset: Record<string,string> = {};
  parent: NodeStub | null = null; children: NodeStub[] = []; nodes = new Map<string,NodeStub>();
  listeners = new Map<string, Array<(event: { preventDefault(): void }) => void>>(); attributes = new Map<string,string>();
  classList = { add: (name: string) => { this.className += ` ${name}`; },
    contains: (name: string) => this.className.split(' ').includes(name) };
  get isConnected() { return this.parent !== null; }
  append(...nodes: NodeStub[]) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); this.parent = null; }
  replaceChildren() { for (const node of this.children) node.parent = null; this.children = []; }
  setAttribute(name: string, value: string) { this.attributes.set(name,value); }
  addEventListener(name: string, listener: (event: { preventDefault(): void }) => void) {
    this.listeners.set(name,[...(this.listeners.get(name) ?? []),listener]);
  }
  dispatch(name: string) { for (const listener of this.listeners.get(name) ?? []) listener({ preventDefault() {} }); }
  querySelector(selector: string): NodeStub | null {
    return this.nodes.get(selector) ?? this.children.find(node => selector.startsWith('.') &&
      node.classList.contains(selector.slice(1))) ?? null;
  }
  node(selector: string) { const node = new NodeStub(); this.nodes.set(selector,node); return node; }
}
const flush = () => new Promise(resolve => setTimeout(resolve,0));
function view(remaining = 3) {
  const boot = syntheticProviderBootstrap();
  // Valid executable wire shape on this offline test transport, never a live provider.
  boot.fixture = false;
  for (const character of boot.characters) character.availability = { state: 'available', personaVersion: 1 };
  if (boot.access.kind !== 'guest') throw Error('fixture');
  boot.access.remainingReplies = remaining; boot.access.canSend = remaining > 0;
  return parseWebProviderBootstrap(boot);
}
function operation(status: WebProviderOperation['status'] = 'published') {
  return { operationId:'op', requestId:'r', characterId:'wei-guagua', conversationId:'c', status,
    revision:1, acceptedAt:1, deadlineAt:300001, errorCode:null, canCancel:false, canRetry:false,
    publication:null } as WebProviderOperation;
}
async function fixture(t: test.TestContext, wait?: (ms: number) => Promise<void>) {
  const previous = { document: globalThis.document, window: globalThis.window };
  const document = Object.assign(new NodeStub(), { body: new NodeStub(), createElement: () => new NodeStub() });
  const window = new NodeStub(); Object.assign(globalThis,{ document,window });
  t.after(() => Object.assign(globalThis,previous));
  const head = new NodeStub(), note = head.node('.head-note'), card = new NodeStub();
  const list = card.node('.sent-messages'), body = card.node('.chat-body'), title = card.node('.chat-head strong');
  title.textContent = '合成人物'; card.className = 'is-chat';
  const editor = card.node('textarea'), button = card.node('.send-button'); editor.value = '保留我的草稿';
  const messages: string[] = []; let boots = 0, submits = 0, lookups = 0;
  const handlers = {
    bootstrap: async () => view(),
    redeem: async (_input: { code: string; requestId: string }) => ({ grantId: 'g', principalId: view().access.principalId, expiresAt: null, csrf: 'c', duplicate: false }),
    submit: async () => ({ operation:operation(), duplicate:false }),
    lookup: async () => operation(),
    wait: async (op: WebProviderOperation) => op,
    history: async (): Promise<{ messages: WebProviderMessage[] }> => ({ messages: [] }),
  };
  const api = { bootstrap: async () => { boots++; return handlers.bootstrap(); },
    submit: async () => { submits++; return handlers.submit(); },
    byRequest: async () => { lookups++; return handlers.lookup(); },
    waitForOperation: async (op: WebProviderOperation) => handlers.wait(op),
    history: () => handlers.history(),
    redeemInvite: (input: { code: string; requestId: string }) => handlers.redeem(input),
  } as unknown as ProviderApi;
  const binding = await LiveBinding.connect(api, wait);
  const cards = new Map([['wei-guagua',card],['jojo',new NodeStub()],['chen-jimi',new NodeStub()]]);
  binding.attach({ head:head as unknown as HTMLElement, card:id => cards.get(id)! as unknown as HTMLElement,
    name:() => '合成人物', mark:() => '合', say:message => messages.push(message) });
  const send = (accepted?: () => void) => binding.send('wei-guagua',editor.value,card as unknown as HTMLElement,accepted);
  return { head,binding,handlers,send,note,list,editor,button,messages,document,window,body,title,card,
    calls:() => ({ boots,submits,lookups }) };
}

test('stale three-reply page refreshes before sending; exhausted IP causes no POST or phantom bubble', async t => {
  const f = await fixture(t); assert.match(f.note.textContent,/3/);
  f.handlers.bootstrap = async () => view(0);
  let cleared = false; await f.send(() => { cleared = true; });
  assert.equal(f.calls().submits,0); assert.equal(f.list.children.length,0);
  assert.match(f.note.textContent,/0/); assert.equal(cleared,false);
  assert.equal(f.editor.value,'保留我的草稿'); assert.equal(f.button.disabled,true);
  assert.match(f.messages.at(-1)!,/次数已用完/);
});

test('catalog changes block stale sends and media without discarding the editor or addressing absent cards', async t => {
  const f = await fixture(t);
  f.handlers.bootstrap = async () => {
    const boot = view(); boot.characters[0]!.displayName = '已发布新名字'; return boot;
  };
  let cleared = false; await f.send(() => { cleared = true; });
  assert.equal(f.calls().submits, 0); assert.equal(cleared, false);
  assert.equal(f.editor.value, '保留我的草稿'); assert.equal(f.button.disabled, true);
  assert.match(f.note.textContent, /人物资料已更新/); assert.match(f.messages.at(-1)!, /刷新/);
  f.binding.playWelcome('wei-guagua'); assert.match(f.messages.at(-1)!, /刷新/);
});

test('unavailable published character cannot be sent even when principal quota remains', async t => {
  const f = await fixture(t);
  // Create the binding with an already unavailable character, avoiding a catalog-change rejection.
  const viewField = Object.getOwnPropertyDescriptor(f.binding, 'view')!.value;
  viewField.characters.find((item: { characterId: string }) => item.characterId === 'wei-guagua').availability =
    { state: 'unavailable', reason: 'voice_unverified' };
  f.handlers.bootstrap = async () => structuredClone(viewField);
  await f.send(); assert.equal(f.calls().submits, 0); assert.match(f.messages.at(-1)!, /暂未开放/);
});

test('quota race after preflight refreshes the header and explicitly labels a rejected message', async t => {
  const f = await fixture(t);
  f.handlers.submit = async () => { f.handlers.bootstrap = async () => view(0); throw new ProviderApiError(403,'TRIAL_EXHAUSTED'); };
  let cleared = 0; await f.send(() => { cleared++; });
  assert.equal(f.calls().submits,1); assert.equal(f.calls().lookups,0); assert.equal(cleared,0);
  assert.match(f.note.textContent,/0/); assert.equal(f.list.children.length,1);
  assert.equal(f.list.children[0]!.classList.contains('not-sent'),true);
  assert.match(f.list.children[0]!.querySelector('.message-send-state')!.textContent,/未发送/);
});

test('failed quota refresh cannot leave the stale three-reply claim visible', async t => {
  const f = await fixture(t);
  f.handlers.submit = async () => { f.handlers.bootstrap = async () => { throw Error('offline'); };
    throw new ProviderApiError(403,'TRIAL_EXHAUSTED'); };
  await f.send(); assert.doesNotMatch(f.note.textContent,/3/); assert.match(f.note.textContent,/确认/);
  assert.equal(f.button.disabled,true); assert.match(f.messages.at(-1)!,/次数已用完/);
});

test('preflight failure preserves the draft and never reaches the provider submit', async t => {
  const f = await fixture(t); f.handlers.bootstrap = async () => { throw Error('offline'); };
  let cleared = 0; await f.send(() => { cleared++; });
  assert.equal(f.calls().submits,0); assert.equal(cleared,0); assert.equal(f.list.children.length,0);
  assert.match(f.note.textContent,/确认/);
});

test('known accepted operation clears the unchanged draft only on acknowledgement, not while waiting', async t => {
  const f = await fixture(t); let resolve!: (value: ReturnType<typeof operation>) => void;
  f.handlers.wait = () => new Promise(yes => { resolve = yes; });
  let accepted = 0; const sending = f.send(() => { accepted++; }); await flush();
  assert.equal(accepted,1); await f.send(() => { throw Error('busy send must not clear a newer draft'); });
  assert.equal(f.calls().submits,1);
  f.handlers.bootstrap = async () => view(2); resolve(operation()); await sending;
  assert.match(f.note.textContent,/2/); assert.equal(f.list.children.length,0);
});

test('accepted UNKNOWN is not described as unsent or refunded and is never retried', async t => {
  const f = await fixture(t); f.handlers.wait = async () => operation('unknown');
  let accepted = 0; await f.send(() => { accepted++; });
  assert.equal(accepted,1); assert.equal(f.calls().submits,1);
  assert.match(f.messages.at(-1)!,/尚未确认/);
  assert.equal(f.list.children[0]!.classList.contains('not-sent'),false);
  assert.match(f.list.children[0]!.querySelector('.message-send-state')!.textContent,/已发送/);
});

test('returning to a background page refreshes IP quota without sending a message', async t => {
  const f = await fixture(t); f.handlers.bootstrap = async () => view(0);
  f.document.hidden = false; f.document.dispatch('visibilitychange'); await flush();
  assert.match(f.note.textContent,/0/); assert.equal(f.calls().submits,0); assert.equal(f.button.disabled,true);
});

test('preflight identity change clears the previous identity display and refuses to send its draft', async t => {
  const f = await fixture(t); f.list.append(new NodeStub());
  f.handlers.bootstrap = async () => { const next = view(); next.access.principalId = 'different'; next.access.worldId = 'different'; return next; };
  await f.send(); assert.equal(f.calls().submits,0); assert.equal(f.list.children.length,0);
  assert.match(f.messages.at(-1)!,/身份/);
});

test('lost submit receipt and lookup 404 remain uncertain, not rejected or automatically resent', async t => {
  const f = await fixture(t); let accepted = 0;
  f.handlers.submit = async () => { throw Error('lost response'); };
  f.handlers.lookup = async () => { throw new ProviderApiError(404,'NOT_FOUND'); };
  await f.send(() => { accepted++; });
  assert.equal(f.calls().submits,1); assert.equal(f.calls().lookups,1); assert.equal(accepted,0);
  assert.equal(f.list.children[0]!.classList.contains('not-sent'),false);
  assert.match(f.list.children[0]!.querySelector('.message-send-state')!.textContent,/结果待确认/);
  assert.match(f.messages.at(-1)!,/勿重复发送/);
});

test('server 502 after admission is recovered by request lookup without a second submit', async t => {
  const f = await fixture(t); let accepted = 0;
  f.handlers.submit = async () => { throw new ProviderApiError(502,'INTERNAL_ERROR'); };
  await f.send(() => { accepted++; });
  assert.equal(f.calls().submits,1); assert.equal(f.calls().lookups,1); assert.equal(accepted,1);
  assert.equal(f.list.children.length,0);
});

test('preflight preserves the first-character lock instead of attempting another provider call', async t => {
  const f = await fixture(t);
  f.handlers.bootstrap = async () => { const boot = view(); if (boot.access.kind === 'guest') boot.access.lockedCharacterId = 'jojo'; return boot; };
  await f.send(); assert.equal(f.calls().submits,0); assert.equal(f.list.children.length,0);
  assert.equal(f.button.disabled,true); assert.match(f.messages.at(-1)!,/第一个聊天/);
});


test('provider invitation freezes one request across double click and an uncertain response', async t => {
  const f = await fixture(t); const requests: string[] = [];
  let reject!: (error: Error) => void;
  f.handlers.redeem = input => { requests.push(input.requestId); return new Promise((_yes, no) => { reject = no; }); };
  const invite = f.binding as unknown as { redeem(code: string): Promise<boolean> };
  const first = invite.redeem('A'.repeat(43));
  void invite.redeem('A'.repeat(43));
  assert.equal(requests.length, 1, 'only one redeem may leave the page');
  reject(Error('response lost')); await first;
  await invite.redeem('B'.repeat(43));
  assert.equal(requests.length, 1, 'an unknown result must never become a fresh request');
  await f.send(); f.window.dispatch('focus'); await flush();
  assert.equal(f.calls().submits, 0); assert.equal(f.calls().boots, 1);
  assert.equal(f.button.disabled, true);
});


test('mounted invite dialog locks double submit, preserves intent across Escape/reopen and closes on acceptance', async t => {
  const f = await fixture(t); let finish!: (value: Awaited<ReturnType<typeof f.handlers.redeem>>) => void, requests = 0;
  f.handlers.redeem = async () => { requests++; return new Promise(yes => { finish = yes; }); };
  const open = () => { f.head.querySelector('.invite-entry')!.dispatch('click'); return f.document.body.children[0]!; };
  const first = open(), input = first.querySelector('input')!, form = first.querySelector('form')!;
  input.value = 'A'.repeat(43); form.dispatch('submit'); form.dispatch('submit');
  assert.equal(requests, 1); assert.equal(input.readOnly, true); assert.equal(input.value, '');
  assert.equal(first.querySelector('button[type="submit"]')!.disabled, true);
  first.dispatch('cancel'); assert.equal(f.document.body.children.length, 0);
  const second = open(); assert.notEqual(second, first); assert.equal(second.querySelector('input')!.readOnly, true);
  f.handlers.bootstrap = async () => {
    const next = view(); return { ...next, access: { ...next.access, kind: 'invite', grantId: 'g', status: 'active',
      canSend: true, lockedCharacterId: null, remainingReplies: null, reservedReplies: null, trialExpiresAt: null } };
  };
  finish({ grantId: 'g', principalId: view().access.principalId, expiresAt: null, csrf: 'c', duplicate: false });
  await flush(); assert.equal(f.document.body.children.length, 0); assert.match(f.note.textContent, /已解锁/);
  assert.equal(f.editor.value, '保留我的草稿'); assert.equal(requests, 1);
});

test('mounted unknown invite exposes original-request recovery, including after close; no new request', async t => {
  const f = await fixture(t); let requests = 0;
  f.handlers.redeem = async () => { requests++; throw Error('lost'); };
  f.head.querySelector('.invite-entry')!.dispatch('click');
  let dialog = f.document.body.children[0]!; dialog.querySelector('input')!.value = 'A'.repeat(43);
  dialog.querySelector('form')!.dispatch('submit'); await flush();
  assert.equal(dialog.querySelector('button[type="submit"]')!.hidden, true);
  assert.equal(dialog.querySelector('.invite-recover')!.hidden, false);
  assert.match(dialog.querySelector('.invite-state')!.textContent, /不要刷新/);
  dialog.querySelector('.invite-cancel')!.dispatch('click'); f.head.querySelector('.invite-entry')!.dispatch('click');
  dialog = f.document.body.children[0]!; assert.equal(dialog.querySelector('input')!.readOnly, true);
  dialog.querySelector('form')!.dispatch('submit'); await flush(); assert.equal(requests, 1);
});

function responseMessages(): WebProviderMessage[] {
  return ['player', 'character', 'character', 'character'].map((author, i) => ({
    messageId: 'm' + i, conversationId: 'c', characterId: 'wei-guagua', operationId: 'op',
    replyOrdinal: i ? i - 1 : null, author: author as 'player' | 'character',
    origin: i ? 'narrative' : 'input', text: '离线合成消息' + i, createdAt: i, audio: null,
  }));
}

test('waiting uses the nickname status, never an ellipsis bubble; failure restores the name', async t => {
  const f = await fixture(t); let resolve!: (v: WebProviderOperation) => void;
  f.handlers.wait = () => new Promise(yes => { resolve = yes; });
  const sending = f.send(); await flush();
  assert.equal(f.title.textContent, '正在讲话中');
  assert.equal(f.list.querySelector('.pending-row'), null);
  resolve(operation('unknown')); await sending;
  assert.equal(f.title.textContent, '合成人物'); assert.equal(f.calls().submits, 1);
});

test('new reply bubbles are paced in server order without extra submits; ordinary history is immediate', async t => {
  const pauses: { ms: number; release(): void }[] = [];
  const f = await fixture(t, ms => new Promise<void>(release => { pauses.push({ ms, release }); }));
  f.handlers.history = async () => ({ messages: responseMessages() });
  const sending = f.send(); await flush();
  assert.deepEqual(f.list.children.map(row => row.dataset.messageId), ['m0', 'm1']);
  assert.equal(f.title.textContent, '正在讲话中'); assert.equal(pauses.length, 1);
  pauses[0]!.release(); await flush();
  assert.deepEqual(f.list.children.map(row => row.dataset.messageId), ['m0', 'm1', 'm2']);
  assert.equal(pauses.length, 2); assert.ok(pauses.every(p => p.ms >= 1200 && p.ms <= 4000));
  pauses[1]!.release(); await sending;
  assert.deepEqual(f.list.children.map(row => row.dataset.messageId), ['m0', 'm1', 'm2', 'm3']);
  assert.equal(f.title.textContent, '合成人物'); assert.equal(f.calls().submits, 1);
  const next = view(); next.conversations = [{ characterId: 'wei-guagua', conversationId: 'c', lastMessageId: 'm3', unreadCount: 0 }];
  f.handlers.bootstrap = async () => next;
  const binding = f.binding as unknown as { updateView(v: ReturnType<typeof view>): boolean; loaded: Set<string>; shown: Set<string> };
  binding.updateView(next); binding.loaded.clear(); binding.shown.clear(); f.list.replaceChildren();
  await f.binding.open('wei-guagua', f.card as unknown as HTMLElement);
  assert.equal(f.list.children.length, 4); assert.equal(pauses.length, 2, 'history must not replay presentation waits');
});

test('identity change during presentation cancels remaining old messages and restores header', async t => {
  let release!: () => void;
  const f = await fixture(t, () => new Promise<void>(yes => { release = yes; }));
  f.handlers.history = async () => ({ messages: responseMessages() });
  const sending = f.send(); await flush();
  const next = view(); next.access.principalId = 'different'; next.access.worldId = 'different';
  (f.binding as unknown as { updateView(v: ReturnType<typeof view>): void }).updateView(next);
  release(); await sending;
  assert.equal(f.list.children.length, 0); assert.equal(f.title.textContent, '合成人物');
});

test('late history from an old identity is not appended after an identity switch', async t => {
  const f = await fixture(t); let resolve!: (v: { messages: WebProviderMessage[] }) => void;
  f.handlers.history = () => new Promise(yes => { resolve = yes; });
  const sending = f.send(); await flush();
  const next = view(); next.access.principalId = 'different';
  (f.binding as unknown as { updateView(v: ReturnType<typeof view>): void }).updateView(next);
  resolve({ messages: responseMessages() }); await sending;
  assert.equal(f.list.children.length, 0); assert.equal(f.calls().submits, 1);
});


test('leaving a conversation drains presentation without delays or autoplay from the hidden character', async t => {
  const f = await fixture(t, async () => { throw Error('a closed card must not pace history'); });
  let played = 0;
  (f.binding as unknown as { playMessage(): Promise<void> }).playMessage = async () => { played++; };
  f.card.className = '';
  f.handlers.history = async () => ({ messages: responseMessages().map(m => m.author === 'character' ?
    { ...m, audio: { revision:1, status:'ready', mediaId:'offline-media', durationMs:250, errorCode:null } } : m) });
  await f.send();
  assert.equal(f.list.children.length,4); assert.equal(played,0); assert.equal(f.title.textContent,'合成人物');
});

test('incoming presentation does not drag a reader away from earlier messages', async t => {
  const f = await fixture(t, async () => {});
  f.body.scrollHeight = 1000; f.body.clientHeight = 300;
  f.handlers.history = async () => { f.body.scrollTop = 40; return {messages:responseMessages()}; };
  await f.send(); assert.equal(f.list.children.length,4); assert.equal(f.body.scrollTop,40);
});

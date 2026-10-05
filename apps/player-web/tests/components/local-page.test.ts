import assert from 'node:assert/strict';
import test from 'node:test';
import { startLocalPage, type LocalPageDeps } from '../../src/features/local/local-page.ts';
import { LocalApiError } from '../../src/services/local-api.ts';
import { LocalSession } from '../../src/session/local-session.ts';
import type { SyncSink } from '../../src/data/sync-controller.ts';

class ElementStub {
  textContent = ''; value = ''; hidden = false; disabled = false; readOnly = false;
  scrollTop = 0; scrollHeight = 0;
  private listeners = new Map<string, Set<(event: any) => void>>();
  readonly children = new Map<string, ElementStub>();
  addEventListener(name: string, listener: (event: any) => void) {
    const group = this.listeners.get(name) ?? new Set(); group.add(listener); this.listeners.set(name, group);
  }
  removeEventListener(name: string, listener: (event: any) => void) { this.listeners.get(name)?.delete(listener); }
  dispatch(name: string) {
    for (const listener of this.listeners.get(name) ?? []) listener({ preventDefault() {} });
  }
  replaceChildren() { this.textContent = ''; }
  setAttribute() {}
  focus() {}
  querySelector(selector: string): ElementStub {
    let node = this.children.get(selector);
    if (!node) { node = new ElementStub(); this.children.set(selector, node); }
    return node;
  }
}

class RootStub extends ElementStub {
  innerHTML = '';
  readonly nodes = new Map<string, ElementStub>();
  querySelector(selector: string) {
    let node = this.nodes.get(selector);
    if (!node) { node = new ElementStub(); this.nodes.set(selector, node); }
    return node;
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function fixture(recovery: () => Promise<any[]>, visible: () => Promise<void> = async () => {}) {
  const documentStub = new ElementStub() as ElementStub & { hidden: boolean };
  documentStub.hidden = false;
  const previousDocument = globalThis.document;
  Object.assign(globalThis, { document: documentStub });
  const root = new RootStub();
  const session = new LocalSession();
  const sinks: SyncSink[] = [];
  let sendCalls = 0;
  let draftWrites = 0;
  const historyIds: string[] = [];
  const view = () => ({ kind: 'synthetic-local', bootstrap: {
    contractVersion: 'web-v1-local-2', instanceId: 'i', recoveryEpoch: 'e', syncCursor: '0',
    access: { principalId: 'p', playerId: 'p', worldId: 'w', kind: 'guest', canSend: true,
      retentionState: 'unstarted', trialRemaining: 3, trialExpiresAt: null },
    characters: [{ characterId: 'synthetic-1', name: '合成人物' }],
    conversations: [], activeOperations: [],
  } });
  const deps = {
    api: { bootstrap: async () => view(), history: async (id: string) => {
      historyIds.push(id); return { messages: [] };
    }, operation: async () => { throw Error('unused'); } },
    session,
    sender: { send: async () => { sendCalls++; return { kind: 'stale_generation' }; },
      lookup: async () => ({ kind: 'network_uncertain', requestId: 'old' }), recoverPending: recovery },
    pending: { get: async () => null },
    access: { refresh: async () => true },
    audio: { selectCharacter() {}, play: async () => 'stale_generation', stop() {} },
    cache: { draft: async () => null, putDraft: async () => { draftWrites++; }, putMessages: async () => {} },
    createSync: (sink: SyncSink) => {
      sinks.push(sink);
      return { start: async () => {}, stop() {}, visible };
    },
  } as unknown as LocalPageDeps;
  const dispose = startLocalPage(root as unknown as HTMLElement, deps);
  return { root, session, sinks, historyIds, sendCalls: () => sendCalls, draftWrites: () => draftWrites,
    cleanup: () => { dispose(); Object.assign(globalThis, { document: previousDocument }); } };
}

test('bootstrap blocks a new send while durable old intent is being queried', async () => {
  const pending = deferred<any[]>();
  const page = fixture(() => pending.promise);
  try {
    await flush();
    const reply = page.root.querySelector('#local-reply')!;
    reply.value = 'new message'; reply.dispatch('input');
    assert.equal(reply.disabled, true);
    page.root.querySelector('.local-composer')!.dispatch('submit');
    assert.equal(page.sendCalls(), 0);
    pending.resolve([{ kind: 'network_uncertain', requestId: 'old' }]);
    await flush();
    assert.equal(page.root.querySelector('.local-lookup')!.hidden, false);
    assert.equal(reply.disabled, true);
    page.root.querySelector('.local-composer')!.dispatch('submit');
    assert.equal(page.sendCalls(), 0);
  } finally { page.cleanup(); }
});

test('a recovered accepted first send keeps its conversation and does not erase a newer draft', async () => {
  const page = fixture(async () => [{ kind: 'accepted', operation: {
    operationId: 'op', requestId: 'old', conversationId: 'recovered-conversation',
    characterId: 'synthetic-1', status: 'queued', revision: 1,
  } }]);
  try {
    await flush();
    assert.deepEqual(page.historyIds, ['recovered-conversation']);
    assert.equal(page.draftWrites(), 0);
    assert.equal(page.root.querySelector('#local-reply')!.disabled, false);
  } finally { page.cleanup(); }
});

test('old sync and visibility 401 cannot invalidate the reconnected session', async () => {
  const lateVisibility = deferred<void>();
  let visibilityCalls = 0;
  const page = fixture(async () => [], () => ++visibilityCalls === 1 ? lateVisibility.promise : Promise.resolve());
  try {
    await flush();
    assert.equal(page.sinks.length, 1);
    (globalThis.document as unknown as ElementStub).dispatch('visibilitychange');
    page.root.querySelector('.local-reconnect')!.dispatch('click');
    await flush();
    assert.equal(page.sinks.length, 2);
    lateVisibility.reject(new LocalApiError(401, 'AUTH_REQUIRED'));
    await flush();
    page.sinks[0]!.onError?.(new LocalApiError(401, 'AUTH_REQUIRED'));
    assert.ok(page.session.currentView);
    page.sinks[1]!.onError?.(new LocalApiError(401, 'AUTH_REQUIRED'));
    assert.equal(page.session.currentView, null);
  } finally { page.cleanup(); }
});

test('local-3 guest requires trusted invite install before chat and preserves invite bootstrap on refresh', async () => {
  const documentStub = new ElementStub() as ElementStub & { hidden: boolean };
  documentStub.hidden = false;
  const previousDocument = globalThis.document;
  Object.assign(globalThis, { document: documentStub });
  const root = new RootStub(), session = new LocalSession();
  let sends = 0, bootstraps = 0;
  const base = { instanceId: 'instance', recoveryEpoch: 'epoch', syncCursor: '0', csrf: 'csrf',
    characters: [{ characterId: 'synthetic-1', name: '合成人物' }], conversations: [],
    activeOperations: [] };
  const guest = { kind: 'synthetic-local', capabilities: { invite: true }, bootstrap: {
    ...base, contractVersion: 'web-v1-local-2', access: { kind: 'guest', principalId: 'p',
      playerId: 'p', worldId: 'w', canSend: true, retentionState: 'unstarted', trialRemaining: 3,
      trialExpiresAt: null } } };
  const invited = { kind: 'synthetic-local', capabilities: { invite: true }, bootstrap: {
    ...base, contractVersion: 'web-v1-local-3', access: { kind: 'invite', principalId: 'p',
      playerId: 'p', worldId: 'w', grantId: 'grant', status: 'active', expiresAt: null,
      canSend: true, retentionState: 'protected' } } };
  const deps = { mode: 'local-3', session,
    api: { bootstrap: async () => guest, bootstrapAny: async () => (++bootstraps === 1 ? guest : invited),
      history: async () => ({ messages: [] }), operation: async () => { throw Error('unused'); } },
    invitePort: { redeem: async () => { session.install(invited as any);
      return { kind: 'accepted', principalId: 'p', grantId: 'grant' }; },
      recover: async () => { throw Error('unused'); } },
    sender: { send: async () => { sends++; return { kind: 'stale_generation' }; },
      lookup: async () => ({ kind: 'stale_generation' }), recoverPending: async () => [] },
    pending: { get: async () => null }, access: { refresh: async () => true },
    audio: { selectCharacter() {}, play: async () => 'stale_generation', stop() {} },
    cache: { draft: async () => null, putDraft: async () => {}, putMessages: async () => {} },
    createSync: () => ({ start: async () => {}, stop() {}, visible: async () => {} }),
  } as unknown as LocalPageDeps;
  const dispose = startLocalPage(root as unknown as HTMLElement, deps);
  try {
    await flush();
    assert.equal(root.querySelector('.local-card').hidden, true);
    assert.equal(root.querySelector('.local-reconnect').hidden, true);
    root.querySelector('#local-reply').value = 'must not send';
    root.querySelector('.local-composer').dispatch('submit');
    assert.equal(sends, 0);
    const form = root.querySelector('.local-invite-mount');
    form.querySelector('#invite-code').value = 'test-code';
    form.querySelector('#invite-code').dispatch('input');
    form.querySelector('.invite-form-fields').dispatch('submit');
    await flush();
    assert.equal(session.currentInviteView?.bootstrap.access.grantId, 'grant');
    assert.equal(root.querySelector('.local-card').hidden, false);
    assert.equal(root.querySelector('#local-reply').disabled, false);
    root.querySelector('.local-reconnect').dispatch('click');
    await flush();
    assert.equal(bootstraps, 2);
    assert.equal(session.currentInviteView?.bootstrap.access.grantId, 'grant');
  } finally { dispose(); Object.assign(globalThis, { document: previousDocument }); }
});

function local3TransitionFixture(options: {
  recover: () => Promise<any[]>;
  start: () => Promise<void>;
}) {
  const documentStub = new ElementStub() as ElementStub & { hidden: boolean };
  documentStub.hidden = false;
  const previousDocument = globalThis.document;
  Object.assign(globalThis, { document: documentStub });
  const root = new RootStub(), session = new LocalSession();
  let bootstraps = 0, sends = 0, stops = 0;
  const base = { instanceId: 'i', recoveryEpoch: 'e', syncCursor: '0', csrf: 'csrf',
    characters: [{ characterId: 'synthetic-1', name: '合成人物' }],
    conversations: [], activeOperations: [] };
  const access = { principalId: 'p', playerId: 'p', worldId: 'w', canSend: true };
  const guest = { kind: 'synthetic-local', capabilities: { invite: true }, bootstrap: {
    ...base, contractVersion: 'web-v1-local-2', access: { ...access, kind: 'guest',
      retentionState: 'unstarted', trialRemaining: 3, trialExpiresAt: null } } };
  const invited = { kind: 'synthetic-local', capabilities: { invite: true }, bootstrap: {
    ...base, contractVersion: 'web-v1-local-3', access: { ...access, kind: 'invite',
      grantId: 'grant', status: 'active', expiresAt: null, retentionState: 'protected' } } };
  const deps = { mode: 'local-3', session,
    api: { bootstrap: async () => guest, bootstrapAny: async () => (++bootstraps === 1 ? guest : invited),
      history: async () => ({ messages: [] }), operation: async () => { throw Error('unused'); } },
    invitePort: { redeem: async () => { session.install(invited as any);
      return { kind: 'accepted', principalId: 'p', grantId: 'grant' }; },
      recover: async () => { throw Error('unused'); } },
    sender: { send: async () => { sends++; return { kind: 'stale_generation' }; },
      lookup: async () => ({ kind: 'stale_generation' }), recoverPending: options.recover },
    pending: { get: async () => null }, access: { refresh: async () => true },
    audio: { selectCharacter() {}, play: async () => 'stale_generation', stop() {} },
    cache: { draft: async () => null, putDraft: async () => {}, putMessages: async () => {} },
    createSync: () => ({ start: options.start, stop() { stops++; }, visible: async () => {} }),
  } as unknown as LocalPageDeps;
  const dispose = startLocalPage(root as unknown as HTMLElement, deps);
  return { root, session, sends: () => sends, stops: () => stops,
    invite: async () => {
      await flush();
      const form = root.querySelector('.local-invite-mount');
      form.querySelector('#invite-code').value = 'code';
      form.querySelector('#invite-code').dispatch('input');
      form.querySelector('.invite-form-fields').dispatch('submit');
      await flush();
    },
    cleanup: () => { dispose(); Object.assign(globalThis, { document: previousDocument }); } };
}

test('trusted redemption recovery failure shows parent error, keeps invite and blocks send until reconnect', async () => {
  let recoveries = 0;
  const page = local3TransitionFixture({ recover: async () => {
    if (++recoveries === 1) throw Error('injected recovery failure');
    return [];
  }, start: async () => {} });
  try {
    await page.invite();
    assert.equal(page.session.currentInviteView?.bootstrap.access.grantId, 'grant');
    assert.equal(page.root.querySelector('.local-error').hidden, false);
    assert.equal(page.root.querySelector('#local-reply').disabled, true);
    page.root.querySelector('#local-reply').value = 'blocked';
    page.root.querySelector('.local-composer').dispatch('submit');
    assert.equal(page.sends(), 0);
    assert.equal(page.root.querySelector('.local-reconnect').hidden, false);
    page.root.querySelector('.local-reconnect').dispatch('click'); await flush();
    assert.equal(page.root.querySelector('.local-error').hidden, true);
    assert.equal(page.root.querySelector('#local-reply').disabled, false);
    assert.equal(page.session.currentInviteView?.bootstrap.access.grantId, 'grant');
  } finally { page.cleanup(); }
});

test('trusted redemption sync-start failure stops partial sync and blocks send until reconnect', async () => {
  let starts = 0;
  const page = local3TransitionFixture({ recover: async () => [], start: async () => {
    if (++starts === 1) throw Error('injected sync failure');
  } });
  try {
    await page.invite();
    assert.equal(page.root.querySelector('.local-error').hidden, false);
    assert.equal(page.root.querySelector('#local-reply').disabled, true);
    assert.equal(page.stops(), 1);
    page.root.querySelector('.local-reconnect').dispatch('click'); await flush();
    assert.equal(page.root.querySelector('.local-error').hidden, true);
    assert.equal(page.root.querySelector('#local-reply').disabled, false);
    assert.equal(page.session.currentInviteView?.bootstrap.access.grantId, 'grant');
  } finally { page.cleanup(); }
});

test('old activation failure cannot poison a reconnected invite scope or unmounted page', async () => {
  const oldStart = deferred<void>(); let starts = 0;
  const page = local3TransitionFixture({ recover: async () => [], start: () =>
    ++starts === 1 ? oldStart.promise : Promise.resolve() });
  try {
    await page.invite();
    page.root.querySelector('.local-reconnect').dispatch('click'); await flush();
    oldStart.reject(Error('late old sync failure')); await flush();
    assert.equal(page.root.querySelector('.local-error').hidden, true);
    assert.equal(page.root.querySelector('#local-reply').disabled, false);
    assert.equal(page.session.currentInviteView?.bootstrap.access.grantId, 'grant');
  } finally { page.cleanup(); }
  const lateRecovery = deferred<any[]>();
  const unmounted = local3TransitionFixture({ recover: () => lateRecovery.promise,
    start: async () => {} });
  await unmounted.invite();
  unmounted.cleanup();
  lateRecovery.reject(Error('late after unmount')); await flush();
  assert.equal(unmounted.root.querySelector('.local-error').hidden, true);
});

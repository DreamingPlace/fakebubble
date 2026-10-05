import assert from 'node:assert/strict';
import test from 'node:test';
import { startLocalPage, type LocalPageDeps } from '../../../apps/player-web/src/features/local/local-page.ts';
import { LocalSession } from '../../../apps/player-web/src/session/local-session.ts';

class NodeStub {
  textContent = '';
  value = '';
  hidden = false;
  disabled = false;
  readOnly = false;
  scrollTop = 0;
  scrollHeight = 0;
  innerHTML = '';
  private readonly nodes = new Map<string, NodeStub>();
  private readonly listeners = new Map<string, Set<(event: { preventDefault(): void }) => void>>();
  querySelector(selector: string): NodeStub {
    let node = this.nodes.get(selector);
    if (!node) { node = new NodeStub(); this.nodes.set(selector, node); }
    return node;
  }
  addEventListener(type: string, listener: (event: { preventDefault(): void }) => void) {
    const set = this.listeners.get(type) ?? new Set(); set.add(listener); this.listeners.set(type, set);
  }
  removeEventListener(type: string, listener: (event: { preventDefault(): void }) => void) {
    this.listeners.get(type)?.delete(listener);
  }
  dispatch(type: string) {
    for (const listener of this.listeners.get(type) ?? []) listener({ preventDefault() {} });
  }
  replaceChildren() { this.textContent = ''; }
  setAttribute() {}
  focus() {}
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('C local-3 accepted invite exposes activation failure and retains a recovery action', async () => {
  const priorDocument = globalThis.document;
  const documentStub = new NodeStub();
  Object.assign(globalThis, { document: documentStub });
  const root = new NodeStub(), session = new LocalSession();
  const base = { instanceId: 'c-instance', recoveryEpoch: 'c-epoch', syncCursor: '0',
    csrf: 'c-csrf', characters: [{ characterId: 'synthetic-local', name: '合成人物' }],
    conversations: [], activeOperations: [] };
  const guest = { kind: 'synthetic-local', capabilities: { invite: true }, bootstrap: {
    ...base, contractVersion: 'web-v1-local-2', access: { kind: 'guest', principalId: 'c-principal',
      playerId: 'c-player', worldId: 'c-world', canSend: true, retentionState: 'unstarted',
      trialRemaining: 3, trialExpiresAt: null } } };
  const invited = { kind: 'synthetic-local', capabilities: { invite: true }, bootstrap: {
    ...base, contractVersion: 'web-v1-local-3', access: { kind: 'invite', principalId: 'c-principal',
      playerId: 'c-player', worldId: 'c-world', grantId: 'c-grant', status: 'active',
      expiresAt: null, canSend: true, retentionState: 'protected' } } };
  let redeemCalls = 0, recoveryCalls = 0, bootstraps = 0;
  const deps = { mode: 'local-3', session,
    api: { bootstrapAny: async () => ++bootstraps === 1 ? guest : invited,
      bootstrap: async () => guest,
      history: async () => ({ messages: [] }), operation: async () => { throw Error('unused'); } },
    invitePort: { redeem: async () => { redeemCalls++; session.install(invited as any);
      return { kind: 'accepted', principalId: 'c-principal', grantId: 'c-grant' }; },
      recover: async () => { throw Error('must not repeat redemption'); } },
    sender: { send: async () => { throw Error('must not send'); },
      lookup: async () => { throw Error('unused'); },
      recoverPending: async () => {
        if (++recoveryCalls === 1) throw Error('C_SYNTHETIC_PENDING_READ_FAILURE');
        return [];
      } },
    pending: { get: async () => null }, access: { refresh: async () => true },
    audio: { selectCharacter() {}, play: async () => 'stale_generation', stop() {} },
    cache: { draft: async () => null, putDraft: async () => {}, putMessages: async () => {} },
    createSync: () => ({ start: async () => {}, stop() {}, visible: async () => {} }),
  } as unknown as LocalPageDeps;
  const dispose = startLocalPage(root as unknown as HTMLElement, deps);
  try {
    await settle();
    const form = root.querySelector('.local-invite-mount');
    form.querySelector('#invite-code').value = 'C-valid-synthetic-code';
    form.querySelector('#invite-code').dispatch('input');
    form.querySelector('.invite-form-fields').dispatch('submit');
    await settle(); await settle();
    assert.equal(redeemCalls, 1);
    assert.equal(recoveryCalls, 1);
    assert.equal(session.currentInviteView?.bootstrap.access.grantId, 'c-grant');
    assert.equal(root.querySelector('.local-reconnect').hidden, false);
    assert.equal(root.querySelector('.local-card').hidden, false);
    assert.equal(root.querySelector('#local-reply').disabled, true);
    assert.equal(root.querySelector('.local-error').hidden, false,
      'accepted invite must not leave a silent disabled chat after activation fails');
    root.querySelector('.local-reconnect').dispatch('click');
    await settle();
    assert.equal(bootstraps, 2);
    assert.equal(recoveryCalls, 2);
    assert.equal(redeemCalls, 1, 'safe reconnect must not redeem the code again');
    assert.equal(session.currentInviteView?.bootstrap.access.grantId, 'c-grant');
    assert.equal(root.querySelector('.local-error').hidden, true);
    assert.equal(root.querySelector('#local-reply').disabled, false);
  } finally { dispose(); Object.assign(globalThis, { document: priorDocument }); }
});

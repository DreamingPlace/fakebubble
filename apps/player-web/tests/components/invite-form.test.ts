import assert from 'node:assert/strict';
import test from 'node:test';
import { startInviteForm, type InviteFormInput, type InviteFormResult } from '../../src/features/invite/invite-form.ts';

class ElementStub {
  value = ''; textContent = ''; hidden = false; disabled = false; readOnly = false;
  focusCount = 0;
  private listeners = new Map<string, Set<(event: any) => void>>();
  addEventListener(name: string, listener: (event: any) => void) {
    const group = this.listeners.get(name) ?? new Set(); group.add(listener); this.listeners.set(name, group);
  }
  removeEventListener(name: string, listener: (event: any) => void) { this.listeners.get(name)?.delete(listener); }
  dispatch(name: string) { for (const listener of this.listeners.get(name) ?? []) listener({ preventDefault() {} }); }
  setAttribute() {}
  focus() { this.focusCount++; }
}
class RootStub extends ElementStub {
  innerHTML = '';
  readonly nodes = new Map<string, ElementStub>();
  querySelector(selector: string) {
    let node = this.nodes.get(selector);
    if (!node) { node = new ElementStub(); this.nodes.set(selector, node); }
    return node;
  }
  replaceChildren() { this.innerHTML = ''; }
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

test('uncertain redemption only recovers the original code and request ID', async () => {
  const first = deferred<InviteFormResult>(), second = deferred<InviteFormResult>();
  const redeemed: InviteFormInput[] = [], recovered: InviteFormInput[] = [];
  const root = new RootStub();
  let ids = 0, accepted = 0;
  const dispose = startInviteForm(root as unknown as HTMLElement, {
    synthetic: true, newRequestId: () => `id-${++ids}`,
    onAccepted: () => { accepted++; },
    port: { redeem: async input => { redeemed.push(input); return first.promise; },
      recover: async input => { recovered.push(input); return second.promise; } },
  });
  try {
    assert.match(root.innerHTML, /合成界面演示/);
    const input = root.querySelector('#invite-code')!;
    input.value = ' CODE-1 '; input.dispatch('input');
    root.querySelector('.invite-form-fields')!.dispatch('submit');
    root.querySelector('.invite-form-fields')!.dispatch('submit');
    assert.deepEqual(redeemed, [{ code: 'CODE-1', requestId: 'id-1' }]);
    assert.equal(ids, 1);
    first.resolve({ kind: 'uncertain' }); await flush();
    assert.equal(root.querySelector('.invite-form-recover')!.hidden, false);
    assert.equal(root.querySelector('.invite-form-submit')!.hidden, true);
    root.querySelector('.invite-form-fields')!.dispatch('submit');
    assert.equal(redeemed.length, 1);
    root.querySelector('.invite-form-recover')!.dispatch('click');
    root.querySelector('.invite-form-recover')!.dispatch('click');
    assert.deepEqual(recovered, [{ code: 'CODE-1', requestId: 'id-1' }]);
    second.resolve({ kind: 'accepted', principalId: 'p', grantId: 'g' }); await flush();
    assert.equal(input.value, '');
    assert.match(root.querySelector('.invite-form-status')!.textContent, /已确认/);
    assert.equal(ids, 1);
    assert.equal(accepted, 1);
  } finally { dispose(); }
});

test('lost session is terminal and never shows accepted or issues a new ID', async () => {
  const root = new RootStub(); let ids = 0, redeems = 0;
  const dispose = startInviteForm(root as unknown as HTMLElement, {
    synthetic: true, newRequestId: () => `id-${++ids}`,
    port: { redeem: async () => { redeems++; throw Error('network'); },
      recover: async () => ({ kind: 'rejected', code: 'lost-session' }) },
  });
  try {
    const input = root.querySelector('#invite-code')!;
    input.value = 'SECRET'; input.dispatch('input');
    root.querySelector('.invite-form-fields')!.dispatch('submit'); await flush();
    assert.match(root.querySelector('.invite-form-status')!.textContent, /只核对原请求/);
    root.querySelector('.invite-form-recover')!.dispatch('click'); await flush();
    assert.equal(input.value, '');
    assert.equal(root.querySelector('.invite-form-submit')!.hidden, true);
    assert.match(root.querySelector('.invite-form-status')!.textContent, /原会话已失效/);
    root.querySelector('.invite-form-fields')!.dispatch('submit');
    assert.equal(redeems, 1); assert.equal(ids, 1);
  } finally { dispose(); }
});

test('cancel clears code and ignores a late accepted response', async () => {
  const pending = deferred<InviteFormResult>();
  const root = new RootStub();
  const dispose = startInviteForm(root as unknown as HTMLElement, {
    synthetic: true, newRequestId: () => 'id-1',
    port: { redeem: async () => pending.promise, recover: async () => ({ kind: 'uncertain' }) },
  });
  try {
    const input = root.querySelector('#invite-code')!;
    input.value = 'SECRET'; input.dispatch('input');
    root.querySelector('.invite-form-fields')!.dispatch('submit');
    root.querySelector('.invite-form-cancel')!.dispatch('click');
    assert.equal(input.value, '');
    pending.resolve({ kind: 'accepted', principalId: 'p', grantId: 'g' }); await flush();
    assert.match(root.querySelector('.invite-form-status')!.textContent, /不撤销/);
    assert.doesNotMatch(root.querySelector('.invite-form-status')!.textContent, /已确认/);
  } finally { dispose(); }
});

test('unmount clears the code and late recovery cannot restore the form', async () => {
  const pending = deferred<InviteFormResult>();
  const root = new RootStub();
  const dispose = startInviteForm(root as unknown as HTMLElement, {
    synthetic: true, newRequestId: () => 'id-1',
    port: { redeem: async () => ({ kind: 'uncertain' }), recover: async () => pending.promise },
  });
  const input = root.querySelector('#invite-code')!;
  input.value = 'SECRET'; input.dispatch('input');
  root.querySelector('.invite-form-fields')!.dispatch('submit'); await flush();
  root.querySelector('.invite-form-recover')!.dispatch('click');
  dispose();
  assert.equal(input.value, '');
  assert.equal(root.innerHTML, '');
  pending.resolve({ kind: 'accepted', principalId: 'p', grantId: 'g' }); await flush();
  assert.equal(root.innerHTML, '');
});

test('IME composition does not submit an invite code', () => {
  const root = new RootStub(); let redeems = 0;
  const dispose = startInviteForm(root as unknown as HTMLElement, {
    synthetic: true, newRequestId: () => 'id-1',
    port: { redeem: async () => { redeems++; return { kind: 'uncertain' }; },
      recover: async () => ({ kind: 'uncertain' }) },
  });
  try {
    const input = root.querySelector('#invite-code')!;
    input.value = '输入中'; input.dispatch('compositionstart');
    root.querySelector('.invite-form-fields')!.dispatch('submit');
    assert.equal(redeems, 0);
    input.dispatch('compositionend');
    root.querySelector('.invite-form-fields')!.dispatch('submit');
    assert.equal(redeems, 1);
  } finally { dispose(); }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { startInviteAdminPage } from '../../src/features/admin/invite-admin-page.ts';

class ElementStub {
  value = ''; textContent = ''; hidden = false; disabled = false; readOnly = false;
  private listeners = new Map<string, Set<(event: any) => void>>();
  private button = { disabled: false };
  addEventListener(name: string, listener: (event: any) => void) {
    const group = this.listeners.get(name) ?? new Set(); group.add(listener); this.listeners.set(name, group);
  }
  removeEventListener(name: string, listener: (event: any) => void) { this.listeners.get(name)?.delete(listener); }
  dispatch(name: string) { for (const listener of this.listeners.get(name) ?? []) listener({ preventDefault() {} }); }
  querySelector(_selector: string) { return this.button; }
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
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

test('admin login and manual issue show only the server code once', async () => {
  const root = new RootStub();
  const issued: Array<{ requestId: string; redeemBy: number; batch: string; note: string | null }> = [];
  let loginToken = '', logouts = 0;
  const dispose = startInviteAdminPage(root as unknown as HTMLElement, {
    synthetic: true, newRequestId: () => 'one-id',
    port: { restore: async () => { throw Error('no session'); }, login: async token => { loginToken = token; },
      issue: async input => { issued.push(input); return { code: 'SERVER-CODE', duplicate: false }; },
      logout: async () => { logouts++; } },
  });
  try {
    assert.match(root.innerHTML, /未连接真实发码服务/);
    await flush();
    root.querySelector('#invite-admin-token')!.value = 'test-token';
    root.querySelector('.invite-admin-login')!.dispatch('submit'); await flush();
    assert.equal(loginToken, 'test-token');
    assert.equal(root.querySelector('#invite-admin-token')!.value, '');
    const deadline = root.querySelector('#invite-admin-redeem-by')!;
    deadline.value = '2099-01-01T12:00';
    root.querySelector('#invite-admin-batch')!.value = 'test-batch';
    root.querySelector('.invite-admin-issue')!.dispatch('submit');
    root.querySelector('.invite-admin-issue')!.dispatch('submit'); await flush();
    assert.equal(issued.length, 1);
    assert.equal(issued[0]!.requestId, 'one-id');
    assert.equal(issued[0]!.redeemBy, new Date(deadline.value).getTime());
    assert.equal(issued[0]!.batch, 'test-batch');
    assert.equal(issued[0]!.note, null);
    assert.equal(root.querySelector('.invite-admin-code')!.textContent, 'SERVER-CODE');
    root.querySelector('.invite-admin-logout')!.dispatch('click'); await flush();
    assert.equal(logouts, 1);
    assert.equal(root.querySelector('.invite-admin-code')!.textContent, '');
  } finally { dispose(); }
});

test('unknown issue never silently sends a second request', async () => {
  const root = new RootStub(); let issues = 0;
  const dispose = startInviteAdminPage(root as unknown as HTMLElement, {
    synthetic: true, newRequestId: () => 'one-id',
    port: { restore: async () => { throw Error('no session'); }, login: async () => {},
      issue: async () => { issues++; throw Error('lost response'); }, logout: async () => {} },
  });
  try {
    await flush();
    root.querySelector('#invite-admin-token')!.value = 'test-token';
    root.querySelector('.invite-admin-login')!.dispatch('submit'); await flush();
    root.querySelector('#invite-admin-redeem-by')!.value = '2099-01-01T12:00';
    root.querySelector('#invite-admin-batch')!.value = 'test-batch';
    root.querySelector('.invite-admin-issue')!.dispatch('submit'); await flush();
    root.querySelector('.invite-admin-issue')!.dispatch('submit');
    assert.equal(issues, 1);
    assert.match(root.querySelector('.invite-admin-status')!.textContent, /结果未确认/);
    assert.equal(root.querySelector('.invite-admin-code')!.textContent, '');
  } finally { dispose(); }
});

test('unmount clears the token and ignores a late login', async () => {
  const pending = deferred<void>();
  const root = new RootStub();
  const dispose = startInviteAdminPage(root as unknown as HTMLElement, {
    synthetic: true,
    port: { restore: async () => { throw Error('no session'); }, login: async () => pending.promise,
      issue: async () => ({ code: 'unused', duplicate: false }), logout: async () => {} },
  });
  await flush();
  const token = root.querySelector('#invite-admin-token')!;
  token.value = 'test-token';
  root.querySelector('.invite-admin-login')!.dispatch('submit');
  dispose();
  assert.equal(token.value, '');
  pending.resolve(); await flush();
  assert.equal(root.innerHTML, '');
});

test('restored admin session never requires token; duplicate issue cannot reveal a code', async () => {
  const root = new RootStub(); let logins = 0;
  const dispose = startInviteAdminPage(root as unknown as HTMLElement, {
    synthetic: false,
    port: { restore: async () => ({}), login: async () => { logins++; },
      issue: async () => ({ code: null, duplicate: true }), logout: async () => {} },
  });
  try {
    await flush();
    assert.equal(root.querySelector('.invite-admin-login')!.hidden, true);
    assert.equal(root.querySelector('.invite-admin-issue')!.hidden, false);
    root.querySelector('#invite-admin-batch')!.value = 'batch';
    root.querySelector('#invite-admin-redeem-by')!.value = '2099-01-01T12:00';
    root.querySelector('.invite-admin-issue')!.dispatch('submit'); await flush();
    assert.equal(logins, 0);
    assert.equal(root.querySelector('.invite-admin-code')!.textContent, '');
    assert.match(root.querySelector('.invite-admin-status')!.textContent, /原码无法再次显示/);
  } finally { dispose(); }
});

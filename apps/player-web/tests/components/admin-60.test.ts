import assert from 'node:assert/strict';
import test from 'node:test';
import { startAccountAdminPage } from '../../src/features/admin/account-admin-page.ts';
import { AccountAdminApi } from '../../src/services/account-admin-api.ts';
import { adminConnection, isInterrupted } from '../../src/services/admin-connection.ts';
import {
  ADMIN_DEADLINE_MS,
  ADMIN_EXPORT_DEADLINE_MS,
  ADMIN_GENERATE_DEADLINE_MS,
  ADMIN_SESSION_DEADLINE_MS,
  adminDeadline,
} from '../../src/services/invite-admin-api.ts';
import { navTree, groupPages } from '../../src/features/admin/shell/admin-nav.ts';

/**
 * Part 60: the admin console never freezes. A fake fetch that never answers (it does not even look at the abort signal) stands for a
 * stuck reply, a Cloudflare challenge or a connection that died while the tab slept.
 */
class ElementStub extends EventTarget {
  value = '';
  textContent = '';
  innerHTML = '';
  hidden = false;
  disabled = false;
  checked = false;
  type = '';
  className = '';
  dataset: Record<string, string> = {};
  children: ElementStub[] = [];
  attributes = new Map<string, string>();
  classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
  focus() {}
  contains() {
    return false;
  }
  setAttribute(key: string, value: string) {
    this.attributes.set(key, value);
  }
  hasAttribute(key: string) {
    return this.attributes.has(key);
  }
  getAttribute(key: string) {
    return this.attributes.get(key) ?? null;
  }
  removeAttribute(key: string) {
    this.attributes.delete(key);
  }
  append(...children: ElementStub[]) {
    this.children.push(...children);
  }
  replaceChildren(...children: ElementStub[]) {
    this.children = children;
    this.innerHTML = '';
  }
  fire(event = 'click') {
    this.dispatchEvent(new Event(event, { cancelable: true }));
  }
}
const PAGES = [
  'login',
  'token',
  'reset',
  'account',
  ...navTree().flatMap((group) => groupPages(group).map((item) => item.page)),
];
class RootStub extends ElementStub {
  nodes = new Map<string, ElementStub>();
  querySelector(selector: string): ElementStub {
    let node = this.nodes.get(selector);
    if (!node) {
      node = new ElementStub();
      const page = /data-page="([^"]+)"/.exec(selector),
        panel = /data-panel="([^"]+)"/.exec(selector);
      if (page) node.dataset.page = page[1]!;
      if (panel) node.dataset.panel = panel[1]!;
      this.nodes.set(selector, node);
    }
    return node;
  }
  querySelectorAll(selector: string) {
    if (selector === '[data-panel]') return PAGES.map((p) => this.querySelector(`[data-panel="${p}"]`));
    if (selector === '[data-page]' || selector === '.admin-nav [data-page]')
      return PAGES.map((p) => this.querySelector(`[data-page="${p}"]`));
    if (selector.startsWith('input[type='))
      return ['password', 'token', 'bind-code', 'bind-password', 'reset-code', 'reset-password'].map((p) =>
        this.querySelector(`#admin-${p}`),
      );
    return [...this.nodes].filter(([key]) => key.includes('button') || key.startsWith('#')).map(([, value]) => value);
  }
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const SESSION = {
  csrf: 'a'.repeat(64),
  expiresAt: 4_000_000_000_000,
  emailDeliveryAvailable: false,
  features: { chatReview: true },
  member: { id: 'owner-1', role: 'owner', label: '主管理员', email: 'o@example.com', createdAt: 1, permissions: [] },
};
/** Microtasks only: the timers of these tests are the mocked ones. */
const settle = async () => {
  for (let i = 0; i < 60; i++) await Promise.resolve();
};
const OWN_REASON = ['#admin-bind-start button', '#admin-member-issue button[type="submit"]'];
const never = () => new Promise<Response>(() => {});

function harness(t: test.TestContext, answer: (path: string, body: string | null) => Promise<Response>) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  adminConnection.reset();
  const root = new RootStub();
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'),
    originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: Object.assign(new EventTarget(), {
      createElement: () => new ElementStub(),
      createTextNode: (value: string) => Object.assign(new ElementStub(), { textContent: value }),
    }),
  });
  const calls: Array<{ path: string; body: string | null }> = [];
  const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace('/api/web/provider/admin', '');
    const body = typeof init?.body === 'string' ? init.body : null;
    calls.push({ path, body });
    return answer(path, body);
  }) as typeof fetch;
  const api = new AccountAdminApi(fetcher);
  // The component tests' small DOM cannot build the paid 预演 column, 导入角色资料 or the owner's tools: the page is given the rest.
  const port = new Proxy(api, {
    get: (target, key) => {
      if (key === 'previews' || key === 'profileImport' || key === 'owner') return undefined;
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  let dispose: (() => void) | undefined;
  t.after(() => {
    dispose?.();
    adminConnection.reset();
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  });
  return {
    root,
    api,
    calls,
    mount: () => {
      dispose = startAccountAdminPage(root as unknown as HTMLElement, port as never);
      // the page's own markup starts these hidden (the small DOM does not parse markup)
      for (const id of ['#admin-conn', '#admin-conn-retry', '#admin-access']) root.querySelector(id).hidden = true;
    },
    nav: (page: string) => root.querySelector(`[data-page="${page}"]`).fire(),
    shown: () => PAGES.find((p) => root.querySelector(`[data-panel="${p}"]`).hidden === false),
    disabledControls: () =>
      [...root.nodes]
        // disabled on their own account (no mail service; no name typed yet); everything else must be usable
        .filter(([key, node]) => node.disabled && !OWN_REASON.includes(key))
        .map(([key]) => key),
    tick: (ms: number) => t.mock.timers.tick(ms),
  };
}

const PAGE_LOADS = [
  ['overview', '总览'],
  ['characters', '角色工作台'],
  ['cast', '关系与故事'],
  ['memes', '网络梗'],
  ['cocreation', '共创收件箱'],
  ['invites', '邀请与额度'],
  ['points', '积分发放'],
  ['broadcast', '广播'],
  ['conversations', '测试对话'],
  ['feedback', '语音反馈'],
  ['costs', '消耗表'],
  ['models', '模型与价格'],
  ['system', '系统状态'],
  ['members', '管理员与权限'],
] as const;

for (const [page, name] of PAGE_LOADS) {
  test(`60: ${name} — a load that never answers locks nothing, another page opens, and after 20 s the line names the page`, async (t) => {
    const f = harness(t, (path) => (path === '/session' ? Promise.resolve(json(SESSION)) : never()));
    f.mount();
    await settle();
    // the console is up on its first page (its own load hangs); now open the page under test: its load hangs as well
    f.nav(page);
    await settle();
    assert.equal(f.shown(), page, `${name} is open while its load is in flight`);
    assert.deepEqual(f.disabledControls(), [], 'nothing on the page is disabled while a load is in flight');
    // (the next page) a click opens another page at once, even though the load has not answered
    const other = page === 'members' ? 'system' : 'members';
    f.nav(other);
    await settle();
    assert.equal(f.shown(), other, 'a nav click opens the other page while the first load is still hanging');
    assert.deepEqual(f.disabledControls(), []);
    // back to the page under test; its load hangs until the 20 s deadline
    f.nav(page);
    await settle();
    f.tick(ADMIN_DEADLINE_MS - 1);
    await settle();
    assert.equal(f.root.querySelector('#admin-conn').hidden, true, 'not before the deadline');
    f.tick(1);
    await settle();
    assert.equal(f.root.querySelector('#admin-conn').hidden, false, 'after 20 s the connection line is up');
    const line = f.root.querySelector('#admin-conn-line').textContent;
    assert.ok(line.includes(name), `the line names the page: ${line}`);
    assert.equal(/[a-z0-9]{8,}|owner-1/i.test(line), false, 'page name only: no ids');
    assert.equal(f.root.querySelector('#admin-conn-retry').hidden, false, '重试 is offered');
    assert.equal(adminConnection.state, 'interrupted');
    assert.deepEqual(f.disabledControls(), [], 'still nothing disabled after the timeout');
  });
}

test('60: 重试 loads the page again (and the way being open again does so by itself)', async (t) => {
  let hang = true;
  const f = harness(t, (path) => (path === '/session' || !hang ? Promise.resolve(json(SESSION)) : never()));
  f.mount();
  await settle();
  f.nav('system');
  await settle();
  f.tick(ADMIN_DEADLINE_MS);
  await settle();
  assert.equal(f.root.querySelector('#admin-conn-retry').hidden, false);
  const before = f.calls.length;
  hang = false;
  f.root.querySelector('#admin-conn-retry').fire();
  await settle();
  assert.ok(f.calls.length > before, '重试 sent the load again');
  assert.equal(f.root.querySelector('#admin-conn-retry').hidden, true);
});

test('60: a /session that never answers at start leaves the login form usable (and typed text stays)', async (t) => {
  const f = harness(t, () => never());
  f.mount();
  await settle();
  assert.equal(f.shown(), 'login', 'the login form is there at once');
  assert.deepEqual(f.disabledControls(), [], 'no control is disabled while the first session read is pending');
  const email = f.root.querySelector('#admin-email');
  email.value = 'a@b.cn';
  assert.equal(email.disabled, false, 'the field takes input');
  f.nav('token');
  await settle();
  assert.equal(f.shown(), 'token', 'the form can be switched while the read is pending');
  f.tick(ADMIN_SESSION_DEADLINE_MS);
  await settle();
  assert.equal(f.shown(), 'token', 'the timed-out read changes nothing: the form is simply there');
  assert.equal(f.root.querySelector('#admin-access').hidden, true, 'a timeout is not an Access problem');
  assert.deepEqual(f.disabledControls(), []);
});

test('60: a signed-in /session answer that comes late switches the login to the console', async (t) => {
  let release: (() => void) | undefined;
  const f = harness(t, (path) =>
    path === '/session'
      ? new Promise<Response>((resolve) => {
          release = () => resolve(json(SESSION));
        })
      : never(),
  );
  f.mount();
  await settle();
  assert.equal(f.shown(), 'login');
  release?.();
  await settle();
  assert.notEqual(f.shown(), 'login', 'signed in: the console replaces the form');
});

test('60: never two saves of the same form at once, and a save in flight does not stop navigation', async (t) => {
  let answerSave: (() => void) | undefined;
  const f = harness(t, (path) => {
    if (path === '/session') return Promise.resolve(json(SESSION));
    if (path === '/email/bind/start')
      return new Promise<Response>((resolve) => {
        answerSave = () => resolve(json({ challengeId: 'c', expiresAt: 1 }));
      });
    return never();
  });
  f.mount();
  await settle();
  f.root.querySelector('#admin-bind-email').value = 'new@example.com';
  f.root.querySelector('#admin-bind-start').fire('submit');
  f.root.querySelector('#admin-bind-start').fire('submit');
  await settle();
  assert.equal(
    f.calls.filter((c) => c.path === '/email/bind/start').length,
    1,
    'the second submit of the same form is not sent',
  );
  f.nav('members');
  await settle();
  assert.equal(f.shown(), 'members', 'navigation works while the save is in flight');
  assert.deepEqual(f.disabledControls(), [], 'no page-wide disable');
  answerSave?.();
  await settle();
  f.root.querySelector('#admin-bind-start').fire('submit');
  await settle();
  assert.equal(
    f.calls.filter((c) => c.path === '/email/bind/start').length,
    2,
    'after the save ended the form can save again',
  );
});

test('60: a request has a deadline by its kind: 20 s by default, a named longer one for exports and generations, never above 60 s', () => {
  assert.equal(adminDeadline('/session').ms, ADMIN_SESSION_DEADLINE_MS);
  assert.equal(adminDeadline('/system/status').ms, ADMIN_DEADLINE_MS);
  assert.equal(adminDeadline('/cocreation/list').ms, ADMIN_DEADLINE_MS);
  assert.equal(adminDeadline('/cocreation/mark-item').ms, ADMIN_DEADLINE_MS);
  assert.equal(adminDeadline('/members/issue').ms, ADMIN_DEADLINE_MS);
  assert.equal(adminDeadline('/export/file').ms, ADMIN_EXPORT_DEADLINE_MS);
  assert.equal(adminDeadline('/stats/costs-export').ms, ADMIN_EXPORT_DEADLINE_MS);
  assert.equal(adminDeadline('/cocreation/wordings/generate').ms, ADMIN_GENERATE_DEADLINE_MS);
  assert.equal(adminDeadline('/cocreation/relation/tidy').ms, ADMIN_GENERATE_DEADLINE_MS);
  for (const ms of [ADMIN_EXPORT_DEADLINE_MS, ADMIN_GENERATE_DEADLINE_MS]) assert.ok(ms <= 60_000);
});

test('60: every request kind times out as an interruption: a read at 20 s, an export at 60 s, a write is flagged as a write', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  adminConnection.reset();
  const api = new AccountAdminApi((() => never()) as unknown as typeof fetch);
  // a signed-in console: the session answered once
  const signed = new AccountAdminApi(((input: RequestInfo | URL) =>
    String(input).endsWith('/session') ? Promise.resolve(json(SESSION)) : never()) as unknown as typeof fetch);
  void api;
  await signed.restore();
  adminConnection.reset();
  const read = signed.overview();
  t.mock.timers.tick(ADMIN_DEADLINE_MS);
  await assert.rejects(read, (error: unknown) => isInterrupted(error) && error.reason === 'network');
  assert.equal(adminConnection.writePending, false, 'a read that timed out is not a lost write');
  adminConnection.reset();
  const write = signed.renewPrices('r-1');
  t.mock.timers.tick(ADMIN_DEADLINE_MS);
  await assert.rejects(write, (error: unknown) => isInterrupted(error));
  assert.equal(adminConnection.writePending, true, 'a timed-out write is unknown: the line says the edits are kept');
  adminConnection.reset();
  const exported = signed.exports.file({ kind: 'costs', format: 'csv' } as never);
  t.mock.timers.tick(ADMIN_DEADLINE_MS);
  await settle();
  assert.equal(adminConnection.state, 'ok', 'an export is still waiting after 20 s');
  t.mock.timers.tick(ADMIN_EXPORT_DEADLINE_MS - ADMIN_DEADLINE_MS);
  await assert.rejects(exported, (error: unknown) => isInterrupted(error));
});

test('60: a timed-out WRITE is unknown, not failed: it is sent again only with the SAME requestId', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  adminConnection.reset();
  const bodies: string[] = [];
  let down = true;
  const api = new AccountAdminApi(((input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith('/session')) return Promise.resolve(json(SESSION));
    bodies.push(String(init?.body));
    return down ? never() : Promise.resolve(json({ requestId: 'req-fixed', renewed: true }));
  }) as unknown as typeof fetch);
  await api.restore();
  const requestId = 'req-fixed';
  const send = () => api.renewPrices(requestId);
  adminConnection.reset();
  // what an editor does: the same closure (same id) is registered for the resend
  adminConnection.retryAfterReauth('renew-prices', () => send().catch(() => {}));
  const first = send();
  t.mock.timers.tick(ADMIN_DEADLINE_MS);
  await assert.rejects(first, (error: unknown) => isInterrupted(error));
  assert.equal(bodies.length, 1);
  assert.equal(adminConnection.waiting, 1, 'the resend waits for the way to open');
  down = false;
  await api.restore();
  await settle();
  assert.equal(bodies.length, 2, 'sent again once, by itself');
  assert.equal(JSON.parse(bodies[0]!).requestId, JSON.parse(bodies[1]!).requestId, 'with the same requestId');
  assert.equal(JSON.parse(bodies[1]!).requestId, 'req-fixed');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { adminAccountError, startAccountAdminPage } from '../../src/features/admin/account-admin-page.ts';
import {
  AccountAdminApi,
  type AccountAdminSession,
  type AdminPermission,
} from '../../src/services/account-admin-api.ts';
import { CharacterAdminClient } from '../../src/services/character-admin-api.ts';
import { InviteLocalApiError } from '../../src/services/invite-local-api.ts';

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
  focus() {}
  setAttribute(key: string, value: string) {
    this.attributes.set(key, value);
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
    if (selector === '[data-panel]')
      return ['login', 'token', 'reset', 'account', 'invites', 'characters', 'members'].map((p) =>
        this.querySelector(`[data-panel="${p}"]`),
      );
    if (selector === '[data-page]' || selector === '.admin-nav [data-page]')
      return ['login', 'token', 'reset', 'account', 'invites', 'characters', 'members'].map((p) =>
        this.querySelector(`[data-page="${p}"]`),
      );
    if (selector.startsWith('input[type='))
      return ['password', 'token', 'bind-code', 'bind-password', 'reset-code', 'reset-password'].map((p) =>
        this.querySelector(`#admin-${p}`),
      );
    return [...this.nodes].filter(([key]) => key.includes('button') || key.startsWith('#')).map(([, value]) => value);
  }
}
const descendants = (node: ElementStub): ElementStub[] => [node, ...node.children.flatMap(descendants)];
/** Part 22a: a node the view built (the stub DOM has no real selectors) found by its id attribute. */
const byId = (node: ElementStub, id: string) => descendants(node).find((n) => n.attributes.get('id') === id)!;
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const active = (
  permissions: AdminPermission[] = ['invites.issue'],
  email: string | null = null,
): AccountAdminSession => ({
  csrf: 'a'.repeat(64),
  expiresAt: 4_000_000_000_000,
  emailDeliveryAvailable: false,
  member: { id: 'admin-1', role: 'admin', label: '合成管理员', email, createdAt: 1, permissions },
});
function setup(t: test.TestContext, state: AccountAdminSession | null = null) {
  const root = new RootStub(),
    originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'),
    originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: () => new ElementStub(),
      createTextNode: (value: string) => {
        const node = new ElementStub();
        node.textContent = value;
        return node;
      },
    },
  });
  let logouts = 0;
  const creates: { requestId: string; name: string }[] = [];
  const port = {
    restore: async () => {
      if (!state) throw new InviteLocalApiError(401, 'ADMIN_UNAUTHORIZED');
      return state;
    },
    login: async (_token: string) => (state = active()),
    emailLogin: async (_email: string, _password: string) => (state = active(['invites.issue'], 'admin@example.com')),
    logout: async () => {
      logouts++;
      state = null;
    },
    bindStart: async () => ({ challengeId: 'bind', expiresAt: 1000 }),
    bindFinish: async () => active(['invites.issue'], 'admin@example.com'),
    resetStart: async () => ({ challengeId: 'reset', expiresAt: 1000 }),
    resetFinish: async () => {},
    members: async () => ({ members: [active().member], grants: [] }),
    issueMember: async () => ({ memberId: 'new', grantId: 'new-grant', token: 'b'.repeat(43), duplicate: false }),
    setPermissions: async (_id: string, permissions: AdminPermission[], _expected?: AdminPermission[]) =>
      active(permissions).member,
    revokeCredential: async () => {},
    // Part 22a: the 邀请与额度 page's client.
    inviteBatches: async (): ReturnType<AccountAdminApi['inviteBatches']> => [],
    inviteBatchDetail: async (): ReturnType<AccountAdminApi['inviteBatchDetail']> => [],
    createInviteBatch: async (input: { requestId: string; name: string }) => {
      creates.push(input);
      return { batchId: 'batch', duplicate: false, codes: ['c'.repeat(43)] };
    },
    editInviteBatch: async () => ({ batchId: 'batch', duplicate: false, holders: 0 }),
    revokeInviteBatch: async () => ({ revoked: 0 }),
    revokeTierCode: async () => {},
    revokeEntitlement: async () => {},
    characters: new CharacterAdminClient(async () => ({
      characters: [{ characterId: 'jojo', displayName: '合成人物', publishedVersion: 1, draftRevision: null }],
      deletions: [],
    })),
  };
  let dispose: (() => void) | undefined;
  t.after(() => {
    dispose?.();
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  });
  return {
    root,
    port,
    mount: () => {
      dispose = startAccountAdminPage(root as unknown as HTMLElement, port);
    },
    dispose: () => dispose?.(),
    logouts: () => logouts,
    creates: () => creates,
  };
}

test('administrator opens on email login; one-time option remains separate, no public registration or social login', async (t) => {
  const f = setup(t);
  f.mount();
  await flush();
  assert.equal(f.root.querySelector('[data-panel="login"]').hidden, false);
  assert.equal(f.root.querySelector('[data-panel="token"]').hidden, true);
  assert.match(f.root.innerHTML, /autocomplete="username"/);
  assert.ok(!/Google|Apple|注册/.test(f.root.innerHTML));
  f.root.querySelector('[data-page="token"]').fire();
  assert.equal(f.root.querySelector('[data-panel="token"]').hidden, false);
});

test('an opaque Access redirect on restore shows the Access notice, not the generic error, and the button navigates to /enter', async (t) => {
  const f = setup(t);
  f.port.restore = async () => {
    throw new InviteLocalApiError(0, 'ACCESS_REQUIRED');
  };
  const assigned: string[] = [];
  (window as unknown as { location: { assign(url: string): void } }).location = { assign: (url) => assigned.push(url) };
  f.mount();
  await flush();
  assert.equal(f.root.querySelector('#admin-access').hidden, false);
  assert.match(f.root.innerHTML, /需要先通过 Cloudflare Access 验证身份。/);
  assert.match(f.root.innerHTML, /前往验证/);
  assert.ok(!f.root.querySelector('.invite-admin-status').textContent.includes('操作结果未确认'));
  f.root.querySelector('#admin-access-enter').fire();
  assert.deepEqual(assigned, ['/api/web/provider/admin/enter']);
});

test('the two new admin error codes have their own messages, and a plain 401 hides the Access notice', () => {
  assert.equal(
    adminAccountError(new InviteLocalApiError(0, 'ACCESS_REQUIRED')),
    '需要先通过 Cloudflare Access 验证身份。',
  );
  assert.equal(
    adminAccountError(new InviteLocalApiError(403, 'ORIGIN_INVALID')),
    '请从管理页面操作，不要直接打开接口地址。',
  );
});

test('the admin transport refuses redirects; an opaqueredirect or a network TypeError is ACCESS_REQUIRED', async () => {
  const seen: (RequestInit | undefined)[] = [];
  const of = (reply: () => Promise<Response>) =>
    new AccountAdminApi((async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init);
      return reply();
    }) as typeof fetch);
  const opaque = { type: 'opaqueredirect', ok: false, status: 0, json: async () => ({}) } as unknown as Response;
  for (const reply of [async () => opaque, async () => Promise.reject(new TypeError('Failed to fetch'))])
    await assert.rejects(
      () => of(reply).restore(),
      (error: unknown) => error instanceof InviteLocalApiError && error.code === 'ACCESS_REQUIRED',
    );
  assert.ok(seen.length === 2 && seen.every((init) => init?.redirect === 'manual'));
  // A shared-transport client (characters) fails the same way, and other errors stay untouched.
  await assert.rejects(
    () => of(async () => opaque).characters.list(),
    (error: unknown) => error instanceof InviteLocalApiError && error.code === 'ACCESS_REQUIRED',
  );
  await assert.rejects(
    () => of(async () => Promise.reject(new Error('boom'))).restore(),
    (error: unknown) => error instanceof Error && error.message === 'boom',
  );
});

test('category editor preserves existing narrow grants and sends a compare-and-swap precondition', async (t) => {
  const owner = active();
  owner.member.role = 'owner';
  const f = setup(t, owner);
  const member = active(['invites.issue', 'characters.read:jojo', 'characters.edit:jojo']).member;
  f.port.members = async () => ({ members: [member], grants: [] });
  let saved: AdminPermission[] = [],
    expected: AdminPermission[] | undefined;
  f.port.setPermissions = async (_id, permissions, before) => {
    saved = permissions;
    expected = before;
    return member;
  };
  f.mount();
  await flush();
  f.root.querySelector('[data-page="members"]').fire();
  await flush();
  const item = f.root.querySelector('#admin-members-list').children[0]!;
  const save = item.children.find((child) => child.textContent.startsWith('保存 '))!;
  save.fire();
  await flush();
  assert.deepEqual(saved, ['characters.edit:jojo', 'characters.read:jojo', 'invites.issue']);
  assert.deepEqual(expected, member.permissions);
});

// Named exception (Part 22a): the old 手动生成玩家邀请码 form is replaced by the 邀请与额度 page. The same facts are asserted against
// it: management opens at once after a one-time login, a double submit makes ONE batch, nothing logs out, and disposing the
// page wipes the codes it was showing.
test('one-time login immediately allows management; unavailable email delivery cannot force registration', async (t) => {
  const f = setup(t);
  f.port.login = async () => active(['invites.issue', 'invites.manage']);
  f.mount();
  await flush();
  f.root.querySelector('[data-page="token"]').fire();
  f.root.querySelector('#admin-token').value = 'b'.repeat(43);
  f.root.querySelector('#admin-token-login').fire('submit');
  await flush();
  assert.equal(f.root.querySelector('#admin-token').value, '');
  assert.equal(f.root.querySelector('[data-panel="account"]').hidden, false);
  assert.equal(f.root.querySelector('#admin-bind-start button').disabled, true);
  f.root.querySelector('[data-page="invites"]').fire();
  await flush();
  const panel = f.root.querySelector('#admin-invites');
  assert.equal(panel.hidden, false);
  byId(panel, 'tiers-name').value = 'offline';
  byId(panel, 'admin-tiers-create').fire('submit');
  byId(panel, 'admin-tiers-create').fire('submit');
  await flush();
  assert.equal(f.creates().length, 1);
  assert.equal(f.logouts(), 0);
  // Named exception (Part 24b-1 fix): the separate once-only box of codes (#tiers-shown) is gone; the codes live in the batch's table.
  f.dispose();
  assert.equal(f.root.querySelector('#admin-secret-value').textContent, '');
  assert.equal(
    descendants(panel).some((n) => n.value === 'c'.repeat(43)),
    false,
    'no code survives the page',
  );
});

test('all permissions removed keeps account/session UI and does not call logout', async (t) => {
  const f = setup(t, active([], 'admin@example.com'));
  f.mount();
  await flush();
  assert.equal(f.root.querySelector('.admin-nav').hidden, false);
  // Named exception (Part 22a): the old issue / revoke forms are gone; the 邀请与额度 panel is hidden instead.
  assert.equal(f.root.querySelector('#admin-invites').hidden, true);
  assert.equal(f.root.querySelector('#admin-no-permissions').hidden, false);
  f.root.querySelector('[data-page="account"]').fire();
  assert.equal(f.root.querySelector('[data-panel="account"]').hidden, false);
  assert.equal(f.logouts(), 0);
});

// Named exception (Part 22a): re-expressed against the 邀请与额度 form. A rejection still refreshes the capabilities without logging
// out; and an ambiguous creation can never apply twice - a retry carries the SAME request id, so the server answers the first one.
test('permission rejection refreshes capabilities without logging out; ambiguous issuance cannot silently repeat', async (t) => {
  const f = setup(t, active(['invites.issue', 'invites.manage'], 'admin@example.com'));
  let calls = 0;
  const ids: string[] = [];
  f.port.createInviteBatch = async (input: { requestId: string }) => {
    calls++;
    ids.push(input.requestId);
    throw new InviteLocalApiError(403, 'ADMIN_PERMISSION_REQUIRED');
  };
  f.port.restore = async () =>
    calls ? active([], 'admin@example.com') : active(['invites.issue', 'invites.manage'], 'admin@example.com');
  f.mount();
  await flush();
  const panel = f.root.querySelector('#admin-invites');
  byId(panel, 'tiers-name').value = 'offline';
  byId(panel, 'admin-tiers-create').fire('submit');
  await flush();
  assert.equal(f.root.querySelector('#admin-no-permissions').hidden, false);
  assert.equal(f.logouts(), 0);
  assert.match(f.root.querySelector('.invite-admin-status').textContent, /账号仍可登录/);
  byId(panel, 'admin-tiers-create').fire('submit');
  await flush();
  assert.equal(calls, 2);
  assert.equal(ids[0], ids[1], 'the retry is the same request, never a second batch');
});

test('late login after unmount never reconstructs the page or keeps typed password', async (t) => {
  const f = setup(t);
  let done!: (value: AccountAdminSession) => void;
  f.port.emailLogin = () =>
    new Promise((resolve) => {
      done = resolve;
    });
  f.mount();
  await flush();
  f.root.querySelector('#admin-email').value = 'admin@example.com';
  f.root.querySelector('#admin-password').value = 'Offline password 123';
  f.root.querySelector('#admin-email-login').fire('submit');
  f.dispose();
  done(active());
  await flush();
  assert.equal(f.root.innerHTML, '');
  assert.equal(f.root.querySelector('#admin-password').value, '');
});

test('account transport uses admin namespace, rotates CSRF after binding and never stores secrets', async () => {
  const requests: Array<{ path: string; body: unknown; csrf: string | null }> = [];
  const api = new AccountAdminApi(async (path, options) => {
    const headers = new Headers(options?.headers);
    requests.push({
      path: String(path),
      body: options?.body ? JSON.parse(String(options.body)) : null,
      csrf: headers.get('x-csrf-token'),
    });
    assert.equal(options?.credentials, 'same-origin');
    assert.equal(options?.cache, 'no-store');
    if (String(path).endsWith('/members/permissions')) return Response.json({ member: active([]).member });
    return Response.json({
      ...active(),
      csrf: String(path).endsWith('/bind/finish') ? 'b'.repeat(64) : 'a'.repeat(64),
    });
  });
  await api.emailLogin('admin@example.com', 'Offline password 123');
  await api.bindFinish('challenge', '012345', 'Replacement 123');
  await api.setPermissions('member', []);
  assert.ok(requests.every((r) => r.path.startsWith('/api/web/provider/admin/')));
  assert.equal(requests[0]!.csrf, null);
  assert.equal(requests[1]!.csrf, 'a'.repeat(64));
  assert.equal(requests[2]!.csrf, 'b'.repeat(64));
});

test('owner explicitly confirms all-permission removal without logout and does not reissue after ambiguous response or refresh', async (t) => {
  const owner = active();
  owner.member.role = 'owner';
  const f = setup(t, owner);
  let calls = 0,
    saved: AdminPermission[] | undefined;
  f.port.setPermissions = async (_id, p) => {
    saved = p;
    return active(p).member;
  };
  f.port.issueMember = async () => {
    calls++;
    throw new Error('lost receipt');
  };
  f.mount();
  await flush();
  f.root.querySelector('[data-page="members"]').fire();
  await flush();
  let nodes = descendants(f.root.querySelector('#admin-members-list'));
  nodes.find((n) => n.textContent === '确认收回全部功能权限')!.fire();
  await flush();
  assert.deepEqual(saved, []);
  assert.equal(f.logouts(), 0);
  nodes = descendants(f.root.querySelector('#admin-members-list'));
  nodes.find((n) => n.textContent === '为此管理员签发新登录凭据')!.fire();
  await flush();
  // Named exception (Part 24b-1 fix): 刷新权限列表 is gone; the list reloads by itself after every action (the reissue above did).
  const frozen = descendants(f.root.querySelector('#admin-members-list')).find((n) =>
    n.textContent.startsWith('上次签发结果未确认'),
  )!;
  assert.equal(frozen.dataset.locked, 'true');
  frozen.fire();
  await flush();
  assert.equal(calls, 1);
});

// Named exception (Part 22a): the old per-record list is replaced by the batch list of 邀请与额度. Opening the page lists the
// batches (counts only) without logging out, and a reload keeps them. The explicit-confirmation rule for every revoke is asserted
// in invite-tiers-view.test.ts against a real DOM.
test('invitation records show independent actions; revocation requires explicit confirmation and leaves login untouched', async (t) => {
  const f = setup(t, active(['invites.manage'], 'admin@example.com'));
  f.port.inviteBatches = async () => [
    {
      id: 'batch-1',
      name: '测试批次',
      tier: 'daily_refill' as const,
      dailyAmount: 50,
      cap: 1000,
      durationDays: null,
      redeemBy: null,
      createdAt: 1,
      codes: 3,
      redeemed: 1,
      revoked: 0,
      holders: 1,
    },
  ];
  f.mount();
  await flush();
  const text = () => descendants(f.root.querySelector('#admin-invites')).map((n) => n.textContent);
  assert.ok(text().includes('测试批次'));
  assert.ok(text().some((x) => x === '每天 +50 点 · 上限 1000 点'));
  assert.ok(!text().some((x) => x.includes('@') || x.includes('admin@')), 'no player identity on the page');
  assert.equal(f.logouts(), 0);
  window.dispatchEvent(new Event('focus'));
  await flush();
  assert.ok(text().includes('测试批次'));
});

test('permission conflict is actionable and never silently reloads and overwrites', async (t) => {
  const owner = active();
  owner.member.role = 'owner';
  const f = setup(t, owner);
  let calls = 0;
  f.port.setPermissions = async () => {
    calls++;
    throw new InviteLocalApiError(409, 'ADMIN_PERMISSIONS_CONFLICT');
  };
  f.mount();
  await flush();
  f.root.querySelector('[data-page="members"]').fire();
  await flush();
  descendants(f.root.querySelector('#admin-members-list'))
    .find((n) => n.textContent.startsWith('保存 '))!
    .fire();
  await flush();
  assert.match(f.root.querySelector('.invite-admin-status').textContent, /未覆盖新权限/);
  assert.equal(calls, 1);
  assert.equal(f.logouts(), 0);
});

test('focus identity/session changes clear prior management data and secrets, but do not call logout', async (t) => {
  const owner = active();
  owner.member.role = 'owner';
  const f = setup(t, owner);
  f.mount();
  await flush();
  f.root.querySelector('[data-page="members"]').fire();
  await flush();
  assert.ok(f.root.querySelector('#admin-members-list').children.length > 0);
  f.root.querySelector('#admin-secret-value').textContent = 'local secret fixture';
  const next = active(['category.characters']);
  next.member.id = 'another-admin';
  next.csrf = 'b'.repeat(64);
  f.port.restore = async () => next;
  window.dispatchEvent(new Event('focus'));
  await flush();
  assert.equal(f.root.querySelector('#admin-members-list').children.length, 0);
  assert.equal(f.root.querySelector('#admin-secret-value').textContent, '');
  assert.equal(f.root.querySelector('[data-panel="account"]').hidden, false);
  assert.equal(f.logouts(), 0);
});

test('bound account never offers to bind later, including immediately after binding and restore', async (t) => {
  const f = setup(t, { ...active(), emailDeliveryAvailable: true });
  f.mount();
  await flush();
  assert.equal(f.root.querySelector('#admin-account-continue').textContent, '稍后绑定，进入管理');
  f.root.querySelector('#admin-bind-email').value = 'admin@example.com';
  f.root.querySelector('#admin-bind-start').fire('submit');
  await flush();
  f.root.querySelector('#admin-bind-code').value = '012345';
  f.root.querySelector('#admin-bind-password').value = 'Newpwd12';
  f.root.querySelector('#admin-bind-finish').fire('submit');
  await flush();
  f.root.querySelector('[data-page="account"]').fire();
  assert.equal(f.root.querySelector('#admin-account-continue').textContent, '进入管理');
  assert.equal(f.root.querySelector('#admin-account-info').textContent, '已绑定：admin@example.com');
  assert.equal(f.root.querySelector('#admin-bind-start').hidden, true);
});

test('all password reveal controls toggle without submitting, and navigation/disposal clears even visible passwords', async (t) => {
  const f = setup(t);
  f.mount();
  await flush();
  let logins = 0;
  f.port.emailLogin = async () => {
    logins++;
    return active();
  };
  for (const id of ['admin-password', 'admin-bind-password', 'admin-reset-password']) {
    const field = f.root.querySelector('#' + id),
      toggle = f.root.querySelector('#' + id + '-toggle');
    field.value = 'Synthetic123';
    toggle.fire();
    assert.equal(field.type, 'text');
    assert.equal(toggle.textContent, '隐藏密码');
    assert.equal(toggle.attributes.get('aria-pressed'), 'true');
    toggle.fire();
    assert.equal(field.type, 'password');
    toggle.fire();
  }
  assert.equal(logins, 0);
  f.root.querySelector('[data-page="reset"]').fire();
  for (const id of ['admin-password', 'admin-bind-password', 'admin-reset-password']) {
    const field = f.root.querySelector('#' + id);
    assert.equal(field.value, '');
    assert.equal(field.type, 'password');
    assert.equal(f.root.querySelector('#' + id + '-toggle').attributes.get('aria-pressed'), 'false');
  }
  const field = f.root.querySelector('#admin-reset-password');
  field.value = 'Synthetic123';
  f.root.querySelector('#admin-reset-password-toggle').fire();
  f.dispose();
  assert.equal(field.value, '');
  assert.equal(field.type, 'password');
});

test('six-digit numeric code fields and Unicode-aware new-password limits are present; logout clears revealed values', async (t) => {
  const f = setup(t, active([], 'admin@example.com'));
  f.mount();
  await flush();
  assert.equal(f.root.querySelector('#admin-account-continue').textContent, '进入管理');
  assert.equal((f.root.innerHTML.match(/pattern="\[0-9\]\{6\}"/g) ?? []).length, 2);
  assert.equal((f.root.innerHTML.match(/pattern=".\{8,18\}"/g) ?? []).length, 2);
  assert.ok(!f.root.innerHTML.includes('15–128'));
  f.root.querySelector('#admin-bind-password').value = 'Synthetic123';
  f.root.querySelector('#admin-bind-password-toggle').fire();
  f.root.querySelector('#admin-logout').fire();
  await flush();
  assert.equal(f.root.querySelector('#admin-bind-password').value, '');
  assert.equal(f.root.querySelector('#admin-bind-password').type, 'password');
  assert.equal(f.logouts(), 1);
});

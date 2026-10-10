import assert from 'node:assert/strict';
import test from 'node:test';
import { startAccountAdminPage } from '../../src/features/admin/account-admin-page.ts';
import type { AccountAdminSession, AdminPermission } from '../../src/services/account-admin-api.ts';
import { CharacterAdminClient } from '../../src/services/character-admin-api.ts';

// The same hand-rolled element/root stubs as account-admin-page.test.ts, trimmed to what the inbox tab needs.
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
  contains() {
    return false;
  }
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
    const pages = ['login', 'token', 'reset', 'account', 'invites', 'characters', 'cocreation', 'members'];
    if (selector === '[data-panel]') return pages.map((p) => this.querySelector(`[data-panel="${p}"]`));
    if (selector === '[data-page]' || selector === '.admin-nav [data-page]')
      return pages.map((p) => this.querySelector(`[data-page="${p}"]`));
    if (selector.startsWith('input[type='))
      return ['password', 'token', 'bind-code', 'bind-password', 'reset-code', 'reset-password'].map((p) =>
        this.querySelector(`#admin-${p}`),
      );
    return [...this.nodes].filter(([key]) => key.includes('button') || key.startsWith('#')).map(([, value]) => value);
  }
}
const descendants = (node: ElementStub): ElementStub[] => [node, ...node.children.flatMap(descendants)];
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const session = (permissions: AdminPermission[], role: 'owner' | 'admin' = 'admin'): AccountAdminSession => ({
  csrf: 'a'.repeat(64),
  expiresAt: 4_000_000_000_000,
  emailDeliveryAvailable: false,
  member: { id: 'admin-1', role, label: '合成管理员', email: 'a@example.com', createdAt: 1, permissions },
});

function setup(t: test.TestContext, state: AccountAdminSession, withInbox = true) {
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
  const calls: string[] = [];
  const port = {
    restore: async () => state,
    login: async () => state,
    emailLogin: async () => state,
    logout: async () => {},
    bindStart: async () => ({ challengeId: 'b', expiresAt: 1 }),
    bindFinish: async () => state,
    resetStart: async () => ({ challengeId: 'r', expiresAt: 1 }),
    resetFinish: async () => {},
    members: async () => ({ members: [state.member], grants: [] }),
    issueMember: async () => ({ memberId: 'n', grantId: 'g', token: 'b'.repeat(43), duplicate: false }),
    setPermissions: async (_id: string, permissions: AdminPermission[]) => ({ ...state.member, permissions }),
    revokeCredential: async () => {},
    issue: async () => ({ inviteId: 'i', code: 'c'.repeat(43), duplicate: false }),
    revokeInvite: async () => {},
    inviteRecords: async () => ({ records: [], next: null }),
    characters: new CharacterAdminClient(async () => ({
      characters: [
        { characterId: 'wei-guagua', displayName: '瓜瓜', publishedVersion: 1, draftRevision: null },
        { characterId: 'jojo', displayName: 'JOJO', publishedVersion: 1, draftRevision: null },
      ],
      deletions: [],
    })),
    ...(withInbox
      ? {
          cocreation: {
            counts: async () => {
              calls.push('counts');
              return { 'wei-guagua': 2 };
            },
            list: async () => {
              calls.push('list');
              return { items: [], next: null };
            },
            detail: async () => {
              throw new Error('unused');
            },
            setStatus: async () => ({ updated: 0, status: 'new' as const }),
            star: async () => {},
            note: async () => null,
            adopt: async () => ({ ordinal: 0, status: 'processed' as const }),
          },
        }
      : {}),
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
    calls,
    mount: async () => {
      dispose = startAccountAdminPage(root as unknown as HTMLElement, port as never);
      await flush();
    },
    tab: () => root.querySelector('[data-page="cocreation"]'),
  };
}

test('the 共创收件箱 tab appears for the owner and for read or manage, and for nobody else', async (t) => {
  for (const [label, state, visible] of [
    ['owner', session([], 'owner'), true],
    ['read', session(['cocreation.read']), true],
    ['manage', session(['cocreation.manage']), true],
    ['characters only', session(['category.characters', 'category.publication']), false],
    ['invites only', session(['invites.read']), false],
    ['nothing', session([]), false],
  ] as const)
    await t.test(label, async (sub) => {
      const f = setup(sub, state);
      await f.mount();
      assert.equal(f.tab().hidden, !visible, label);
    });
});

test('without an inbox client the page has no tab and never asks for counts', async (t) => {
  const f = setup(t, session([], 'owner'), false);
  await f.mount();
  assert.equal(f.tab().hidden, true);
  f.root.querySelector('[data-page="characters"]').fire();
  await flush();
  assert.deepEqual(f.calls, []);
});

test('opening the tab loads the inbox once; leaving it is allowed', async (t) => {
  const f = setup(t, session(['cocreation.read']));
  await f.mount();
  f.tab().fire();
  await flush();
  assert.deepEqual(f.calls, ['list']);
  assert.equal(f.root.querySelector('main').attributes.get('data-surface'), 'cocreation');
  f.root.querySelector('[data-page="account"]').fire();
  await flush();
  assert.equal(f.root.querySelector('main').attributes.get('data-surface'), 'account');
});

test('the character list asks for the unread counts first and shows the badge', async (t) => {
  const f = setup(t, session(['cocreation.read', 'category.characters']));
  await f.mount();
  f.root.querySelector('[data-page="characters"]').fire();
  await flush();
  await flush();
  assert.equal(f.calls[0], 'counts');
  const badge = descendants(f.root.querySelector('#admin-characters')).filter(
    (n) => n.className === 'cocreation-badge',
  );
  assert.equal(badge.length, 1, 'only 瓜瓜 has unread ideas');
  assert.equal(badge[0]!.textContent, '2');
});

test('a member without the permission never asks for counts and sees no badge', async (t) => {
  const f = setup(t, session(['category.characters']));
  await f.mount();
  f.root.querySelector('[data-page="characters"]').fire();
  await flush();
  await flush();
  assert.deepEqual(f.calls, []);
  assert.equal(
    descendants(f.root.querySelector('#admin-characters')).filter((n) => n.className === 'cocreation-badge').length,
    0,
  );
});

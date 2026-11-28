import assert from 'node:assert/strict';
import test from 'node:test';
import { startAccountAdminPage } from '../../src/features/admin/account-admin-page.ts';
import type { AccountAdminSession, AdminPermission } from '../../src/services/account-admin-api.ts';
import { CharacterAdminClient } from '../../src/services/character-admin-api.ts';

// The same hand-rolled element/root stubs as account-admin-cocreation.test.ts, with the 预演测试 page added.
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
    const pages = ['login', 'token', 'reset', 'account', 'invites', 'characters', 'preview', 'cocreation', 'members'];
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

const detailBody = (characterId: string) => ({
  characterId,
  published: null,
  draft: null,
  previews: [],
  previewAvailable: false,
});

function setup(t: test.TestContext) {
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
  const state = session([], 'owner');
  const reads: string[] = [];
  const gates = new Map<string, () => void>();
  let inFlight = 0,
    maxInFlight = 0,
    hold = true;
  const characters = new CharacterAdminClient(async (path) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      if (path === 'list')
        return {
          characters: [
            { characterId: 'wei-guagua', displayName: '瓜瓜', publishedVersion: 1, draftRevision: null },
            { characterId: 'jojo', displayName: 'JOJO', publishedVersion: 1, draftRevision: null },
          ],
          deletions: [],
        };
      const id = path.split('/')[0]!;
      reads.push(id);
      if (hold) await new Promise<void>((resolve) => gates.set(id, resolve));
      return detailBody(id);
    } finally {
      inFlight--;
    }
  });
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
    characters,
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
    reads,
    maxInFlight: () => maxInFlight,
    release: (id: string) => gates.get(id)?.(),
    open: () => {
      hold = false;
      for (const release of gates.values()) release();
    },
    mount: async () => {
      dispose = startAccountAdminPage(root as unknown as HTMLElement, port as never);
      await flush();
    },
    pick: (characterId: string) => {
      const row = descendants(root.querySelector('#admin-characters')).find(
        (n) => n.attributes.get('data-character') === characterId,
      );
      assert.ok(row, `${characterId} is in the picker`);
      row.fire();
    },
  };
}

// Part 24b-2 exception (named, narrow): 预演 lives inside 角色工作台 now, so the same "latest pick wins" rules are checked on the role list of
// that page (#admin-characters).
// Part 60 exception (named, narrow; both tests below): a load never queues behind another. The newest click starts its load AT ONCE and
// the older load is cancelled (its reads are aborted by the transport; this fake client has no signal, so the older read simply stays
// in flight here and its answer is dropped by the workbench's own view counter). The old assertions "never two loads at once" and "the
// later pick opens after the first read finished" described the queue Part 60 removed.
test('预演测试: a character picked while another one is still loading starts at once; the latest pick ends up open (Part 60)', async (t) => {
  const f = setup(t);
  await f.mount();
  f.root.querySelector('[data-page="characters"]').fire();
  await flush();
  await flush();
  f.pick('wei-guagua');
  await flush();
  assert.deepEqual(f.reads, ['wei-guagua'], 'the first pick starts its read');
  // The first read is still in flight: the newest click is not held back (it used to wait, then vanish, before Part 60).
  f.pick('jojo');
  await flush();
  assert.deepEqual(f.reads, ['wei-guagua', 'jojo'], 'the later pick is opened at once');
  f.release('wei-guagua');
  await flush();
  f.release('jojo');
  await flush();
  await flush();
  assert.deepEqual(f.reads, ['wei-guagua', 'jojo'], 'nothing is read again after the answers');
  assert.equal(f.root.querySelector('.invite-admin-status').textContent.includes('请等待'), false);
});

test('预演测试: of several clicks during one load the latest is the one that stays open, never a stale pick (Part 60)', async (t) => {
  const f = setup(t);
  await f.mount();
  f.root.querySelector('[data-page="characters"]').fire();
  await flush();
  await flush();
  f.pick('wei-guagua');
  await flush();
  f.pick('jojo');
  f.pick('wei-guagua');
  f.pick('jojo');
  await flush();
  assert.equal(f.reads.at(-1), 'jojo', 'the newest click is the last one read');
  f.release('wei-guagua');
  await flush();
  f.release('jojo');
  await flush();
  await flush();
  assert.equal(f.reads.at(-1), 'jojo', 'a late answer of an older pick starts nothing new');
});

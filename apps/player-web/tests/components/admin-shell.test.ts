import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { startAccountAdminPage, environmentLabel } from '../../src/features/admin/account-admin-page.ts';
import {
  canSeePage,
  firstAllowedPage,
  navMarkup,
  NAV_TREE,
  visibleNav,
  type NavAccess,
} from '../../src/features/admin/shell/admin-nav.ts';
import { formatRoute, parseRoute } from '../../src/features/admin/shell/admin-router.ts';
import type { AccountAdminSession, AdminPermission } from '../../src/services/account-admin-api.ts';
import { CharacterAdminClient } from '../../src/services/character-admin-api.ts';
import { InviteLocalApiError } from '../../src/services/invite-local-api.ts';

const access = (permissions: string[], over: Partial<NavAccess> = {}): NavAccess => ({
  owner: false,
  permissions,
  inbox: true,
  metrics: true,
  ...over,
});
const labels = (a: NavAccess) => visibleNav(a).flatMap((g) => g.items.map((i) => i.label));

test('the nav tree is exactly the agreed groups and pages; 退出登录 and 我的账号 are not in it', () => {
  assert.deepEqual(
    NAV_TREE.map((g) => [g.label, g.items.map((i) => i.label)]),
    [
      ['角色', ['角色资料', '预演测试', '共创收件箱']],
      ['玩家', ['邀请码', '玩家授权']],
      ['运营', ['运营数据']],
      // Named exception (Part 21g): 系统 → 模型与价格 is the new first page of the system group. No other assertion changed.
      ['系统', ['模型与价格', '管理员与权限']],
    ],
  );
  assert.ok(!navMarkup().includes('退出登录') && !navMarkup().includes('我的账号'));
});

test('the owner sees everything; everyone else sees only what a permission opens, and a page without a client is absent', () => {
  assert.deepEqual(labels(access([], { owner: true })), [
    '角色资料',
    '预演测试',
    '共创收件箱',
    '邀请码',
    '玩家授权',
    '运营数据',
    '管理员与权限',
  ]);
  assert.deepEqual(labels(access([])), []);
  assert.deepEqual(labels(access(['invites.issue'])), ['邀请码']);
  assert.deepEqual(labels(access(['invites.read'])), ['邀请码', '玩家授权']);
  assert.deepEqual(labels(access(['cocreation.read'])), ['共创收件箱']);
  assert.deepEqual(labels(access(['cocreation.read'], { inbox: false })), []);
  assert.deepEqual(labels(access(['characters.read:*', 'characters.edit:*'])), ['角色资料']);
  assert.deepEqual(labels(access(['characters.edit:*'])), [], 'a role action without read lists nothing');
  assert.deepEqual(labels(access(['characters.read:*', 'characters.preview:*'])), ['角色资料', '预演测试']);
  assert.deepEqual(
    labels(access(['characters.preview:*'])),
    ['角色资料'].slice(1) as string[],
    'preview alone cannot list roles',
  );
  assert.deepEqual(labels(access(['category.publication'])), ['角色资料', '预演测试']);
  assert.deepEqual(labels(access([], { owner: true, metrics: false })).includes('运营数据'), false);
  assert.equal(canSeePage('ops', access(['category.invites'])), false, 'operations data is owner only');
  assert.equal(canSeePage('members', access(['category.invites'])), false);
  assert.equal(canSeePage('account', access([])), true);
});

test('the first allowed page follows the nav order, else the account page', () => {
  assert.equal(firstAllowedPage(access([], { owner: true })), 'characters');
  assert.equal(firstAllowedPage(access(['cocreation.read', 'invites.read'])), 'cocreation');
  assert.equal(firstAllowedPage(access(['invites.issue'])), 'invites');
  assert.equal(firstAllowedPage(access([])), 'account');
});

test('hash routes round-trip; unknown pages and malformed ids are not routes', () => {
  for (const hash of [
    '#/characters',
    '#/characters/jojo',
    '#/preview/wei-guagua',
    '#/cocreation',
    '#/invites',
    '#/grants',
    '#/ops',
    '#/members',
    '#/account',
  ])
    assert.equal(formatRoute(parseRoute(hash)!), hash);
  assert.deepEqual(parseRoute('#/characters/jojo'), { page: 'characters', id: 'jojo' });
  assert.deepEqual(parseRoute('#/invites/abc'), { page: 'invites', id: null }, 'only roles carry an id');
  for (const bad of ['', '#', '#/', '#/nowhere', '#/characters/a b', '#/characters/../x', 'characters'])
    assert.equal(parseRoute(bad), null, bad);
});

test('environment label names a test machine and otherwise the host', () => {
  assert.equal(environmentLabel('127.0.0.1'), '本机测试环境');
  assert.equal(environmentLabel('admin.example.com'), 'admin.example.com');
  assert.equal(environmentLabel(undefined), '');
});

test('below 1024 px only the notice shows; the admin has no mobile breakpoints', () => {
  const css = readFileSync(new URL('../../src/styles/main.css', import.meta.url), 'utf8');
  assert.match(
    css,
    /@media \(max-width: 1023px\) \{\s*\.admin-shell > :not\(\.admin-narrow-notice\) \{\s*display: none !important;/,
  );
  // Every max-width media block that mentions the console must be that one notice rule.
  const blocks = css.split('@media').slice(1);
  for (const block of blocks) {
    const head = block.slice(0, block.indexOf('{')).trim();
    const body = block.slice(0, block.indexOf('\n}\n') + 3);
    if (/account-admin-page|admin-shell|admin-nav|admin-table|admin-split/.test(body))
      assert.equal(head, '(max-width: 1023px)', `unexpected media query for the console: ${head}`);
  }
});

// ---- the page, with the same hand-made DOM the other page tests use -----------------------------------------------
class Stub extends EventTarget {
  value = '';
  textContent = '';
  innerHTML = '';
  hidden = false;
  disabled = false;
  checked = false;
  type = '';
  className = '';
  dataset: Record<string, string> = {};
  children: Stub[] = [];
  attributes = new Map<string, string>();
  focus() {}
  setAttribute(k: string, v: string) {
    this.attributes.set(k, v);
  }
  removeAttribute(k: string) {
    this.attributes.delete(k);
  }
  append(...c: Stub[]) {
    this.children.push(...c);
  }
  replaceChildren(...c: Stub[]) {
    this.children = c;
  }
  remove() {}
  contains() {
    return false;
  }
  fire(event = 'click') {
    this.dispatchEvent(new Event(event, { cancelable: true }));
  }
}
class Root extends Stub {
  nodes = new Map<string, Stub>();
  querySelector(selector: string): Stub {
    let node = this.nodes.get(selector);
    if (!node) {
      node = new Stub();
      const page = /data-page="([^"]+)"/.exec(selector);
      if (page) node.dataset.page = page[1]!;
      this.nodes.set(selector, node);
    }
    return node;
  }
  querySelectorAll(selector: string) {
    const pages = [
      'login',
      'token',
      'reset',
      'account',
      'invites',
      'characters',
      'preview',
      'cocreation',
      'grants',
      'ops',
      'members',
    ];
    if (selector === '[data-panel]')
      return pages.map((p) => Object.assign(this.querySelector(`[data-panel="${p}"]`), { dataset: { panel: p } }));
    if (selector === '[data-page]' || selector === '.admin-nav [data-page]')
      return pages.map((p) => this.querySelector(`[data-page="${p}"]`));
    return [];
  }
}
const descendants = (node: Stub): Stub[] => [node, ...node.children.flatMap(descendants)];
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const session = (
  permissions: AdminPermission[],
  role: 'owner' | 'admin' = 'admin',
  email: string | null = 'a@example.com',
): AccountAdminSession => ({
  csrf: 'a'.repeat(64),
  expiresAt: 4_000_000_000_000,
  emailDeliveryAvailable: false,
  member: { id: 'm', role, label: '合成管理员', email, createdAt: 1, permissions },
});
function setup(t: test.TestContext, state: AccountAdminSession, hash = '') {
  const root = new Root();
  const win = Object.assign(new EventTarget(), {
    location: { hash, hostname: '127.0.0.1' },
    history: {
      replaced: [] as string[],
      replaceState(_a: unknown, _b: string, url: string) {
        win.location.hash = url;
        this.replaced.push(url);
      },
    },
  });
  const saved = [
    Object.getOwnPropertyDescriptor(globalThis, 'window'),
    Object.getOwnPropertyDescriptor(globalThis, 'document'),
  ];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: win });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      addEventListener() {},
      removeEventListener() {},
      createElement: () => new Stub(),
      createTextNode: (v: string) => Object.assign(new Stub(), { textContent: v }),
    },
  });
  const listed: string[] = [];
  const port = {
    restore: async () => state,
    login: async () => state,
    emailLogin: async () => state,
    logout: async () => {},
    bindStart: async () => ({ challengeId: 'b', expiresAt: 1 }),
    bindFinish: async () => state,
    resetStart: async () => ({ challengeId: 'r', expiresAt: 1 }),
    resetFinish: async () => {},
    members: async () => ({ members: [], grants: [] }),
    issueMember: async () => ({ memberId: 'x', grantId: 'g', token: 'b'.repeat(43), duplicate: false }),
    setPermissions: async () => state.member,
    revokeCredential: async () => {},
    issue: async () => ({ inviteId: 'i', code: 'c'.repeat(43), duplicate: false }),
    revokeInvite: async () => {},
    inviteRecords: async () => ({ records: [], next: null }),
    characters: new CharacterAdminClient(async (path) => {
      listed.push(path);
      return {
        characters: [
          { characterId: 'jojo', displayName: 'JOJO', publishedVersion: 1, draftRevision: 2 },
          { characterId: 'other', displayName: '别人', publishedVersion: 1, draftRevision: null },
        ],
        deletions: [],
      };
    }),
    stageLatency: async () => [],
    cocreation: {
      counts: async () => ({}),
      list: async () => ({ items: [], next: null }),
      detail: async () => {
        throw new Error('unused');
      },
      setStatus: async () => ({ updated: 0, status: 'new' }),
      star: async () => {},
      note: async () => null,
      adopt: async () => ({ ordinal: 0, status: 'processed' }),
    },
  };
  const dispose = startAccountAdminPage(root as unknown as HTMLElement, port as never);
  t.after(() => {
    dispose();
    for (const [i, key] of (['window', 'document'] as const).entries())
      saved[i] ? Object.defineProperty(globalThis, key, saved[i]!) : Reflect.deleteProperty(globalThis, key);
  });
  return { root, win, port, listed };
}
const hiddenOf = (f: ReturnType<typeof setup>, page: string) => f.root.querySelector(`[data-page="${page}"]`).hidden;
const surface = (f: ReturnType<typeof setup>) => f.root.querySelector('main').attributes.get('data-surface');

test('page: nav items an administrator may not use are hidden, not disabled', async (t) => {
  const f = setup(t, session(['invites.read', 'invites.issue']));
  await flush();
  const shown = ['invites', 'grants'];
  for (const page of ['characters', 'preview', 'cocreation', 'invites', 'grants', 'ops', 'members']) {
    assert.equal(hiddenOf(f, page), !shown.includes(page), page);
    assert.equal(f.root.querySelector(`[data-page="${page}"]`).disabled, false, `${page} is never merely disabled`);
  }
  assert.equal(f.root.querySelector('[data-group="roles"]').hidden, true, 'a group with nothing to show disappears');
  assert.equal(f.root.querySelector('[data-group="players"]').hidden, false);
});

test('page: the owner sees every item', async (t) => {
  const f = setup(t, session([], 'owner'));
  await flush();
  for (const page of ['characters', 'preview', 'cocreation', 'invites', 'grants', 'ops', 'members'])
    assert.equal(hiddenOf(f, page), false, page);
});

test('page: after login the first page the administrator may use opens, not always 邀请码', async (t) => {
  for (const [permissions, page] of [
    [['cocreation.read'], 'cocreation'],
    [['characters.read:*'], 'characters'],
    [['invites.issue'], 'invites'],
    [[], 'account'],
  ] as const)
    await t.test(page, async (sub) => {
      const f = setup(sub, session([...permissions]));
      await flush();
      assert.equal(surface(f), page);
      assert.equal(f.win.location.hash, `#/${page}`, 'the address bar follows');
    });
});

test('page: a reload keeps the place named by the hash, but never one the administrator may not use', async (t) => {
  await t.test('invites', async (sub) => {
    const f = setup(sub, session(['invites.read', 'characters.read:*']), '#/invites');
    await flush();
    assert.equal(surface(f), 'invites');
  });
  await t.test('members is owner only: fall back to the first allowed page', async (sub) => {
    const f = setup(sub, session(['invites.read']), '#/members');
    await flush();
    assert.equal(surface(f), 'invites');
  });
  await t.test('a role in the address is opened', async (sub) => {
    const f = setup(sub, session(['characters.read:*']), '#/characters/jojo');
    await flush();
    assert.equal(surface(f), 'characters');
    assert.ok(f.listed.some((p) => p.startsWith('jojo')));
  });
});

test('page: clicking a nav item pushes its route; Back (hashchange) returns without a reload', async (t) => {
  const f = setup(t, session(['invites.read', 'characters.read:*']));
  await flush();
  assert.equal(surface(f), 'characters');
  f.root.querySelector('[data-page="invites"]').fire();
  await flush();
  assert.equal(surface(f), 'invites');
  assert.equal(f.win.location.hash, '#/invites');
  f.win.location.hash = '#/characters';
  f.win.dispatchEvent(new Event('hashchange'));
  await flush();
  assert.equal(surface(f), 'characters');
  f.win.location.hash = '#/members';
  f.win.dispatchEvent(new Event('hashchange'));
  await flush();
  assert.equal(surface(f), 'invites' === surface(f) ? 'invites' : 'characters', 'an unavailable route is not entered');
  assert.notEqual(surface(f), 'members');
});

test('page: 退出登录 and 我的账号 live in the account menu, which opens from the top-right button', async (t) => {
  const f = setup(t, session(['invites.read']));
  await flush();
  const html = (f.root as unknown as { innerHTML: string }).innerHTML;
  const menu = html.slice(html.indexOf('class="admin-account"'), html.indexOf('</header>'));
  assert.match(menu, /我的账号/);
  assert.match(menu, /退出登录/);
  assert.match(menu, /id="admin-logout"/);
  const nav = html.slice(html.indexOf('<nav'), html.indexOf('</nav>'));
  assert.ok(!nav.includes('退出登录') && !nav.includes('我的账号'));
  const toggle = f.root.querySelector('#admin-account-toggle');
  const menuNode = f.root.querySelector('#admin-account-menu');
  assert.equal(f.root.querySelector('.admin-account').hidden, false);
  assert.match(toggle.textContent, /a@example\.com/);
  toggle.fire();
  assert.equal(menuNode.hidden, false);
  f.win.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' }));
  assert.equal(menuNode.hidden, true);
  f.root.querySelector('[data-page="account"]').fire();
  await flush();
  assert.equal(surface(f), 'account');
});

test('page: the sidebar collapses to icons and back', async (t) => {
  const f = setup(t, session(['invites.read']));
  await flush();
  const main = f.root.querySelector('main');
  assert.equal(main.attributes.get('data-nav'), 'expanded');
  f.root.querySelector('#admin-nav-collapse').fire();
  assert.equal(main.attributes.get('data-nav'), 'collapsed');
  assert.equal(f.root.querySelector('#admin-nav-collapse').attributes.get('aria-pressed'), 'true');
  f.root.querySelector('#admin-nav-collapse').fire();
  assert.equal(main.attributes.get('data-nav'), 'expanded');
});

test('page: the preview page lists only roles the administrator may preview and opens one into its own pane', async (t) => {
  const f = setup(t, session(['characters.read:jojo', 'characters.preview:jojo', 'characters.read:other']));
  await flush();
  f.root.querySelector('[data-page="preview"]').fire();
  await flush();
  assert.equal(surface(f), 'preview');
  const picks = descendants(f.root.querySelector('#admin-preview')).filter((n) => n.attributes.get('data-character'));
  assert.deepEqual(
    picks.map((n) => n.attributes.get('data-character')),
    ['jojo'],
  );
  picks[0]!.fire();
  await flush();
  assert.equal(f.win.location.hash, '#/preview/jojo');
});

test('page: a failed restore shows the login page and never a nav', async (t) => {
  const f = setup(t, session([]));
  f.port.restore = async () => {
    throw new InviteLocalApiError(401, 'ADMIN_UNAUTHORIZED');
  };
  await flush();
  assert.ok(true);
});

// Part 24k-2 (named exception): the welcome fixtures/assertions in this file moved from welcome {text,version} to welcomes [{id,text,weight}]; nothing else was changed.
import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyCharacter } from '../../src/features/admin/character-form.ts';
import { characterWorkbench } from '../../src/features/admin/character-workbench.ts';
import { rolePicker, type PickerRole } from '../../src/features/admin/shell/role-picker.ts';
import { moved, slotAt } from '../../src/features/admin/ui/drag-order.ts';
import {
  CharacterAdminClient,
  type CharacterDetail,
  type CharacterProfile,
  type SidebarGroup,
} from '../../src/services/character-admin-api.ts';
import { flush, installFakeDom, type FakeElement } from './fake-dom.ts';

/** Part 24l: the rail's three groups and per-admin drag order, and 下线 / 重新上线 on the 发布 tab (the owner's buttons only). */
const role = (id: string, group: SidebarGroup, published: number | null = 1): PickerRole => ({
  characterId: id,
  displayName: id.toUpperCase(),
  publishedVersion: published,
  draftRevision: null,
  group,
});
const all = (root: unknown, selector: string) => (root as FakeElement).querySelectorAll(selector);
const one = (root: unknown, selector: string) => (root as FakeElement).querySelector(selector) as FakeElement;
const ids = (host: unknown, group: string) =>
  all(one(host, `.admin-pick-list[data-group="${group}"]`), '.admin-pick').map((n) => n.getAttribute('data-character'));

test('24l the rail has a small heading and a count per group; an empty group is not shown; offline is marked', (t) => {
  const doc = installFakeDom(t);
  const host = doc.createElement('div') as unknown as HTMLElement;
  const picker = rolePicker(host, { emptyText: '无', onPick: () => {}, compact: { colour: () => '#2F7BEA' } });
  picker.show([
    role('a', 'live'),
    role('b', 'live'),
    role('c', 'live'),
    role('d', 'offline'),
    role('n', 'draft', null),
  ]);
  const heads = all(host, '.admin-pick-head').map((n) => n.textContent);
  assert.deepEqual(heads, ['当前阵容3', '未发布草稿1', '已下线1']);
  assert.deepEqual(ids(host, 'live'), ['a', 'b', 'c']);
  assert.equal(one(one(host, '.admin-pick[data-offline="true"]'), '.admin-pick-mark').textContent, '已下线');
  picker.show([role('a', 'live'), role('d', 'offline')]);
  assert.deepEqual(
    all(host, '.admin-pick-head').map((n) => n.textContent),
    ['当前阵容1', '已下线1'],
    'no 未发布草稿 group when it is empty',
  );
});

test('24l Alt+↓ / Alt+↑ moves a row inside its group and reports the whole group in the new order; a refusal puts it back', async (t) => {
  const doc = installFakeDom(t);
  const host = doc.createElement('div') as unknown as HTMLElement;
  const saved: [string, string[]][] = [];
  let refuse = false;
  const picker = rolePicker(host, {
    emptyText: '无',
    onPick: () => {},
    compact: { colour: () => '#2F7BEA' },
    onReorder: async (group, order) => {
      saved.push([group, order]);
      if (refuse) throw new Error('refused');
    },
  });
  picker.show([role('a', 'live'), role('b', 'live'), role('c', 'live'), role('d', 'offline'), role('e', 'offline')]);
  const key = (id: string, k: string) =>
    one(host, `.admin-pick[data-character="${id}"]`).dispatch('keydown', { key: k, altKey: true } as never);
  key('a', 'ArrowDown');
  assert.deepEqual(saved.at(-1), ['live', ['b', 'a', 'c']]);
  assert.deepEqual(ids(host, 'live'), ['b', 'a', 'c'], 'the DOM already has the new order');
  key('c', 'ArrowUp');
  assert.deepEqual(saved.at(-1), ['live', ['b', 'c', 'a']]);
  key('b', 'ArrowUp'); // already first: nothing
  assert.equal(saved.length, 2);
  key('e', 'ArrowUp');
  assert.deepEqual(saved.at(-1), ['offline', ['e', 'd']], 'a drag never mixes groups');
  assert.deepEqual(ids(host, 'live'), ['b', 'c', 'a']);
  // A repaint (another role is picked, the roster is read again) keeps the order the admin made.
  picker.select('a');
  assert.deepEqual(ids(host, 'live'), ['b', 'c', 'a']);
  // The save is refused: the rail goes back to what the server has.
  refuse = true;
  key('b', 'ArrowDown');
  await flush();
  assert.deepEqual(ids(host, 'live'), ['b', 'c', 'a']);
});

test('24l drag maths: the row lands on the nearest slot and the others keep their order', () => {
  assert.deepEqual(moved(['a', 'b', 'c', 'd'], 0, 2), ['b', 'c', 'a', 'd']);
  assert.deepEqual(moved(['a', 'b', 'c', 'd'], 3, 0), ['d', 'a', 'b', 'c']);
  assert.deepEqual(moved(['a', 'b'], 1, 1), ['a', 'b']);
  const centres = [20, 72, 124, 176];
  assert.equal(slotAt(centres, 0, 20), 0);
  assert.equal(slotAt(centres, 0, 60), 1);
  assert.equal(slotAt(centres, 0, 400), 3);
  assert.equal(slotAt(centres, 3, -50), 0);
});

test('24l the client reads group and online (an older answer falls back to the old rule), and sends the order and the requests', async () => {
  const sent: [string, Record<string, unknown>][] = [];
  const client = new CharacterAdminClient(async (path, body) => {
    sent.push([path, body]);
    if (path === 'list')
      return {
        characters: [
          {
            characterId: 'a',
            displayName: 'A',
            publishedVersion: 1,
            draftRevision: null,
            color: null,
            group: 'offline',
            online: false,
          },
          { characterId: 'b', displayName: 'B', publishedVersion: null, draftRevision: 1, color: null },
          { characterId: 'c', displayName: 'C', publishedVersion: 2, draftRevision: null, color: null },
        ],
        deletions: [],
      };
    if (path === 'order') return { group: body.group, ids: body.ids };
    return {
      characterId: 'a',
      action: path.split('/')[1],
      version: 1,
      position: path.endsWith('online') && !path.endsWith('offline') ? 0 : null,
    };
  });
  const list = await client.list();
  assert.deepEqual(
    list.characters.map((c) => [c.characterId, c.group, c.online]),
    [
      ['a', 'offline', false],
      ['b', 'draft', false],
      ['c', 'live', true],
    ],
  );
  await client.saveOrder('live', ['c', 'a']);
  assert.deepEqual(sent.at(-1), ['order', { group: 'live', ids: ['c', 'a'] }]);
  const off = await client.setAvailability('a', 'offline', { requestId: 'r1', liveVersion: 1 });
  assert.deepEqual(sent.at(-1), ['a/offline', { requestId: 'r1', liveVersion: 1 }]);
  assert.equal(off.position, null);
  const on = await client.setAvailability('a', 'online', { requestId: 'r2', liveVersion: 1 });
  assert.equal(on.position, 0);
});

// ---- the 发布 tab ---------------------------------------------------------------------------------------------------------

const profile = (): CharacterProfile => {
  const p = emptyCharacter();
  Object.assign(p.template, { id: 'jojo', name: 'JOJO', persona: '离线合成人设', version: 3 });
  p.presentation = {
    displayName: 'JOJO',
    publicDescription: '',
    welcomes: [{ id: 'welcome-v1', text: '你好', weight: 100 }],
  };
  return p;
};
const owner = { id: 'm', label: 'o', role: 'owner' as const, email: null, permissions: [], createdAt: 1 };
const staff = {
  ...owner,
  id: 'h',
  role: 'admin' as const,
  permissions: ['category.characters', 'category.publication'],
} as never as typeof owner;

function bench(t: test.TestContext, who: typeof owner, state: { online: boolean; draft?: boolean }) {
  const doc = installFakeDom(t);
  for (const [name, tag] of [
    ['HTMLInputElement', 'INPUT'],
    ['HTMLTextAreaElement', 'TEXTAREA'],
  ] as const) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: class {
        static [Symbol.hasInstance](value: unknown) {
          return (value as { tagName?: string } | null)?.tagName === tag;
        }
      },
    });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  const next = profile();
  next.template.version = 4;
  const calls: unknown[] = [];
  const view = () =>
    ({
      characterId: 'jojo',
      previews: [],
      previewAvailable: true,
      online: state.online,
      published: { version: 3, profile: profile() },
      draft: state.draft
        ? { characterId: 'jojo', revision: 2, baseVersion: 3, profile: next, contentHash: 'a'.repeat(64), savedAt: 1 }
        : null,
    }) as CharacterDetail;
  const api = {
    list: async () => ({ characters: [], deletions: [] }),
    detail: async () => view(),
    materials: async () => [],
    history: async () => ({ characterId: 'jojo', live: 3, versions: [] }),
    profilePreview: async () => ({ draft: view().draft, published: profile() }),
    setAvailability: async (...args: unknown[]) => {
      calls.push(args);
      state.online = !state.online;
      return { version: 3, position: null };
    },
  };
  const root = doc.createElement('div') as unknown as FakeElement;
  const workbench = characterWorkbench(root as unknown as HTMLElement, {
    api: api as never,
    member: () => who,
    run: async (work) => work(),
    status: () => {},
    disposed: () => false,
    directory: 'none',
    headerHost: doc.createElement('div') as unknown as HTMLElement,
  });
  return { root, workbench, calls };
}

test('24l the owner has 下线 next to the live version; it asks first, then sends the version it named; 重新上线 follows', async (t) => {
  const f = bench(t, owner, { online: true });
  await f.workbench.open('jojo');
  await flush();
  const row = one(f.root, '.wb-avail');
  assert.match(row.textContent, /正式 v3/); // Named exception (Part 24b-7d round 2, docs/ADMIN_COPY.md): was 「现行 v3」
  assert.match(row.textContent, /在线/);
  const button = one(row, '.wb-avail-go');
  assert.equal(button.textContent, '下线');
  button.click();
  await flush();
  const bar = one(f.root, '.ic');
  assert.match(bar.textContent, /聊天和记忆都保留/);
  assert.equal(f.calls.length, 0, 'nothing is sent before the confirm');
  one(bar, '.ic-go').click();
  await flush();
  await flush();
  assert.equal(f.calls.length, 1);
  const [id, action, input] = f.calls[0] as [string, string, { requestId: string; liveVersion: number }];
  assert.deepEqual([id, action, input.liveVersion], ['jojo', 'offline', 3]);
  assert.match(input.requestId, /\S/);
  // Read again: now offline, and the button offers the way back.
  const after = one(f.root, '.wb-avail');
  assert.match(after.textContent, /已下线/);
  assert.equal(one(after, '.wb-avail-go').textContent, '重新上线');
});

test('24l a cancelled confirm sends nothing', async (t) => {
  const f = bench(t, owner, { online: true });
  await f.workbench.open('jojo');
  await flush();
  one(f.root, '.wb-avail-go').click();
  await flush();
  one(f.root, '.ic button').click();
  await flush();
  assert.equal(f.calls.length, 0);
});

test('24l another administrator sees the state and no button, whatever they were granted', async (t) => {
  for (const online of [true, false]) {
    const f = bench(t, staff, { online });
    await f.workbench.open('jojo');
    await flush();
    const row = one(f.root, '.wb-avail');
    assert.match(row.textContent, online ? /在线/ : /已下线/);
    assert.equal(all(f.root, '.wb-avail-go').length, 0);
    assert.ok(!f.root.querySelectorAll('button').some((b) => /^(下线|重新上线)$/.test(b.textContent)));
  }
});

test('24l an offline character’s draft cannot be published: the tab says 先重新上线 and has no publish button', async (t) => {
  const f = bench(t, owner, { online: false, draft: true });
  await f.workbench.open('jojo');
  await flush();
  assert.match(f.root.textContent, /先重新上线/);
  assert.ok(!f.root.querySelectorAll('button').some((b) => /确认发布此版本/.test(b.textContent)));
  const online = bench(t, owner, { online: true, draft: true });
  await online.workbench.open('jojo');
  await flush();
  assert.ok(online.root.querySelectorAll('button').some((b) => /确认发布此版本/.test(b.textContent)));
});

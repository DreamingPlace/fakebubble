import assert from 'node:assert/strict';
import test from 'node:test';
import { permissionMatrixEditor } from '../../src/features/admin/permission-matrix.ts';
import { cocreationInbox } from '../../src/features/admin/cocreation-inbox.ts';
import type { AdminPermission } from '../../src/services/account-admin-api.ts';
import type { InboxDetail, InboxItem } from '../../src/services/cocreation-admin-api.ts';
import type { FakeElement } from './fake-dom.ts';
import { flush, installFakeDom } from './fake-dom.ts';

function mount(t: test.TestContext, initial: AdminPermission[] = [], cocreation = true) {
  const doc = installFakeDom(t);
  const host = doc.createElement('div');
  const editor = permissionMatrixEditor(host as unknown as HTMLElement, initial, { cocreation });
  const box = (item: string) => host.querySelector(`[data-permission="${item}"]`) as FakeElement;
  const toggle = (item: string, on: boolean) => {
    box(item).checked = on;
    box(item).dispatch('change');
  };
  const note = () => host.querySelector('.permission-note')!.textContent;
  const ticked = () =>
    host
      .querySelectorAll('[data-permission]')
      .filter((n) => n.checked)
      .map((n) => n.getAttribute('data-permission') ?? '')
      .sort();
  return {
    host,
    editor,
    box,
    toggle,
    note,
    ticked,
    preset: (id: string) => host.querySelector(`[data-preset="${id}"]`)!.click(),
  };
}

test('permissions are grouped by area with every item present', (t) => {
  const f = mount(t);
  assert.deepEqual(
    f.host.querySelectorAll('.permission-group h4').map((h) => h.textContent),
    // Named exception (Part 21g): the new 模型与价格 group (models.manage) is last; counts below are one higher. Nothing weakened.
    // Named exception (Part 24b-2): the new 关系与故事 group (cast.read / cast.edit / cast.publish) follows 共创收件箱; counts are 3 higher.
    ['角色资料', '预演与发布', '声音成品', '玩家邀请', '共创收件箱', '关系与故事', '模型与价格'],
  );
  // Named exception (Part 22a): the new invites.manage item (邀请与额度) is in the 玩家邀请 group; counts are one higher.
  assert.equal(f.host.querySelectorAll('[data-permission]').length, 20);
  const without = mount(t, [], false);
  assert.equal(
    without.host.querySelectorAll('[data-permission]').length,
    18,
    'no inbox group on a page without an inbox',
  );
});

test('ticking an item ticks what it needs and says so', (t) => {
  const f = mount(t);
  f.toggle('characters.approve-materials', true);
  assert.deepEqual(f.ticked(), ['characters.approve-materials', 'characters.materials', 'characters.read']);
  assert.match(f.note(), /「批准成品音频」需要先有.*「查看角色」.*「上传与试听成品音频」.*已一并勾选/);
  f.toggle('characters.publish', true);
  assert.ok(f.ticked().includes('characters.preview'));
  f.toggle('invites.issue', true);
  assert.deepEqual(
    f.ticked().filter((x) => x.startsWith('invites')),
    ['invites.issue', 'invites.read'],
  );
  assert.deepEqual(f.editor.value().includes('invites.read'), true);
});

test('unticking a requirement unticks what depends on it and says so; unrelated items stay', (t) => {
  const f = mount(t, [
    'characters.read:*',
    'characters.edit:*',
    'characters.preview:*',
    'characters.publish:*',
    'invites.read',
    'invites.issue',
  ]);
  f.toggle('characters.preview', false);
  assert.ok(!f.ticked().includes('characters.publish'));
  assert.match(f.note(), /「发布」依赖「预演测试」，已一并取消/);
  assert.ok(f.ticked().includes('characters.edit'));
  f.toggle('characters.read', false);
  assert.deepEqual(
    f.ticked().filter((x) => x.startsWith('characters')),
    [],
  );
  assert.deepEqual(f.ticked(), ['invites.issue', 'invites.read'], 'invites are a different area');
  f.toggle('characters.edit', false);
  assert.equal(f.note(), '', 'nothing depended on it: no note');
});

test('the saved value is the stored form: wildcard character grants, plain invite and inbox items', (t) => {
  const f = mount(t);
  f.toggle('characters.publish', true);
  f.toggle('invites.revoke-access', true);
  f.toggle('cocreation.manage', true);
  f.toggle('characters.create', true);
  assert.deepEqual(f.editor.value(), [
    'characters.create',
    'characters.preview:*',
    'characters.publish:*',
    'characters.read:*',
    'cocreation.manage',
    'cocreation.read',
    'invites.read',
    'invites.revoke-access',
  ]);
});

test('presets: 共创写手 has no publish; 运营 is invites plus inbox; 全部 ticks everything; a preset replaces the selection and can be adjusted', (t) => {
  const f = mount(t);
  f.preset('co-writer');
  assert.deepEqual(f.ticked(), ['characters.edit', 'characters.preview', 'characters.read', 'cocreation.read']);
  assert.ok(!f.ticked().includes('characters.publish'));
  assert.match(f.note(), /共创写手/);
  f.preset('operations');
  // Named exception (Part 22a): 运营 also holds invites.manage (邀请与额度).
  assert.deepEqual(f.ticked(), [
    'cocreation.manage',
    'cocreation.read',
    'invites.issue',
    'invites.manage',
    'invites.read',
    'invites.revoke-access',
    'invites.revoke-code',
  ]);
  f.preset('all');
  // Named exception (Part 21g): 全部 now also ticks models.manage (16 items). Part 22a: and invites.manage (17).
  // Named exception (Part 24b-2): and the three cast permissions (20).
  assert.equal(f.ticked().length, 20);
  f.toggle('characters.read', false);
  assert.deepEqual(
    f.ticked().filter((x) => x.startsWith('characters')),
    ['characters.create'],
    'create has no requirement in the owner’s table; everything that needs read goes. Adjusting after a preset keeps the dependency rules',
  );
  const noInbox = mount(t, [], false);
  noInbox.preset('all');
  assert.ok(!noInbox.ticked().some((x) => x.startsWith('cocreation')));
});

test('an untouched set is returned exactly as loaded; legacy categories and role-scoped grants are shown and preserved', (t) => {
  const original: AdminPermission[] = ['category.invites', 'characters.edit:jojo', 'invites.revoke'];
  const f = mount(t, original);
  assert.deepEqual(f.ticked(), ['invites.issue', 'invites.read', 'invites.revoke-access', 'invites.revoke-code']);
  assert.deepEqual(f.editor.value(), [...original].sort());
  assert.match(f.host.textContent, /按具体角色授予的旧授权/);
  assert.match(f.host.textContent, /characters\.edit:jojo/);
  f.toggle('invites.revoke-code', false);
  assert.deepEqual(
    f.editor.value(),
    ['characters.edit:jojo', 'invites.issue', 'invites.read', 'invites.revoke-access'].sort(),
  );
  const legacyBox = f.host.querySelectorAll('.permission-group[data-area="legacy"] input')[0]!;
  legacyBox.checked = false;
  legacyBox.dispatch('change');
  assert.ok(!f.editor.value().includes('characters.edit:jojo'));
});

test('a set the editor re-ticks to its loaded state is still returned unchanged; disabling disables every control', (t) => {
  const original: AdminPermission[] = ['category.characters'];
  const f = mount(t, original);
  f.toggle('characters.edit', false);
  f.toggle('characters.edit', true);
  assert.deepEqual(f.editor.value(), original);
  f.editor.setDisabled(true);
  assert.ok(f.host.querySelectorAll('[data-permission]').every((n) => n.disabled));
});

// ---- Part 21i: assertions moved here from the tests of the deleted permission-editor.ts (see the PR description) --------------
test('inbox permissions: 处理 includes 查看, and a grant that only has 处理 is returned as it was loaded; the group describes itself without identifying anyone', (t) => {
  const f = mount(t);
  assert.match(f.host.textContent, /共创收件箱/);
  assert.match(f.host.textContent, /匿名代号和邀请批次/);
  assert.doesNotMatch(f.host.textContent, /邮箱：|昵称：/);
  f.toggle('cocreation.manage', true);
  assert.ok(f.box('cocreation.read').checked, 'handling includes viewing');
  assert.deepEqual(f.editor.value(), ['cocreation.manage', 'cocreation.read']);
  f.toggle('cocreation.read', false);
  assert.equal(f.box('cocreation.manage').checked, false, 'no handling without viewing');
  assert.deepEqual(f.editor.value(), []);
  const manageOnly = mount(t, ['cocreation.manage']);
  assert.deepEqual(manageOnly.editor.value(), ['cocreation.manage'], 'an untouched grant is never widened or narrowed');
  manageOnly.toggle('invites.read', true);
  assert.ok(manageOnly.editor.value().includes('cocreation.manage'), 'touching another area keeps the grant');
  manageOnly.editor.setDisabled(true);
  assert.ok(manageOnly.host.querySelectorAll('[data-permission]').every((n) => n.disabled));
});

test('untouched role-scoped legacy grants never expand to every role, whatever is ticked beside them', (t) => {
  const original: AdminPermission[] = ['invites.revoke', 'characters.edit:deleted-role', 'characters.publish:jojo'];
  const f = mount(t, original);
  assert.deepEqual(f.editor.value(), [...original].sort());
  f.toggle('invites.revoke-code', false);
  assert.deepEqual(f.editor.value(), [
    'characters.edit:deleted-role',
    'characters.publish:jojo',
    'invites.revoke-access',
  ]);
  f.toggle('invites.issue', true);
  const saved = f.editor.value();
  assert.ok(saved.includes('characters.edit:deleted-role') && saved.includes('characters.publish:jojo'));
  assert.ok(
    !saved.some((p) => p.startsWith('characters.') && p.endsWith(':*')),
    'ticking an invite item grants no wildcard character scope',
  );
  assert.ok(!f.host.textContent.match(/最多 128|全部人物|角色操作与范围/), 'no leftover wording of the removed editor');
});

// ---- 加入草稿 is shown only with characters.edit for that role -----------------------------------------------------
const item = (id: string): InboxItem => ({
  id,
  characterId: 'jojo',
  createdAt: 1,
  pseudonym: 'P',
  answerCount: 1,
  adoptedCount: 0,
  firstLine: 'x',
  status: 'new',
  starred: false,
  hasNote: false,
});
const detail = (id: string): InboxDetail => ({
  id,
  characterId: 'jojo',
  createdAt: 1,
  pseudonym: 'P',
  batch: null,
  status: 'new',
  starred: false,
  adminNote: null,
  processedAt: null,
  answers: [
    { ordinal: 0, cardId: 'catchphrase', targetField: 'speechStyle', kind: 'text', text: '哎呀', adoptedAt: null },
  ],
});
async function inboxWith(t: test.TestContext, canEditCharacter?: (id: string) => boolean) {
  const doc = installFakeDom(t);
  const root = doc.createElement('div');
  const inbox = cocreationInbox(root as unknown as HTMLElement, {
    api: {
      list: async () => ({ items: [item('s1')], next: null }),
      detail: async () => detail('s1'),
      setStatus: async () => ({ updated: 1, status: 'new' as const }),
      star: async () => {},
      note: async () => null,
      adopt: async () => ({ ordinal: 0, status: 'processed' as const }),
    } as never,
    characters: {
      list: async () => ({
        characters: [{ characterId: 'jojo', displayName: 'JOJO', publishedVersion: 1, draftRevision: null }],
        deletions: [],
      }),
      detail: async () => ({}),
      save: async () => ({}),
    } as never,
    canManage: () => true,
    ...(canEditCharacter ? { canEditCharacter } : {}),
    run: async (work) => work(),
    status: () => {},
    disposed: () => false,
  });
  inbox.activate();
  t.after(() => inbox.dispose());
  await inbox.load();
  await flush();
  return root;
}
test('加入草稿 is absent without characters.edit for that role, present with it, and 复制 stays', async (t) => {
  const without = await inboxWith(t, () => false);
  assert.equal(without.querySelectorAll('.cc-adopt-open').length, 0);
  assert.equal(without.querySelectorAll('.cc-copy').length, 1);
  const asked: string[] = [];
  const withEdit = await inboxWith(t, (id) => (asked.push(id), true));
  assert.equal(withEdit.querySelectorAll('.cc-adopt-open').length, 1);
  assert.ok(asked.includes('jojo'), 'asked about the answer’s own role');
  const defaulted = await inboxWith(t);
  assert.equal(defaulted.querySelectorAll('.cc-adopt-open').length, 1);
});

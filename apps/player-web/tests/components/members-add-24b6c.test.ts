import assert from 'node:assert/strict';
import test from 'node:test';
import { ADMIN_PERMISSION_PRESETS } from '../../../../packages/contracts/web-admin-permissions.ts';
import { grantedNames, permissionMatrixEditor } from '../../src/features/admin/permission-matrix.ts';
import { membersView } from '../../src/features/admin/members-view.ts';
import type { FakeElement } from './fake-dom.ts';
import { flush, installFakeDom } from './fake-dom.ts';

/** Part 24b-6c: the add bar of 管理员与权限 offers the exact permission items, not only presets. */
function mount(t: test.TestContext) {
  const doc = installFakeDom(t);
  const make = () => doc.createElement('div') as unknown as HTMLElement;
  const hosts = {
    head: make(),
    presetHost: make(),
    gridHost: make(),
    table: make(),
    list: make(),
    reasonHost: make(),
  };
  const nameInput = doc.createElement('input') as unknown as HTMLInputElement;
  const issueButton = doc.createElement('button') as unknown as HTMLButtonElement;
  const issued: { label: string; permissions: string[] }[] = [];
  const view = membersView({
    ...hosts,
    nameInput,
    issueButton,
    shown: () => true,
    permissionControls: (host, initial, onChange, adding) =>
      permissionMatrixEditor(host, initial, { cocreation: true, onChange, ...(adding ? { adding } : {}) }),
    run: async (work) => {
      await work();
    },
    busy: () => false,
    api: {
      members: async () => ({ members: [], grants: [] }) as never,
      issueMember: async (input: { label: string; permissions: string[] }) => {
        issued.push({ label: input.label, permissions: input.permissions });
        return { memberId: 'm', grantId: 'g', token: 'x'.repeat(43), duplicate: false };
      },
      setPermissions: async () => undefined as never,
      revokeCredential: async () => undefined as never,
    },
    showSecret: () => {},
    status: () => {},
    disposed: () => false,
    permissionLimit: 40,
    totalPermissions: 19,
  });
  const grid = hosts.gridHost as unknown as FakeElement;
  const box = (item: string) => grid.querySelector(`[data-permission="${item}"]`) as FakeElement;
  const toggle = (item: string, on: boolean) => {
    box(item).checked = on;
    box(item).dispatch('change');
  };
  const ticked = () =>
    grid
      .querySelectorAll('[data-permission]')
      .filter((n) => n.checked)
      .map((n) => n.getAttribute('data-permission') ?? '')
      .sort();
  const preset = (id: string) => (hosts.presetHost as unknown as FakeElement).querySelector(`[data-preset="${id}"]`)!;
  const button = issueButton as unknown as FakeElement;
  const reason = () => (hosts.reasonHost as unknown as FakeElement).textContent;
  const name = (value: string) => {
    (nameInput as unknown as FakeElement).value = value;
    (nameInput as unknown as FakeElement).dispatch('input');
  };
  return { view, issued, grid, box, toggle, ticked, preset, button, reason, name };
}

test('the add bar shows the same grouped grid as an open administrator, with no 快速设置 row inside it', (t) => {
  const f = mount(t);
  assert.equal(f.grid.querySelectorAll('[data-permission]').length, 19);
  assert.equal(f.grid.querySelectorAll('.permission-presets').length, 0, 'the presets are the add bar buttons, once');
  assert.equal(f.grid.querySelectorAll('[data-dirty]').length, 0, 'a new administrator has no "unsaved" amber');
});

test('a preset only TICKS the grid and replaces earlier ticks; the ticks can then be changed freely', (t) => {
  const f = mount(t);
  const coWriter = ADMIN_PERMISSION_PRESETS.find((p) => p.id === 'co-writer')!;
  assert.deepEqual(f.ticked(), [...coWriter.items].sort(), 'the first preset is the starting point');
  f.toggle('models.manage', true);
  f.toggle('cast.read', true);
  f.preset('operations').click();
  const ops = ADMIN_PERMISSION_PRESETS.find((p) => p.id === 'operations')!;
  assert.deepEqual(f.ticked(), [...ops.items].sort(), 'the click replaced every earlier tick');
  assert.equal(f.preset('operations').getAttribute('aria-pressed'), 'true');
  f.toggle('invites.revoke-access', false);
  assert.equal(f.preset('operations').getAttribute('aria-pressed'), 'false', 'a changed set is no longer the preset');
  f.preset('co-writer').click();
  assert.deepEqual(f.ticked(), [...coWriter.items].sort());
});

test('dependencies behave as in the open grid: ticking adds what is needed, unticking removes what depends on it', (t) => {
  const f = mount(t);
  f.preset('operations').click();
  f.toggle('characters.publish', true);
  for (const item of ['characters.read', 'characters.preview', 'characters.publish'])
    assert.ok(f.ticked().includes(item), `${item} is ticked`);
  f.toggle('characters.preview', false);
  assert.ok(!f.ticked().includes('characters.publish'));
});

test('the issue button names the count, is off with 0 items or no name and says why beside it, and the request carries exactly the ticks', async (t) => {
  const f = mount(t);
  assert.equal(f.button.disabled, true);
  assert.equal(f.reason(), '先填写备注');
  assert.equal(f.button.textContent, `签发凭据 · ${f.ticked().length} 项`);
  f.name('运营 · 小王');
  assert.equal(f.button.disabled, false);
  assert.equal(f.reason(), '');
  // 运营, untick one item, tick one outside the preset.
  f.preset('operations').click();
  f.toggle('invites.revoke-access', false);
  f.toggle('cast.read', true);
  const now = f.ticked();
  assert.equal(f.button.textContent, `签发凭据 · ${now.length} 项`);
  assert.ok(!now.includes('invites.revoke-access') && now.includes('cast.read'));
  await f.view.issue('运营 · 小王');
  assert.equal(f.issued.length, 1);
  const sent = f.issued[0]!.permissions;
  assert.ok(sent.includes('cast.read'), 'the item outside the preset is granted');
  assert.ok(!sent.includes('invites.revoke-access'), 'the unticked item is not');
  assert.ok(sent.includes('invites.issue') && sent.includes('cocreation.manage'), 'the rest of the preset is');
  assert.equal(sent.length, now.length);
  await flush();
  // Everything unticked: off, with the reason, and the name was cleared by the issue.
  for (const item of f.ticked()) f.toggle(item, false);
  f.name('另一位');
  assert.equal(f.button.textContent, '签发凭据 · 0 项');
  assert.equal(f.button.disabled, true);
  assert.equal(f.reason(), '没有勾选任何权限');
});

test('what an administrator holds is listed by the grid\'s Chinese names; a grant for one role stays "· 指定角色"', () => {
  assert.deepEqual(grantedNames(['invites.read', 'invites.issue', 'cast.read']), [
    '查看邀请记录',
    '生成邀请码',
    '关系与故事·查看',
  ]);
  assert.deepEqual(grantedNames(['characters.read:jojo', 'stats.read', 'points.grant']), [
    '查看角色 · 指定角色',
    '查看消耗表与统计',
    '积分发放',
  ]);
});

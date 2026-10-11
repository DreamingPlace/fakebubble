import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ADMIN_PERMISSION_ITEMS,
  ADMIN_PERMISSION_PRESETS,
  ADMIN_PERMISSION_REQUIRES,
  dependentItems,
  hasAnyCharacterPermission,
  hasAnyInvitePermission,
  itemPermission,
  normalizePermissions,
  requiredItems,
  type AdminPermission,
  type AdminPermissionItem,
} from '../../../packages/contracts/web-admin-permissions.ts';

test('the dependency table is the one the owner decided, with transitive closure', () => {
  const direct = (item: AdminPermissionItem) => [...ADMIN_PERMISSION_REQUIRES[item]].sort();
  for (const item of [
    'characters.edit',
    'characters.discard',
    'characters.preview',
    'characters.materials',
    'characters.delete',
  ] as const)
    assert.deepEqual(direct(item), ['characters.read'], item);
  assert.deepEqual(direct('characters.publish'), ['characters.preview', 'characters.read']);
  assert.deepEqual(direct('characters.approve-materials'), ['characters.materials']);
  for (const item of ['invites.issue', 'invites.revoke-code', 'invites.revoke-access'] as const)
    assert.deepEqual(direct(item), ['invites.read'], item);
  assert.deepEqual(direct('cocreation.manage'), ['cocreation.read']);
  for (const item of ['characters.read', 'characters.create', 'invites.read', 'cocreation.read'] as const)
    assert.deepEqual(direct(item), [], item);
  // approve-materials needs materials, which needs read.
  assert.deepEqual(requiredItems('characters.approve-materials'), ['characters.read', 'characters.materials']);
  assert.deepEqual(requiredItems('characters.publish'), ['characters.read', 'characters.preview']);
  assert.equal(dependentItems('characters.read').length, 7, 'every other character action but create');
  assert.ok(dependentItems('characters.preview').includes('characters.publish'));
  assert.ok(dependentItems('characters.materials').includes('characters.approve-materials'));
  assert.deepEqual(dependentItems('invites.read'), ['invites.issue', 'invites.revoke-code', 'invites.revoke-access']);
});

test('the table has no cycles and every requirement is a known item', () => {
  for (const item of ADMIN_PERMISSION_ITEMS) {
    assert.ok(!requiredItems(item).includes(item), `${item} must not need itself`);
    for (const need of ADMIN_PERMISSION_REQUIRES[item]) assert.ok(ADMIN_PERMISSION_ITEMS.includes(need));
  }
});

test('normalization adds requirements in the same scope, sorts, de-duplicates and is idempotent', () => {
  const input = ['characters.publish:jojo', 'characters.read:jojo', 'invites.issue'] as AdminPermission[];
  const out = normalizePermissions(input);
  assert.deepEqual(out, [
    'characters.preview:jojo',
    'characters.publish:jojo',
    'characters.read:jojo',
    'invites.issue',
    'invites.read',
  ]);
  assert.deepEqual(normalizePermissions(out), out);
  assert.deepEqual(normalizePermissions([]), []);
  // A grant for one role never reaches another role, and a wildcard stays a wildcard.
  assert.deepEqual(normalizePermissions(['characters.edit:*']), ['characters.edit:*', 'characters.read:*']);
  assert.ok(!normalizePermissions(['characters.edit:a']).includes('characters.read:b' as AdminPermission));
});

test('categories, create and the legacy combined revocation are not expanded', () => {
  for (const kept of [
    ['category.characters'],
    ['characters.create'],
    ['invites.revoke'],
    ['category.invites', 'category.materials'],
  ] as AdminPermission[][])
    assert.deepEqual(normalizePermissions(kept), [...kept].sort());
});

test('presets: 共创写手 cannot publish, 运营 is invites plus the inbox, 全部 is everything; all are closed under the requirements', () => {
  const preset = (id: string) => ADMIN_PERMISSION_PRESETS.find((p) => p.id === id)!;
  const writer = preset('co-writer');
  assert.equal(writer.label, '共创写手');
  assert.deepEqual([...writer.items].sort(), [
    'characters.edit',
    'characters.preview',
    'characters.read',
    'cocreation.read',
  ]);
  assert.ok(!writer.items.includes('characters.publish'));
  const ops = preset('operations');
  assert.equal(ops.label, '运营');
  assert.deepEqual([...ops.items].sort(), [
    'cocreation.manage',
    'cocreation.read',
    'invites.issue',
    'invites.read',
    'invites.revoke-access',
    'invites.revoke-code',
  ]);
  assert.deepEqual([...preset('all').items].sort(), [...ADMIN_PERMISSION_ITEMS].sort());
  assert.equal(preset('all').label, '全部');
  for (const p of ADMIN_PERMISSION_PRESETS) {
    const stored = p.items.map(itemPermission);
    assert.deepEqual(normalizePermissions(stored), [...stored].sort(), `${p.label} already includes what it needs`);
  }
});

test('navigation helpers see per-action, wildcard, scoped and category grants', () => {
  assert.ok(hasAnyCharacterPermission(['characters.preview:jojo'], 'preview'));
  assert.ok(hasAnyCharacterPermission(['category.publication'], 'preview'));
  assert.ok(!hasAnyCharacterPermission(['characters.edit:*'], 'preview'));
  assert.ok(!hasAnyCharacterPermission(['characters.edit:*'], 'read'), 'edit alone does not open the list');
  assert.ok(hasAnyCharacterPermission(['characters.read:jojo'], 'read'));
  assert.ok(!hasAnyCharacterPermission([], 'read'));
  assert.ok(hasAnyInvitePermission(['invites.revoke']) && hasAnyInvitePermission(['category.invites']));
  assert.ok(!hasAnyInvitePermission(['cocreation.read']));
});

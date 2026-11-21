import assert from 'node:assert/strict';
import test from 'node:test';
import { installWebAdminActions, WebSecurityCounters } from '../../../apps/server/admin/web-admin-actions.ts';
import { WebSystemAdmin } from '../../../apps/server/admin/web-system-admin.ts';
import { readWriter } from '../../../apps/server/generation/web-writer-setting.ts';
import { tiersFixture } from '../fixtures/invite-tiers.ts';

/** Part 37b: the owner's switch has three choices; only the owner flips it; every change is one audit row. */
test('37b the owner switches 旧 → 新 → 新+档案 → 旧; staff cannot; one audit row each; a replay changes nothing', (t) => {
  const f = tiersFixture(t);
  installWebAdminActions(f.store);
  const live = { now: () => f.clock() };
  const admin = new WebSystemAdmin(f.store, live, f.accounts, {
    security: new WebSecurityCounters(f.store, live),
    emailKey: Buffer.alloc(32, 7),
  });
  assert.deepEqual(admin.writerRead(f.owner, {}), { writer: 'v7', available: true });
  const staff = f.member(['points.grant', 'system.read', 'models.manage', 'invites.manage']);
  assert.throws(() => admin.writerSave(staff, { requestId: 'x-1', writer: 'v8p' }), /ADMIN_OWNER_REQUIRED/);
  assert.equal(readWriter(f.store), 'v7');
  for (const [i, writer] of (['v8', 'v8p', 'v7'] as const).entries()) {
    const saved = admin.writerSave(f.owner, { requestId: `switch-${i}`, writer });
    assert.deepEqual({ ...saved }, { writer, available: true, duplicate: false });
    assert.equal(readWriter(f.store), writer);
    assert.equal(admin.writerRead(f.owner, {}).writer, writer);
  }
  assert.equal(admin.writerSave(f.owner, { requestId: 'switch-1', writer: 'v8p' }).duplicate, true);
  assert.equal(readWriter(f.store), 'v7', 'a replay of an old request id changes nothing');
  assert.throws(() => admin.writerSave(f.owner, { requestId: 'switch-1', writer: 'v8' }), /IDEMPOTENCY_CONFLICT/);
  assert.deepEqual(
    f.store
      .all<{ target_id: string }>("SELECT target_id FROM web_admin_audit WHERE action='writer-set' ORDER BY seq")
      .map((row) => row.target_id),
    ['v7>v8', 'v8>v8p', 'v8p>v7'],
  );
});

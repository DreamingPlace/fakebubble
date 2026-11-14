import assert from 'node:assert/strict';
import test from 'node:test';
import { installWebAdminActions, WebSecurityCounters } from '../../../apps/server/admin/web-admin-actions.ts';
import { WebSystemAdmin } from '../../../apps/server/admin/web-system-admin.ts';
import { readWriter, installWriterSetting } from '../../../apps/server/generation/web-writer-setting.ts';
import { tiersFixture } from '../fixtures/invite-tiers.ts';

function system(t: test.TestContext) {
  const f = tiersFixture(t);
  installWebAdminActions(f.store);
  const live = { now: () => f.clock() };
  const security = new WebSecurityCounters(f.store, live);
  const admin = new WebSystemAdmin(f.store, live, f.accounts, {
    security,
    emailKey: Buffer.alloc(32, 7),
  });
  return { ...f, admin };
}
const audit = (f: ReturnType<typeof system>) =>
  f.store.all<{ actor_id: string; action: string; target_id: string }>(
    "SELECT actor_id,action,target_id FROM web_admin_audit WHERE action LIKE 'writer-%' ORDER BY seq",
  );

test('37a the switch: 现行 by default, owner only, the session, CSRF and Origin are checked before the body is read', (t) => {
  const f = system(t);
  assert.deepEqual(f.admin.writerRead(f.owner, {}), { writer: 'v7', available: true });
  const staff = f.member(['points.grant', 'system.read', 'models.manage', 'invites.manage']);
  assert.throws(() => f.admin.writerRead(staff, {}), /ADMIN_OWNER_REQUIRED/);
  // A refused administrator learns nothing about the body: the owner check comes first, whatever the body is.
  assert.throws(() => f.admin.writerSave(staff, { nonsense: true }), /ADMIN_OWNER_REQUIRED/);
  assert.throws(
    () => f.admin.writerSave({ ...f.owner, csrf: 'wrong' }, { requestId: 'r-1', writer: 'v8' }),
    /CSRF|ADMIN/,
  );
  assert.throws(
    () => f.admin.writerSave({ ...f.owner, origin: 'https://evil.invalid' }, { requestId: 'r-1', writer: 'v8' }),
    /ORIGIN|ADMIN/,
  );
  assert.equal(readWriter(f.store), 'v7', 'a refused call changes nothing');
  assert.equal(audit(f).length, 0);
});

test('37a the switch: one audit row per change (who, when, the value, never content), idempotent per request id, conflicts are refused', (t) => {
  const f = system(t);
  const first = f.admin.writerSave(f.owner, { requestId: 'writer-request-1', writer: 'v8' });
  assert.deepEqual({ ...first }, { writer: 'v8', available: true, duplicate: false });
  assert.equal(readWriter(f.store), 'v8');
  const memberId = f.store.get<{ id: string }>("SELECT id FROM web_admin_members WHERE role='owner'")!.id;
  assert.deepEqual(
    audit(f).map((row) => ({ ...row })),
    [{ actor_id: memberId, action: 'writer-set', target_id: 'v7>v8' }],
  );
  const row = f.store.get<{ changed_by: string; changed_at: number }>(
    'SELECT changed_by,changed_at FROM web_writer_setting',
  )!;
  assert.equal(row.changed_by, memberId);
  assert.equal(row.changed_at, f.clock());
  // The same request id and body answers what it answered and runs nothing.
  const again = f.admin.writerSave(f.owner, { requestId: 'writer-request-1', writer: 'v8' });
  assert.deepEqual({ ...again }, { writer: 'v8', available: true, duplicate: true });
  assert.equal(audit(f).length, 1);
  // Another body under the same id is a conflict, never a second run.
  assert.throws(
    () => f.admin.writerSave(f.owner, { requestId: 'writer-request-1', writer: 'v7' }),
    /IDEMPOTENCY_CONFLICT/,
  );
  assert.equal(readWriter(f.store), 'v8');
  // Back to 现行 under a new id; unknown values and extra keys are refused.
  f.admin.writerSave(f.owner, { requestId: 'writer-request-2', writer: 'v7' });
  assert.equal(readWriter(f.store), 'v7');
  assert.deepEqual(
    audit(f).map((row) => row.target_id),
    ['v7>v8', 'v8>v7'],
  );
  assert.throws(() => f.admin.writerSave(f.owner, { requestId: 'writer-request-3', writer: 'v9' }), /INVALID_REQUEST/);
  assert.throws(
    () => f.admin.writerSave(f.owner, { requestId: 'writer-request-3', writer: 'v8', extra: 1 }),
    /INVALID_REQUEST/,
  );
  assert.throws(() => f.admin.writerSave(f.owner, { writer: 'v8' }), /INVALID_REQUEST/);
});

test('37a the table is a digest-checked runtime step: no numbered migration, and a foreign table stops the start', (t) => {
  const f = system(t);
  installWriterSetting(f.store);
  installWriterSetting(f.store);
  f.store.run('UPDATE web_writer_schema SET sha256=? WHERE version=1', 'f'.repeat(64));
  assert.throws(() => installWriterSetting(f.store), { code: 'WEB_WRITER_SCHEMA_MISMATCH' });
  const g = tiersFixture(t);
  g.store.run('CREATE TABLE web_writer_other(x INTEGER)');
  assert.throws(() => installWriterSetting(g.store), { code: 'WEB_WRITER_SCHEMA_MISMATCH' });
});

import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import test from 'node:test';
import { WebAccountAdmin } from '../../../apps/server/admin/web-account-admin.ts';
import { routeWebAccountAdmin } from '../../../apps/server/admin/web-account-admin-routes.ts';
import { installWebAdminActions } from '../../../apps/server/admin/web-admin-actions.ts';
import { WebCastAdmin } from '../../../apps/server/admin/web-cast-admin.ts';
import { migrateWebProviderCast } from '../../../apps/server/generation/web-provider-migration.ts';
import { FREEZE_NOW, schema128 } from '../fixtures/cast-freeze.ts';
import { sampleCastRaw } from '../fixtures/cast-sample.ts';

/** Part 24b-7: cast/version, one stored version's document (cast.read), read-only. */
const origin = 'https://fixture.invalid';
function fixture(t: TestContext) {
  const store = schema128();
  migrateWebProviderCast(store);
  t.after(() => store.close());
  let ids = 0;
  const clock = { now: () => FREEZE_NOW };
  for (let i = 1; i <= 15; i++)
    store.run(
      'INSERT OR IGNORE INTO character_templates(id,version,config_json) VALUES (?,?,?)',
      `c${String(i).padStart(2, '0')}`,
      1,
      '{}',
    );
  const accounts = new WebAccountAdmin(store, clock, origin);
  installWebAdminActions(store);
  const owner = accounts.login(accounts.issueLoginGrant().token, origin);
  const ownerAuth = { cookie: owner.cookie, csrf: owner.csrf, origin };
  const staff = (permissions: string[]) => {
    const grant = accounts.issueMember(owner.cookie, owner.csrf, origin, {
      requestId: `issue-${++ids}`,
      label: 'Staff',
      memberId: null,
      permissions,
    });
    const login = accounts.login(grant.token, origin);
    return { cookie: login.cookie, csrf: login.csrf, origin };
  };
  const cast = new WebCastAdmin(store, clock, accounts);
  return { store, cast, ownerAuth, staff, request: () => `cast-request-${++ids}` };
}

test('cast/version returns exactly the stored document of that version; a missing version is NOT_FOUND; read-only; cast.read only', (t) => {
  const f = fixture(t);
  const draft = f.cast.draft(f.ownerAuth, {});
  const saved = f.cast.save(f.ownerAuth, {
    requestId: f.request(),
    expectedRevision: draft.revision,
    doc: sampleCastRaw(),
  });
  const v1 = f.cast.publish(f.ownerAuth, { requestId: f.request(), expectedRevision: saved.revision });
  const stored = f.store.get<{ doc_json: string; digest: string }>(
    'SELECT doc_json,digest FROM web_cast_publications WHERE version=?',
    v1.version,
  )!;
  const reader = f.staff(['cast.read']);
  const before = f.store.get<{ n: number }>('SELECT count(*) n FROM web_admin_audit')!.n;
  const got = f.cast.version(reader, { version: v1.version });
  assert.deepEqual(got.doc, JSON.parse(stored.doc_json), 'the stored document, as stored');
  assert.equal(got.digest, stored.digest);
  assert.equal(got.version, v1.version);
  assert.equal(
    f.store.get<{ n: number }>('SELECT count(*) n FROM web_admin_audit')!.n,
    before,
    'a read writes nothing',
  );
  assert.throws(() => f.cast.version(reader, { version: 99 }), /NOT_FOUND/);
  assert.throws(() => f.cast.version(reader, { version: 0 }), /INVALID_REQUEST/);
  assert.throws(() => f.cast.version(reader, { version: 1, extra: true }), /INVALID_REQUEST/);
  assert.throws(() => f.cast.version(f.staff(['stats.read']), { version: v1.version }), /PERMISSION_REQUIRED/);
  // The same holders as the neighbouring reads (cast.edit and cast.publish imply reading), and the permission comes before the body.
  assert.deepEqual(f.cast.version(f.staff(['cast.edit']), { version: v1.version }), got);
  assert.throws(() => f.cast.version(f.staff(['stats.read']), { nonsense: true }), /PERMISSION_REQUIRED/);
  assert.deepEqual(f.cast.version(f.ownerAuth, { version: v1.version }), got);
});

test('the route: POST /admin/cast/version answers with the document; an unknown version is NOT_FOUND; the session, CSRF and Origin are checked', async (t) => {
  const f = fixture(t);
  const accounts = (f.cast as unknown as { admin: WebAccountAdmin }).admin;
  const draft = f.cast.draft(f.ownerAuth, {});
  const saved = f.cast.save(f.ownerAuth, {
    requestId: f.request(),
    expectedRevision: draft.revision,
    doc: sampleCastRaw(),
  });
  const v1 = f.cast.publish(f.ownerAuth, { requestId: f.request(), expectedRevision: saved.revision });
  const call = (body: unknown, as: { cookie: string; csrf: string; origin: string } = f.ownerAuth) =>
    routeWebAccountAdmin(
      accounts,
      {
        method: 'POST',
        path: '/api/web/local/admin/cast/version',
        origin: as.origin,
        csrf: as.csrf,
        adminCookie: as.cookie,
        body,
      } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      f.cast,
    );
  const ok = await call({ version: v1.version });
  assert.equal(ok?.status, 200);
  assert.deepEqual(ok?.body, f.cast.version(f.ownerAuth, { version: v1.version }));
  await assert.rejects(call({ version: 99 }), (e: { code?: string }) => e.code === 'NOT_FOUND');
  await assert.rejects(
    call({ version: v1.version }, { ...f.ownerAuth, origin: 'https://evil.invalid' }),
    (e: { code?: string }) => /ORIGIN|CSRF|ADMIN_UNAUTHORIZED/.test(String(e.code)),
  );
  await assert.rejects(call({ version: v1.version }, { ...f.ownerAuth, csrf: 'wrong' }), (e: { code?: string }) =>
    /CSRF|ADMIN_UNAUTHORIZED/.test(String(e.code)),
  );
  await assert.rejects(call({ version: v1.version }, { ...f.ownerAuth, cookie: '' }), (e: { code?: string }) =>
    /ADMIN_UNAUTHORIZED|AUTH/.test(String(e.code)),
  );
});

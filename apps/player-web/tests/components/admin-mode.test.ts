import test from 'node:test';
import assert from 'node:assert/strict';
import { canOpenAdminPage } from '../../src/app/admin-mode.ts';
import { InviteAdminApi } from '../../src/services/invite-admin-api.ts';

test('public provider admin can render on HTTPS; synthetic admin remains loopback-only', () => {
  for (const provider of [false, true]) {
    assert.equal(canOpenAdminPage(new URL('http://fakebubble.example'), provider), false);
    assert.equal(canOpenAdminPage(new URL('http://127.0.0.1'), provider), false);
    assert.equal(canOpenAdminPage(new URL('https://127.0.0.1'), provider), true);
  }
  assert.equal(canOpenAdminPage(new URL('https://fakebubble.example'), true), true);
  assert.equal(canOpenAdminPage(new URL('https://fakebubble.example'), false), false);
});

test('rendering the public admin does not authorize issuing an invite or substitute a local API', async () => {
  let calls = 0;
  const api = new InviteAdminApi(async (url, init) => {
    calls++; assert.equal(url, '/api/web/provider/admin/session');
    assert.equal(init?.credentials, 'same-origin'); assert.equal(init?.cache, 'no-store');
    return Response.json({ error: { code: 'ADMIN_UNAUTHORIZED' } }, { status: 401 });
  }, '/api/web/provider/admin');
  await assert.rejects(api.restore(), /ADMIN_UNAUTHORIZED/);
  await assert.rejects(api.issue({ requestId: 'not-sent', redeemBy: null, batch: 'offline', note: null }),
    /WEB_INVITE_ADMIN_SESSION_REQUIRED/);
  assert.equal(calls, 1);
});

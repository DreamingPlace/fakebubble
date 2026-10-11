import assert from 'node:assert/strict';
import test from 'node:test';
import { Store } from '../../../apps/server/platform/store.ts';
import { WebAccountAdmin } from '../../../apps/server/admin/web-account-admin.ts';

// Part 16: why POST .../characters/jojo/previews-status returned 403 while the page worked. The CSRF token is a pure
// function of the session cookie; the cookie is shared by every tab of the browser, the token is held per tab. A new
// login replaces the cookie, so another tab still sends the old token: 403 ADMIN_CSRF_REQUIRED on a valid session.
test('a login in another tab replaces the cookie: the old tab token gets 403 ADMIN_CSRF_REQUIRED, the session endpoint hands out the new one', () => {
  const origin = 'https://admin.fixture.invalid';
  const store = new Store(':memory:');
  const admin = new WebAccountAdmin(store, { now: () => 1_800_000_000_000 }, origin);
  try {
    const first = admin.login(admin.issueLoginGrant().token, origin);
    const second = admin.login(admin.issueLoginGrant().token, origin);
    assert.notEqual(first.cookie, second.cookie);
    assert.notEqual(first.csrf, second.csrf);
    // The browser now sends the second cookie; the first tab still holds the first token.
    assert.throws(() => admin.authorize(second.cookie, first.csrf, origin), /ADMIN_CSRF_REQUIRED/);
    assert.ok(admin.authorize(second.cookie, second.csrf, origin));
    // GET /session answers for the cookie the browser sends, so a re-sync always yields a working token.
    assert.equal(admin.session(second.cookie).csrf, second.csrf);
    // It is a stale-token problem, not a session problem: an expired or revoked session is a 401 instead.
    assert.throws(() => admin.authorize('x'.repeat(43), first.csrf, origin), /ADMIN_UNAUTHORIZED/);
  } finally {
    store.close();
  }
});

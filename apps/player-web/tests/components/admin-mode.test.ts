import test from 'node:test';
import assert from 'node:assert/strict';
import { canOpenAdminPage } from '../../src/app/admin-mode.ts';

test('the admin page renders on HTTPS only', () => {
  assert.equal(canOpenAdminPage(new URL('http://fakebubble.example')), false);
  assert.equal(canOpenAdminPage(new URL('http://127.0.0.1')), false);
  assert.equal(canOpenAdminPage(new URL('https://127.0.0.1')), true);
  assert.equal(canOpenAdminPage(new URL('https://fakebubble.example')), true);
});

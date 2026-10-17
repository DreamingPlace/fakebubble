import test from 'node:test';
import assert from 'node:assert/strict';
import { errorText } from '../../src/features/prototype/provider-binding.ts';

/** Part 17h: an invited player whose invite is gone is told so, not that a trial ended (both answer HTTP 410). */
test('WEB_INVITE_ACCESS_REQUIRED has its own message, different from the trial text', () => {
  assert.equal(errorText.WEB_INVITE_ACCESS_REQUIRED, '邀请已失效，请重新输入邀请码或注册账号');
  assert.notEqual(errorText.WEB_INVITE_ACCESS_REQUIRED, errorText.TRIAL_EXPIRED);
  assert.ok(!errorText.WEB_INVITE_ACCESS_REQUIRED!.includes('体验'));
});

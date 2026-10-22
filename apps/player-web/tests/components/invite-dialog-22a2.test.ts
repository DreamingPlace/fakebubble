import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inviteDialogHtml } from '../../src/features/account/invite-dialog-html.ts';

// Part 22a2: the 注册 button and 注册后即可使用邀请码 are a GUEST's. A signed-in player's 输入邀请码 dialog is the code field and 兑换.
const SIGNUP_LINE = '注册后即可使用邀请码';

test('a signed-in player’s invite dialog has the code field and 兑换 and nothing about signing up', () => {
  const html = inviteDialogHtml(false);
  assert.ok(html.includes('id="invite-code"'));
  assert.ok(html.includes('兑换'));
  assert.ok(!html.includes(SIGNUP_LINE), 'no sign-up line');
  assert.ok(!html.includes('invite-signup'), 'no sign-up block at all');
  assert.ok(!html.includes('>注册<'), 'no 注册 button');
});

test('a guest’s invite dialog carries the sign-up line and the 注册 button (hidden until the guest submits a code)', () => {
  const html = inviteDialogHtml(true);
  assert.ok(html.includes('id="invite-code"'));
  assert.ok(html.includes(SIGNUP_LINE));
  assert.match(html, /<button type="button" class="invite-signup-button">注册<\/button>/);
  assert.match(html, /class="invite-signup" hidden/);
});

test('the sign-up block cannot show through the hidden attribute: its display rule yields to [hidden]', () => {
  const css = readFileSync(new URL('../../src/styles/main.css', import.meta.url), 'utf8');
  assert.match(css, /\.invite-signup\[hidden\]\s*\{\s*display:\s*none;?\s*\}/);
});

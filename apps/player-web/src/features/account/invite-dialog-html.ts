import { infoCopy } from './my-info.ts';

/**
 * The 输入邀请码 dialog. The 注册 line and button belong to a GUEST only (Part 22a2): a signed-in player's dialog is the code
 * field and 兑换 and nothing about signing up. The block is not rendered at all for a signed-in player (relying on the
 * `hidden` attribute is not enough: `.invite-signup { display: flex }` would override it in a real browser).
 */
export function inviteDialogHtml(guest: boolean) {
  const signup = guest
    ? `<div class="invite-signup" hidden><span class="invite-signup-text">${infoCopy.signupFirst}</span>
      <button type="button" class="invite-signup-button">${infoCopy.signup}</button></div>`
    : '';
  return `<form method="dialog"><label id="invite-label" for="invite-code">输入邀请码</label>
      <input id="invite-code" name="code" autocomplete="one-time-code" maxlength="64" required aria-describedby="invite-state">
      <p id="invite-state" class="invite-state" role="status" aria-live="polite"></p>
      ${signup}
      <div class="invite-actions"><button type="button" class="invite-cancel">取消</button>
      <button type="button" class="invite-recover" hidden>核对原请求</button>
      <button type="submit">兑换</button></div></form>`;
}

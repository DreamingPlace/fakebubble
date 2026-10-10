import { ensure } from '../../../packages/domain/errors.ts';
import type { PlayerMailer } from '../identity/web-player-accounts.ts';
import type { AdminEmailBinding } from './web-admin-mail.ts';

const purposeName = { signup: '注册', bind: '绑定邮箱', reset: '重置密码' } as const;

/** Plain Chinese text only: a code (or the "already registered" notice), no links, no HTML, no tracking. */
export function playerMailText(message: {
  purpose: keyof typeof purposeName;
  kind: 'code' | 'registered';
  code: string | null;
}) {
  if (message.kind === 'registered')
    return '你已注册，可直接登录或重置密码。\n\n如果你想登录，请回到 FAKE 泡泡的登录页输入这个邮箱和你的密码；忘记密码时，可以在登录页选择“忘记密码”。\n若非本人操作，请忽略此邮件，不会有任何变化。';
  return `你的${purposeName[message.purpose]}验证码是：${message.code}\n\n请在 10 分钟内回到 FAKE 泡泡的页面输入。请勿转发此邮件或验证码，也不要告诉任何人。\n若非本人操作，请忽略此邮件。`;
}

/** Cloudflare's structured Email Sending binding. A timeout or error is reported to the caller and never retried here. */
export function cloudPlayerMailer(
  binding: AdminEmailBinding,
  from: string,
  waitUntil: (task: Promise<void>) => void,
): PlayerMailer {
  ensure(/^[a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(from), 'WEB_PLAYER_MAIL_CONFIG_INVALID');
  return {
    waitUntil,
    async send(message) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          binding.send({
            from,
            to: message.to,
            subject:
              message.kind === 'registered'
                ? 'FAKE 泡泡 · 你已注册'
                : `FAKE 泡泡 · ${purposeName[message.purpose]}验证码`,
            text: playerMailText(message),
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('PLAYER_EMAIL_TIMEOUT')), 10_000);
          }),
        ]);
        ensure(typeof result?.messageId === 'string' && result.messageId.length > 0, 'WEB_PLAYER_MAIL_RECEIPT_INVALID');
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

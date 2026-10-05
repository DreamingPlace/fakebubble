import { ensure } from '../../../packages/domain/errors.ts';
import type { AdminMailer } from '../web-account-admin.ts';

/** Cloudflare's structured Email Sending binding. No SMTP secret, HTML, tracking or raw MIME. */
export interface AdminEmailBinding {
  send(message: { from: string; to: string; subject: string; text: string }): Promise<{ messageId: string }>;
}
export function cloudAdminMailer(
  binding: AdminEmailBinding,
  from: string,
  waitUntil: (task: Promise<void>) => void,
): AdminMailer {
  ensure(/^[a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(from), 'WEB_ADMIN_MAIL_CONFIG_INVALID');
  return {
    waitUntil,
    async send(message) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          binding.send({
            from,
            to: message.to,
            subject: message.purpose === 'bind' ? 'FAKE 泡泡 · 管理员邮箱验证' : 'FAKE 泡泡 · 管理员密码重置',
            text: `你的${message.purpose === 'bind' ? '邮箱验证' : '密码重置'}码是：${message.code}\n\n请在 10 分钟内返回管理员页面输入。请勿转发此邮件或验证码。\n若非本人操作，请忽略此邮件。此操作不会授予或恢复管理权限。`,
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('ADMIN_EMAIL_TIMEOUT')), 10_000);
          }),
        ]);
        ensure(typeof result?.messageId === 'string' && result.messageId.length > 0, 'WEB_ADMIN_MAIL_RECEIPT_INVALID');
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

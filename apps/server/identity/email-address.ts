import { ensure } from '../../../packages/domain/errors.ts';

/** One address shape for administrators and players: trimmed, lower-cased, practical syntax, no display names. */
export function normalizeEmail(value: unknown, code: string) {
  ensure(typeof value === 'string' && value.length <= 254, code);
  const email = value.trim().toLowerCase();
  ensure(
    /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(
      email,
    ) &&
      !email.startsWith('.') &&
      !email.includes('..') &&
      !email.includes('.@') &&
      email.split('@')[0]!.length <= 64,
    code,
  );
  return email;
}

/** First character + *** + domain. What an administrator sees of a player's address. */
export function maskEmail(email: string) {
  const at = email.lastIndexOf('@');
  return at < 1 ? '***' : `${[...email.slice(0, at)][0]}***${email.slice(at)}`;
}

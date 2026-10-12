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

/**
 * The form of an address used ONLY to decide "one signup bonus per inbox" (logins keep normalizeEmail as is): everything
 * from the first '+' of the local part is dropped, for every domain; for gmail.com and googlemail.com the dots of the
 * local part go too and googlemail.com becomes gmail.com. Input is an already normalized address.
 */
export function bonusCanonicalEmail(emailNorm: string) {
  const at = emailNorm.lastIndexOf('@');
  let local = emailNorm.slice(0, at);
  let domain = emailNorm.slice(at + 1);
  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    local = local.replaceAll('.', '');
    domain = 'gmail.com';
  }
  return `${local}@${domain}`;
}

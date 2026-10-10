import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { ensure } from '../../../packages/domain/errors.ts';

// OWASP's 16 MiB scrypt profile; also exercised in native workerd, not just Node.
const prefix = 'scrypt-16384-8-5';
const derive = (password: string, salt: Buffer) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(password, salt, 32, { N: 16384, r: 8, p: 5, maxmem: 32 * 1024 * 1024 }, (error, value) =>
      error ? reject(error) : resolve(value),
    ),
  );
export function validateAdminPassword(value: unknown): asserts value is string {
  ensure(
    typeof value === 'string' &&
      [...value].length >= 8 &&
      [...value].length <= 18 &&
      Buffer.byteLength(value, 'utf8') <= 512,
    'ADMIN_PASSWORD_INVALID',
  );
}
// Existing passwords remain valid for login; only newly set passwords use the shorter policy.
export function validateAdminLoginPassword(value: unknown): asserts value is string {
  ensure(
    typeof value === 'string' &&
      [...value].length >= 8 &&
      [...value].length <= 128 &&
      Buffer.byteLength(value, 'utf8') <= 512,
    'ADMIN_PASSWORD_INVALID',
  );
}
/** Players: 8–128 bytes, any characters. Same scrypt format, so one verifier serves both namespaces. */
export function validatePlayerPassword(value: unknown): asserts value is string {
  ensure(
    typeof value === 'string' && Buffer.byteLength(value, 'utf8') >= 8 && Buffer.byteLength(value, 'utf8') <= 128,
    'PLAYER_PASSWORD_INVALID',
  );
}
async function hashSecret(password: string) {
  const salt = randomBytes(16),
    result = await derive(password, salt);
  return `${prefix}$${salt.toString('hex')}$${result.toString('hex')}`;
}
async function verifySecret(password: string, encoded: string | null) {
  const parts = encoded?.split('$');
  ensure(
    !parts ||
      (parts.length === 3 &&
        parts[0] === prefix &&
        /^[a-f0-9]{32}$/.test(parts[1]!) &&
        /^[a-f0-9]{64}$/.test(parts[2]!)),
    'WEB_ADMIN_PASSWORD_FORMAT_INVALID',
  );
  // Unknown identities pay the same KDF cost; no quick email-existence oracle.
  const result = await derive(password, Buffer.from(parts?.[1] ?? '0'.repeat(32), 'hex'));
  return timingSafeEqual(result, Buffer.from(parts?.[2] ?? '0'.repeat(64), 'hex')) && encoded !== null;
}
export const adminPasswords = {
  async hash(password: string) {
    validateAdminPassword(password);
    return hashSecret(password);
  },
  async verify(password: string, encoded: string | null) {
    validateAdminLoginPassword(password);
    return verifySecret(password, encoded);
  },
};
export const playerPasswords = {
  async hash(password: string) {
    validatePlayerPassword(password);
    return hashSecret(password);
  },
  async verify(password: string, encoded: string | null) {
    validatePlayerPassword(password);
    return verifySecret(password, encoded);
  },
};

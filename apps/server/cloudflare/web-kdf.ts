import { DomainError } from '../../../packages/domain/errors.ts';
import { WEB_KDF_LIMITS } from '../../../config/web-v1.ts';
import { WEB_KDF_ERROR_CODES, type WebKdfBinding } from '../../../packages/contracts/web-kdf-rpc.ts';
import {
  hashSecret,
  verifySecret,
  validateAdminLoginPassword,
  validateAdminPassword,
  validatePlayerPassword,
  type PasswordService,
} from '../admin/web-admin-password.ts';

/** The stored format: the only thing `hash` may return. A hash in any other shape is never trusted or stored. */
const STORED_HASH = /^scrypt-16384-8-5\$[a-f0-9]{32}\$[a-f0-9]{64}$/;
const known = new Set<string>(WEB_KDF_ERROR_CODES);

let running = 0;
/** One hash computes at a time in an isolate (it is one thread: two could not run side by side anyway). */
let computing: Promise<void> = Promise.resolve();
/**
 * The entrypoint's side: what it does with one call. Refuses beyond the isolate's budget (no queue: the business object queues)
 * and turns every failure into an Error whose message is a fixed code - nothing from the password or the stored hash.
 */
export async function serveKdf<T>(work: () => Promise<T>): Promise<T> {
  if (running >= WEB_KDF_LIMITS.isolateConcurrent) throw new Error('RATE_LIMITED');
  running++;
  try {
    // Hashing is synchronous CPU in workerd. Taking turns, with one event-loop turn before each hash, lets a request that is
    // already waiting in this process (a chat poll) be served between two hashes instead of after all of them. It also
    // means one scrypt working set is live at a time, whatever the number admitted.
    const before = computing;
    let finished!: () => void;
    computing = new Promise<void>((resolve) => (finished = resolve));
    await before;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    try {
      return await work();
    } finally {
      finished();
    }
  } catch (error) {
    const code = error instanceof DomainError ? error.code : '';
    throw new Error(known.has(code) ? code : 'WEB_KDF_FAILED');
  } finally {
    running--;
  }
}
const passwordInput = (value: unknown): value is string =>
  typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= WEB_KDF_LIMITS.passwordMaxBytes;
export const kdfHash = (password: unknown) =>
  serveKdf(async () => {
    if (!passwordInput(password)) throw new DomainError('WEB_KDF_FAILED');
    return hashSecret(password);
  });
export const kdfVerify = (password: unknown, encoded: unknown) =>
  serveKdf(async () => {
    if (!passwordInput(password) || !(encoded === null || (typeof encoded === 'string' && encoded.length <= 256)))
      throw new DomainError('WEB_KDF_FAILED');
    return verifySecret(password, encoded);
  });

/** The business object's side: the same two policies as before (validated HERE, before anything crosses), then one RPC. */
export function remotePasswords(binding: WebKdfBinding | undefined): {
  admin: PasswordService;
  player: PasswordService;
} {
  const call = async <T>(work: (kdf: WebKdfBinding) => Promise<T>): Promise<T> => {
    if (!binding) throw new DomainError('WEB_KDF_UNAVAILABLE');
    try {
      return await work(binding);
    } catch (error) {
      // Only a fixed code comes back: the message of whatever was thrown is dropped, so nothing from the far side is logged.
      const message = error instanceof Error ? error.message : '';
      throw new DomainError(known.has(message) ? message : 'WEB_KDF_FAILED');
    }
  };
  const hash = async (password: string) => {
    const value = await call((kdf) => kdf.hash(password));
    if (typeof value !== 'string' || !STORED_HASH.test(value)) throw new DomainError('WEB_KDF_FAILED');
    return value;
  };
  const verify = async (password: string, encoded: string | null) => {
    const value = await call((kdf) => kdf.verify(password, encoded));
    if (typeof value !== 'boolean') throw new DomainError('WEB_KDF_FAILED');
    return value;
  };
  return {
    admin: {
      hash: async (password) => (validateAdminPassword(password), hash(password)),
      verify: async (password, encoded) => (validateAdminLoginPassword(password), verify(password, encoded)),
    },
    player: {
      hash: async (password) => (validatePlayerPassword(password), hash(password)),
      verify: async (password, encoded) => (validatePlayerPassword(password), verify(password, encoded)),
    },
  };
}

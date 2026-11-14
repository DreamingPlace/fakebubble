/**
 * Part 32 (audit F-08): the one internal RPC that carries a password. The business Worker script's stateless entrypoint
 * (`WebKdfService`, bound to itself as KDF) computes; the business object stays the only writer and sends nothing else.
 * Errors cross as an Error whose message is one of the fixed codes below, never anything derived from the password.
 */
export interface WebKdfBinding {
  /** A new `scrypt-16384-8-5$<salt hex>$<tag hex>` hash of the password. */
  hash(password: string): Promise<string>;
  /** Timing-safe verdict. `encoded === null` (an unknown identity) pays the same cost and answers false. */
  verify(password: string, encoded: string | null): Promise<boolean>;
}
export const WEB_KDF_ERROR_CODES = ['RATE_LIMITED', 'WEB_ADMIN_PASSWORD_FORMAT_INVALID', 'WEB_KDF_FAILED'] as const;

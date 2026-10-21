import { createHash } from 'node:crypto';
import type { Clock } from '../../../packages/contracts/index.ts';
import { DomainError } from '../../../packages/domain/errors.ts';

/**
 * Cloudflare Turnstile (Part 17, flag TURNSTILE_ENABLED, default off). The business object verifies every token
 * server-side with siteverify before it creates a guest, sends a signup / reset / bind code or checks a login.
 *
 * - Fail closed: no token, a malformed token, a failed verification, a token meant for another action or another
 *   hostname, and an unreachable siteverify all refuse the request.
 * - Each token works once. The digest is claimed BEFORE the verification, so two concurrent requests with one token can
 *   not both pass; only an unreachable siteverify gives the claim back (the token was not spent, so the retry may use it).
 *   Turnstile itself also rejects a second use of a token (timeout-or-duplicate): two independent checks.
 * - The secret never leaves this module's verifier; nothing here is logged; the token itself is never stored, only its digest.
 */
export type HumanAction = 'guest' | 'code' | 'login';

export interface TurnstileVerdict {
  success: boolean;
  hostname?: string | undefined;
  action?: string | undefined;
}
export interface TurnstileVerifier {
  /** Throws when siteverify cannot be reached or answers nonsense (the gate then refuses with TURNSTILE_UNAVAILABLE). */
  verify(input: { secret: string; token: string; remoteIp: string | null }): Promise<TurnstileVerdict>;
}

export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
/**
 * The real verifier. Tests inject a fake one: no test ever reaches the network. `url` exists only so the workerd test can
 * point the real fetch call at a local stub; the production caller never passes it.
 */
export function siteverifyVerifier(fetchImpl: typeof fetch = fetch, url: string = SITEVERIFY_URL): TurnstileVerifier {
  return {
    async verify({ secret, token, remoteIp }) {
      const body = new URLSearchParams({ secret, response: token });
      if (remoteIp) body.set('remoteip', remoteIp);
      const response = await fetchImpl(url, {
        method: 'POST',
        body,
        signal: AbortSignal.timeout(5000),
        // workerd rejects redirect:'error' before dispatch (every call became TURNSTILE_UNAVAILABLE). 'manual' hands a 3xx
        // back as a non-200 answer, which throws below and fails closed.
        redirect: 'manual',
      });
      if (response.status !== 200) throw new Error('TURNSTILE_HTTP');
      const value: unknown = await response.json();
      if (value === null || typeof value !== 'object' || typeof (value as { success?: unknown }).success !== 'boolean')
        throw new Error('TURNSTILE_BODY');
      const verdict = value as { success: boolean; hostname?: unknown; action?: unknown };
      return {
        success: verdict.success,
        hostname: typeof verdict.hostname === 'string' ? verdict.hostname : undefined,
        action: typeof verdict.action === 'string' ? verdict.action : undefined,
      };
    },
  };
}

const TOKEN_LIFETIME_MS = 10 * 60_000; // Turnstile tokens expire after 5 minutes
const SOFT_LIMIT = 5000;
const HARD_LIMIT = 20_000;

export class TurnstileGate {
  readonly siteKey: string;
  private readonly secret: string;
  private readonly hostname: string;
  private readonly verifier: TurnstileVerifier;
  private readonly clock: Clock;
  private readonly used = new Map<string, number>();
  constructor(options: { siteKey: string; secret: string; origin: string; verifier: TurnstileVerifier; clock: Clock }) {
    this.siteKey = options.siteKey;
    this.secret = options.secret;
    this.hostname = new URL(options.origin).hostname;
    this.verifier = options.verifier;
    this.clock = options.clock;
  }
  private prune(now: number) {
    for (const [digest, until] of this.used) if (until <= now) this.used.delete(digest);
  }
  async require(token: string | null | undefined, action: HumanAction, remoteIp: string | null) {
    if (token === null || token === undefined || token === '') throw new DomainError('TURNSTILE_REQUIRED');
    if (token.length > 2048 || !/^[A-Za-z0-9._-]+$/.test(token)) throw new DomainError('TURNSTILE_FAILED');
    const now = this.clock.now();
    if (this.used.size >= SOFT_LIMIT) this.prune(now);
    if (this.used.size >= HARD_LIMIT) throw new DomainError('TURNSTILE_UNAVAILABLE');
    const digest = createHash('sha256').update(token).digest('hex');
    const until = this.used.get(digest);
    if (until !== undefined && until > now) throw new DomainError('TURNSTILE_FAILED');
    this.used.set(digest, now + TOKEN_LIFETIME_MS);
    let verdict: TurnstileVerdict;
    try {
      verdict = await this.verifier.verify({ secret: this.secret, token, remoteIp });
    } catch {
      this.used.delete(digest);
      throw new DomainError('TURNSTILE_UNAVAILABLE');
    }
    if (
      verdict.success !== true ||
      (verdict.hostname !== undefined && verdict.hostname !== this.hostname) ||
      (verdict.action !== undefined && verdict.action !== action)
    )
      throw new DomainError('TURNSTILE_FAILED');
  }
}

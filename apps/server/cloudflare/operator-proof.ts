import { createHmac, timingSafeEqual } from 'node:crypto';
import { ensure } from '../../../packages/domain/errors.ts';

const LABEL = 'fakebubble-operator-v1';

/**
 * Proof that a call to a Durable Object operator method came from the business worker's WebOperatorService.
 * The on/off switch is decided only there, from its fresh per-request env; the object (whose env is fixed when the
 * instance starts) never reads OPERATOR_ENABLED and only checks this proof.
 *
 * The key is SEAL_KEY: an existing secret that only the business worker binds (the edge worker holds the BUSINESS
 * namespace binding but no SEAL_KEY), so the edge can reach the object's fetch() yet can never produce this value.
 * No new secret and no deploy-step change; the fixed label keeps the proof from being a usable seal under that key.
 */
export function operatorProof(sealKey: string): string {
  return createHmac('sha256', Buffer.from(sealKey, 'base64url')).update(LABEL).digest('hex');
}

/** Constant-time comparison; anything that is not the exact proof fails with one code. */
export function requireOperatorProof(sealKey: string, proof: unknown): void {
  const expected = Buffer.from(operatorProof(sealKey), 'utf8');
  const given = Buffer.from(typeof proof === 'string' ? proof : '', 'utf8');
  const padded = Buffer.alloc(expected.length);
  given.copy(padded, 0, 0, expected.length);
  const ok = timingSafeEqual(padded, expected) && given.length === expected.length;
  ensure(ok, 'WEB_CLOUD_OPERATOR_PROOF_INVALID');
}

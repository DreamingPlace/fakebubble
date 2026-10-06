import { createHash } from 'node:crypto';

/** v1: exact JSON wire body plus routing/model; no Authorization, credentials or request content leaves this function. */
export function providerRequestHash(endpoint: string, model: string, body: string): string {
  return createHash('sha256')
    .update(JSON.stringify(['provider-request-v1', 'POST', endpoint, 'application/json', model, body]))
    .digest('hex');
}

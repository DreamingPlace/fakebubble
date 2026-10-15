import { SITEVERIFY_URL, TurnstileGate, siteverifyVerifier } from '../../../apps/server/identity/web-turnstile.ts';
import { DomainError } from '../../../packages/domain/errors.ts';

// Runs the REAL siteverifyVerifier fetch call (the default global fetch) inside workerd. Only the URL differs from
// production, and only here: the stub is reached through the Miniflare outbound service.
export default {
  async fetch(request: Request) {
    const stub = new URL(request.url).searchParams.get('case') ?? 'ok';
    const gate = new TurnstileGate({
      siteKey: 'site',
      secret: 'secret',
      origin: 'https://example.test',
      verifier: siteverifyVerifier(fetch, `https://stub.invalid/siteverify?case=${stub}`),
      clock: { now: () => Date.now() } as never,
    });
    try {
      await gate.require('token-' + stub, 'guest', '203.0.113.7');
      return Response.json({ ok: true, production: SITEVERIFY_URL });
    } catch (error) {
      return Response.json({ ok: false, code: error instanceof DomainError ? error.code : String(error) });
    }
  },
};

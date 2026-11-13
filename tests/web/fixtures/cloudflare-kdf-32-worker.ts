import { DurableObject } from 'cloudflare:workers';
import { DomainError } from '../../../packages/domain/errors.ts';
import { remotePasswords } from '../../../apps/server/cloudflare/web-kdf.ts';
import { playerPasswords } from '../../../apps/server/admin/web-admin-password.ts';
import { KdfGate } from '../../../apps/server/identity/kdf-gate.ts';
import { PLAYER_LIMITS } from '../../../apps/server/identity/web-player-accounts.ts';
import type { WebKdfBinding } from '../../../packages/contracts/web-kdf-rpc.ts';
// The real entrypoint, exported from the real business Worker script (the same module the deploy uses).
export { WebKdfService } from '../../../workers/web-cloudflare/business.ts';

type Env = { KDF: WebKdfBinding; PROBE: DurableObjectNamespace<KdfProbe> };
type Body = { password?: string; encoded?: string | null; kind?: 'admin' | 'player'; inline?: boolean };

/**
 * Part 32 test object: the business object's side of the KDF split, nothing else. It uses the same gate class, the same
 * limits and the same client as the production object (`remotePasswords` + `KdfGate(PLAYER_LIMITS)`), and answers a code only.
 * `inline` is the control: the same gate around the old in-process hash.
 */
export class KdfProbe extends DurableObject<Env> {
  private readonly gate = new KdfGate(PLAYER_LIMITS.kdfConcurrent, PLAYER_LIMITS.kdfWaiting);
  async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === '/poll') return Response.json({ ok: true });
    const body = (await request.json()) as Body;
    // The entrypoint called directly, past the client's policy: what a malformed call looks like from the far side.
    if (url.pathname === '/raw-hash') {
      try {
        return Response.json({ hash: await this.env.KDF.hash(body.password as string) });
      } catch (error) {
        return Response.json({ message: error instanceof Error ? error.message : 'OTHER' }, { status: 400 });
      }
    }
    const remote = remotePasswords(this.env.KDF),
      service = body.kind === 'admin' ? remote.admin : remote.player;
    try {
      if (url.pathname === '/hash') {
        const hash = await this.gate.run(() => (body.inline ? playerPasswords : service).hash(body.password as string));
        return Response.json({ hash });
      }
      if (url.pathname === '/verify') {
        const valid = await this.gate.run(() =>
          (body.inline ? playerPasswords : service).verify(body.password as string, body.encoded ?? null),
        );
        return Response.json({ valid });
      }
    } catch (error) {
      return Response.json({ error: error instanceof DomainError ? error.code : 'OTHER' }, { status: 400 });
    }
    return new Response(null, { status: 404 });
  }
}
export default {
  fetch(request: Request, env: Env) {
    return env.PROBE.get(env.PROBE.idFromName('probe')).fetch(request);
  },
};

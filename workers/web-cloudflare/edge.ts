import { DomainError, ensure } from '../../packages/domain/errors.ts';
import { CloudWebAssets } from '../../apps/server/cloudflare/web-assets.ts';
import type { AssetBinding } from '../../apps/server/cloudflare/admin-assets.ts';
import { safeError } from '../../apps/server/cloudflare/safe-error.ts';
import { WEB_EDGE_PEER_HEADER } from '../../apps/server/cloudflare/web-edge-request.ts';

export const WEB_CLOUD_COMPATIBILITY_FLAGS = ['nodejs_compat', 'enable_request_signal'] as const;
export interface WebBusinessEndpoint {
  fetch(request: Request): Promise<Response>;
}
export interface WebEdgeEnvironment {
  ORIGIN: string;
  BUSINESS_OBJECT_ID: string;
  ASSET_MANIFEST_SHA256: string;
  ASSETS: AssetBinding;
  BUSINESS: { idFromString(id: string): unknown; get(id: unknown): WebBusinessEndpoint };
}
const assets = new WeakMap<AssetBinding, { hash: string; reader: CloudWebAssets }>();
const api = '/api/web/provider/';
const headers = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000',
};
function staticAsset(request: Request, env: WebEdgeEnvironment) {
  let entry = assets.get(env.ASSETS);
  if (!entry || entry.hash !== env.ASSET_MANIFEST_SHA256) {
    entry = { hash: env.ASSET_MANIFEST_SHA256, reader: new CloudWebAssets(env.ASSETS, env.ASSET_MANIFEST_SHA256) };
    assets.set(env.ASSETS, entry);
  }
  return entry.reader.fetch(request);
}

/** Sole public entry. No credentials, database or generation binding, and no operator route. */
export default {
  async fetch(request: Request, env: WebEdgeEnvironment): Promise<Response> {
    let response: Response;
    try {
      const url = new URL(request.url),
        configured = new URL(env.ORIGIN);
      ensure(
        configured.protocol === 'https:' &&
          configured.origin === env.ORIGIN &&
          !configured.username &&
          !configured.password &&
          /^[a-f0-9]{64}$/.test(env.BUSINESS_OBJECT_ID),
        'WEB_EDGE_CONFIG_INVALID',
      );
      ensure(
        url.origin === env.ORIGIN &&
          !url.username &&
          !url.password &&
          (!request.headers.has('host') || request.headers.get('host') === url.host),
        'NOT_FOUND',
      );
      ensure(
        url.pathname.length + url.search.length <= 2048 &&
          !/[\\%]/.test(url.pathname) &&
          !url.pathname.startsWith('//'),
        'NOT_FOUND',
      );
      if (url.pathname.startsWith(api)) {
        const peer = request.headers.get('cf-connecting-ip');
        ensure(peer && peer.length <= 128 && /^[0-9a-fA-F:.]+$/.test(peer), 'WEB_EDGE_PEER_REQUIRED');
        const clean = new Headers(request.headers);
        for (const key of [...clean.keys()])
          if (
            key.startsWith('x-fixture-') ||
            key.startsWith('x-internal-') ||
            key.startsWith('x-forwarded-') ||
            key === 'forwarded' ||
            key === 'x-real-ip' ||
            key === 'authorization' ||
            key.startsWith('cf-')
          )
            clean.delete(key);
        clean.set(WEB_EDGE_PEER_HEADER, peer);
        // Native DO Fetch carries HTTP cancellation; a generic RPC Response did not
        // release the remote SSE slot on disconnect in actual workerd verification.
        response = await env.BUSINESS.get(env.BUSINESS.idFromString(env.BUSINESS_OBJECT_ID)).fetch(
          new Request(request, { headers: clean }),
        );
      } else {
        ensure(!url.pathname.startsWith('/api'), 'NOT_FOUND');
        ensure(request.method === 'GET' || request.method === 'HEAD', 'NOT_FOUND');
        if (url.pathname === '/' || url.pathname === '/index.html') {
          const modes = url.searchParams.getAll('mode');
          ensure(
            modes.length <= 1 && (!modes.length || ['provider', 'provider-admin'].includes(modes[0]!)),
            'NOT_FOUND',
          );
          if (!modes.length) {
            url.searchParams.set('mode', 'provider');
            response = new Response(null, { status: 302, headers: { location: url.pathname + url.search } });
          } else response = await staticAsset(request, env);
        } else {
          ensure(!url.search, 'NOT_FOUND');
          response = await staticAsset(request, env);
        }
      }
    } catch (error) {
      const missing = error instanceof DomainError && error.code === 'NOT_FOUND';
      if (!missing) console.error(JSON.stringify({ event: 'web_edge_unavailable', ...safeError(error) }));
      response = Response.json(
        { error: { code: missing ? 'NOT_FOUND' : 'SERVICE_UNAVAILABLE', requestId: null, retryAfterMs: null } },
        { status: missing ? 404 : 503 },
      );
    }
    // Subrequest responses may carry immutable headers; preserve stream/cookies without buffering.
    response = new Response(response.body, response);
    for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
    return response;
  },
};

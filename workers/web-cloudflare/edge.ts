import { DomainError, ensure } from '../../packages/domain/errors.ts';
import { CloudWebAssets } from '../../apps/server/cloudflare/web-assets.ts';
import type { AssetBinding } from '../../apps/server/cloudflare/admin-assets.ts';
import { safeError } from '../../apps/server/cloudflare/safe-error.ts';
import { WEB_EDGE_PEER_HEADER } from '../../apps/server/cloudflare/web-edge-request.ts';
import { SHARE_PAGE } from '../../apps/server/share/web-share-path.ts';

export const WEB_CLOUD_COMPATIBILITY_FLAGS = ['nodejs_compat', 'enable_request_signal'] as const;
/** The slice of the Workers execution context and Cache API the edge uses (both are absent in some test and local runtimes). */
export interface WebEdgeContext {
  waitUntil(promise: Promise<unknown>): void;
}
export interface WebEdgeCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}
export interface WebBusinessEndpoint {
  fetch(request: Request): Promise<Response>;
}
export interface WebEdgeEnvironment {
  ORIGIN: string;
  BUSINESS_OBJECT_ID: string;
  ASSET_MANIFEST_SHA256: string;
  ASSETS: AssetBinding;
  /** Part 17 switches, each off unless the string 'true'. TURNSTILE_ENABLED widens the CSP for Turnstile only. */
  TURNSTILE_ENABLED?: string;
  LEGAL_PAGES_ENABLED?: string;
  BUSINESS: { idFromString(id: string): unknown; get(id: unknown): WebBusinessEndpoint };
}
const assets = new WeakMap<AssetBinding, { key: string; reader: CloudWebAssets }>();
const api = '/api/web/provider/';
const headers = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000',
};
/** Part 48: hashed, immutable build files, exactly the paths the player build content-addresses (see playerAssetCacheControl). */
const IMMUTABLE = 'public, max-age=31536000, immutable';
const hashedAsset =
  /^\/assets\/(?:[A-Za-z0-9_-]+-[A-Z0-9]{8}\.js|static-[a-f0-9]{64}\.(?:css|svg|png|jpe?g|webp|woff2))$/;
function edgeCache(): WebEdgeCache | null {
  try {
    const store = (globalThis as { caches?: { default?: WebEdgeCache } }).caches?.default;
    return store && typeof store.match === 'function' && typeof store.put === 'function' ? store : null;
  } catch {
    return null;
  }
}
function staticAsset(request: Request, env: WebEdgeEnvironment) {
  const turnstile = env.TURNSTILE_ENABLED === 'true',
    legalPages = env.LEGAL_PAGES_ENABLED === 'true';
  const key = `${env.ASSET_MANIFEST_SHA256}:${turnstile}:${legalPages}`;
  let entry = assets.get(env.ASSETS);
  if (!entry || entry.key !== key) {
    entry = {
      key,
      reader: new CloudWebAssets(env.ASSETS, env.ASSET_MANIFEST_SHA256, { turnstile, legalPages }),
    };
    assets.set(env.ASSETS, entry);
  }
  return entry.reader.fetch(request);
}

/** Sole public entry. No credentials, database or generation binding, and no operator route. */
export default {
  async fetch(request: Request, env: WebEdgeEnvironment, context?: WebEdgeContext): Promise<Response> {
    let response: Response;
    let assetCache: string | null = null;
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
        // Part 31 (25e): a character's picture is public and content-addressed. It is fetched without the visitor's cookies and the edge
        // itself (never the business object's header) lets exactly this verified shape be cached.
        const picture =
          request.method === 'GET' && /^\/api\/web\/provider\/public-image\/[a-f0-9]{64}$/.test(url.pathname);
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
        // Part 48: the public catalog (the home cards before any session) is read without the visitor's cookies, like a picture:
        // nothing downstream can read a session from it, and the business object sets none.
        const catalog = request.method === 'GET' && url.pathname === `${api}catalog`;
        if (picture || catalog) clean.delete('cookie');
        clean.set(WEB_EDGE_PEER_HEADER, peer);
        // Native DO Fetch carries HTTP cancellation; a generic RPC Response did not
        // release the remote SSE slot on disconnect in actual workerd verification.
        response = await env.BUSINESS.get(env.BUSINESS.idFromString(env.BUSINESS_OBJECT_ID)).fetch(
          new Request(request, { headers: clean }),
        );
        if (picture && response.status === 200 && response.headers.get('content-type') === 'image/png') {
          response = new Response(response.body, response);
          response.headers.delete('set-cookie');
          assetCache = 'public, max-age=31536000, immutable';
        }
      } else {
        ensure(!url.pathname.startsWith('/api'), 'NOT_FOUND');
        ensure(request.method === 'GET' || request.method === 'HEAD', 'NOT_FOUND');
        if (SHARE_PAGE.test(url.pathname)) {
          // Part 45: a share link's page is the player's own index (the page reads the token from its address). Nothing is read or
          // stored here; there is no mode redirect, so the link stays exactly as it was shared.
          ensure(!url.search, 'NOT_FOUND');
          response = await staticAsset(new Request(new URL('/', url.origin), request), env);
          assetCache = response.headers.get('cache-control');
        } else if (url.pathname === '/' || url.pathname === '/index.html') {
          const modes = url.searchParams.getAll('mode');
          ensure(
            modes.length <= 1 && (!modes.length || ['provider', 'provider-admin'].includes(modes[0]!)),
            'NOT_FOUND',
          );
          // Part 48: the bare address serves the player at once (it used to answer a 302 to ?mode=provider, one more round trip on a
          // phone before anything could paint). The page treats "no mode" as the player; ?mode=provider and ?mode=provider-admin
          // are unchanged.
          response = await staticAsset(request, env);
          assetCache = response.headers.get('cache-control');
        } else {
          ensure(!url.search, 'NOT_FOUND');
          // Part 48: a hashed, immutable build file is kept in the edge's Cache API. Why this is safe: the path names the content
          // (a SHA-256 in the file name, or esbuild's content hash), the response comes from the manifest-verified reader (its bytes were
          // hashed against the signed manifest before they got here), the key also carries the manifest digest and the Turnstile switch
          // (the only things that change a build file's headers), and nothing here is per visitor: no cookie, no query, no API, no
          // HTML. A miss, a missing Cache API (workers.dev) or any cache error falls through to the verified reader.
          const cache = request.method === 'GET' && hashedAsset.test(url.pathname) ? edgeCache() : null;
          const key = cache
            ? new Request(
                `${env.ORIGIN}/__edge-asset/${env.ASSET_MANIFEST_SHA256}/${env.TURNSTILE_ENABLED === 'true'}${url.pathname}`,
              )
            : null;
          let hit: Response | undefined;
          if (cache && key) {
            try {
              hit = await cache.match(key);
            } catch {
              hit = undefined;
            }
          }
          if (hit && hit.status === 200 && hit.headers.get('cache-control') === IMMUTABLE) {
            response = new Response(hit.body, hit);
            response.headers.set('x-edge-asset-cache', 'hit');
          } else {
            response = await staticAsset(request, env);
            if (cache && key && response.status === 200 && response.headers.get('cache-control') === IMMUTABLE) {
              const stored = cache.put(key, response.clone()).catch(() => undefined);
              context?.waitUntil(stored);
            }
          }
          assetCache = response.headers.get('cache-control');
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
    // Only the verified static branch may override no-store; never trust an API cache header.
    if (assetCache && response.status === 200) response.headers.set('cache-control', assetCache);
    return response;
  },
};

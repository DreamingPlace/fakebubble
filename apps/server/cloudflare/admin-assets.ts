import { createHash } from 'node:crypto';
import { ensure } from '../../../packages/domain/errors.ts';
export interface AdminAsset {
  path: string;
  sha256: string;
  bytes: number;
  type: string;
  scripts: string[];
}
export interface AssetBinding {
  fetch(request: Request): Promise<Response>;
}
const types: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  png: 'image/png',
  woff2: 'font/woff2',
  woff: 'font/woff',
  rsc: 'text/x-component',
};
export function adminAssetType(path: string): string | undefined {
  if (
    !/^\/(?:[A-Za-z0-9_@-]+\/)*[A-Za-z0-9_@.-]+$/.test(path) ||
    path.split('/').some((s) => s.startsWith('.')) ||
    path.startsWith('/admin/')
  )
    return undefined;
  return types[path.split('.').at(-1)!];
}
/** Only listed public build files, fetched after Access/guard. No directory fallback or server-side code. */
export class CloudAdminAssets {
  readonly #entries = new Map<string, AdminAsset>();
  readonly #binding: AssetBinding;
  constructor(binding: AssetBinding, entries: readonly AdminAsset[]) {
    this.#binding = binding;
    let total = 0;
    ensure(Array.isArray(entries) && entries.length > 0 && entries.length <= 2000, 'INVALID_STATIC_MANIFEST');
    for (const entry of entries) {
      ensure(
        Object.keys(entry).sort().join(',') === 'bytes,path,scripts,sha256,type' &&
          !this.#entries.has(entry.path) &&
          typeof entry.path === 'string' &&
          typeof entry.type === 'string' &&
          adminAssetType(entry.path) === entry.type &&
          /^[a-f0-9]{64}$/.test(entry.sha256) &&
          Number.isSafeInteger(entry.bytes) &&
          entry.bytes > 0 &&
          entry.bytes <= 12_000_000 &&
          (total += entry.bytes) <= 64_000_000 &&
          Array.isArray(entry.scripts) &&
          entry.scripts.length <= 256 &&
          entry.scripts.every((s: unknown) => typeof s === 'string' && /^sha256-[A-Za-z0-9+/]{43}=$/.test(s)),
        'INVALID_STATIC_MANIFEST',
      );
      this.#entries.set(entry.path, structuredClone(entry));
    }
    ensure(this.#entries.has('/index.html'), 'UI_NOT_BUILT');
  }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    ensure(request.method === 'GET' && !url.search && !request.headers.has('range'), 'NOT_FOUND');
    const path = url.pathname === '/' ? '/index.html' : url.pathname,
      entry = this.#entries.get(path);
    ensure(entry, 'NOT_FOUND');
    const response = await this.#binding.fetch(new Request(new URL(path, url.origin), { redirect: 'manual' }));
    ensure(
      response.status === 200 && response.body && !response.headers.has('content-encoding'),
      'STATIC_ASSET_UNAVAILABLE',
    );
    const chunks: Uint8Array[] = [];
    let count = 0;
    const reader = response.body.getReader();
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        count += item.value.length;
        ensure(count <= entry.bytes, 'STATIC_ASSET_INTEGRITY');
        chunks.push(item.value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    const bytes = new Uint8Array(count);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    ensure(
      count === entry.bytes && createHash('sha256').update(bytes).digest('hex') === entry.sha256,
      'STATIC_ASSET_INTEGRITY',
    );
    return new Response(bytes, {
      headers: {
        'content-type': entry.type,
        'content-security-policy': `default-src 'self'; script-src 'self' ${entry.scripts.map((s) => "'" + s + "'").join(' ')}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; media-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
      },
    });
  }
}

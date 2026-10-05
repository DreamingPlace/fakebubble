import { createHash } from 'node:crypto';
import { ensure } from '../../../packages/domain/errors.ts';
import type { AssetBinding } from './admin-assets.ts';

const types: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  woff2: 'font/woff2',
};
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const safePath = (path: string) => path.split('/').every((part) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part));
const csp =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

/** Only the existing player build's hash allowlist. No SPA fallback, directory access or public manifest. */
export class CloudWebAssets {
  private readonly binding: AssetBinding;
  private readonly manifestHash: string;
  private manifest: Promise<Record<string, string>> | undefined;
  constructor(binding: AssetBinding, manifestHash: string) {
    ensure(/^[a-f0-9]{64}$/.test(manifestHash), 'PLAYER_BUILD_UNAVAILABLE');
    this.binding = binding;
    this.manifestHash = manifestHash;
  }
  private async bytes(url: URL, maximum: number) {
    const response = await this.binding.fetch(
      new Request(url, { redirect: 'manual', headers: { 'accept-encoding': 'identity' } }),
    );
    ensure(
      response.status === 200 && response.body && !response.headers.has('content-encoding'),
      'PLAYER_BUILD_UNAVAILABLE',
    );
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        ensure(size <= maximum, 'PLAYER_BUILD_UNAVAILABLE');
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }
  private async load(origin: string) {
    const bytes = await this.bytes(new URL('/player-manifest.json', origin), 65_536);
    ensure(hash(bytes) === this.manifestHash, 'PLAYER_BUILD_UNAVAILABLE');
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    ensure(value !== null && typeof value === 'object' && !Array.isArray(value), 'PLAYER_BUILD_UNAVAILABLE');
    const manifest = value as { version: unknown; files: unknown };
    ensure(
      Object.keys(value).sort().join(',') === 'files,version' &&
        manifest.version === 1 &&
        manifest.files !== null &&
        typeof manifest.files === 'object' &&
        !Array.isArray(manifest.files),
      'PLAYER_BUILD_UNAVAILABLE',
    );
    const entries = Object.entries(manifest.files);
    ensure(
      entries.length > 0 &&
        entries.length <= 256 &&
        entries.some(([path]) => path === 'index.html') &&
        entries.every(
          ([path, digest]) =>
            safePath(path) &&
            types[path.split('.').at(-1)!] &&
            typeof digest === 'string' &&
            /^[a-f0-9]{64}$/.test(digest),
        ),
      'PLAYER_BUILD_UNAVAILABLE',
    );
    return Object.fromEntries(entries) as Record<string, string>;
  }
  async fetch(request: Request) {
    const url = new URL(request.url),
      path = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    ensure(request.method === 'GET' || request.method === 'HEAD', 'NOT_FOUND');
    ensure(safePath(path) && !request.headers.has('range'), 'NOT_FOUND');
    this.manifest ??= this.load(url.origin);
    const manifest = await this.manifest,
      expected = manifest[path];
    ensure(expected, 'NOT_FOUND');
    const bytes = await this.bytes(new URL('/' + path, url.origin), 2_000_000);
    ensure(hash(bytes) === expected, 'PLAYER_BUILD_UNAVAILABLE');
    return new Response(request.method === 'HEAD' ? null : bytes, {
      headers: {
        'content-type': types[path.split('.').at(-1)!]!,
        'content-length': String(bytes.byteLength),
        'content-security-policy': csp,
      },
    });
  }
}

import { createHash } from 'node:crypto';
import { constants, existsSync, lstatSync, openSync, readFileSync, closeSync, fstatSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, resolve, sep } from 'node:path';

const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2' };
const safeSegment = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Static files are served only from a build-generated hash manifest, never by arbitrary paths. */
export function serveLocalStatic(req: IncomingMessage, res: ServerResponse, root: string): boolean {
  const raw = req.url?.split('?', 1)[0] ?? '';
  if (raw === '/health' || raw === '/api' || raw.startsWith('/api/')) return false;
  const unavailable = () => {
    res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify({ error: { code: 'PLAYER_BUILD_UNAVAILABLE', requestId: null, retryAfterMs: null } }));
  };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff' }); res.end(); return true;
  }
  const name = raw === '/' ? 'index.html' : raw.slice(1);
  if (!raw.startsWith('/') || raw.includes('%') || raw.includes('\\') ||
      !name.split('/').every(part => safeSegment.test(part) && part !== '.' && part !== '..')) {
    res.writeHead(404, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(); return true;
  }
  const manifestFile = join(root, 'player-manifest.json');
  if (!existsSync(manifestFile)) { unavailable(); return true; }
  try {
    if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink() ||
        !lstatSync(manifestFile).isFile() || lstatSync(manifestFile).isSymbolicLink())
      throw new Error('unsafe static root');
    const parsed: unknown = JSON.parse(readFileSync(manifestFile, 'utf8'));
    const manifest = parsed as { version?: unknown; files?: Record<string, unknown> };
    if (manifest.version !== 1 || !manifest.files || typeof manifest.files !== 'object' ||
        Object.keys(manifest.files).length > 256) throw new Error('invalid static manifest');
    const digest = manifest.files[name];
    if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) {
      res.writeHead(404, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(); return true;
    }
    const file = resolve(root, name);
    if (!file.startsWith(resolve(root) + sep)) throw new Error('static path escaped');
    let parent = resolve(root);
    for (const part of name.split('/').slice(0, -1)) {
      parent = join(parent, part);
      if (!lstatSync(parent).isDirectory() || lstatSync(parent).isSymbolicLink())
        throw new Error('unsafe static parent');
    }
    if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink())
      throw new Error('unsafe static file');
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes: Buffer;
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 2_000_000) throw new Error('invalid static file');
      bytes = readFileSync(fd);
    } finally { closeSync(fd); }
    if (createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error('static hash mismatch');
    const extension = name.slice(name.lastIndexOf('.'));
    const contentType = mime[extension];
    if (!contentType) throw new Error('static MIME denied');
    res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': bytes.length,
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
    res.end(req.method === 'HEAD' ? undefined : bytes);
  } catch { unavailable(); }
  return true;
}

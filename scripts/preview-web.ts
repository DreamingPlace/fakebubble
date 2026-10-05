import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { serveLocalStatic } from '../apps/server/web-local-static.ts';

// Static UI only: no database, credentials, provider calls, or externally bound port.
const root = fileURLToPath(new URL('../apps/player-web/dist/', import.meta.url));
const server = createServer((req, res) => {
  if (!serveLocalStatic(req, res, root)) {
    res.writeHead(404, { 'Cache-Control': 'no-store' }); res.end();
  }
});
server.listen(18530, '127.0.0.1', () => console.log('Static preview: http://127.0.0.1:18530/ (no AI or audio generation)'));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.close());

import { DurableObject } from 'cloudflare:workers';
import { createHash } from 'node:crypto';
import { WebHTTPFixture } from './cloudflare-http-worker.ts';
import edge from '../../../workers/web-cloudflare/edge.ts';
import type { DurableSQLStorage } from '../../../apps/server/cloudflare/store.ts';
import type { AlarmStorage } from '../../../apps/server/cloudflare/queue-alarm.ts';
import type { PrivateBucket } from '../../../apps/server/cloudflare/media-objects.ts';
import { trustedWebRequest } from '../../../apps/server/cloudflare/web-edge-request.ts';

/** Composes production edge and HTTP through a private DO Fetch, without provider/network access. */
export class WebEdgeFixture extends DurableObject {
  private readonly fixture: WebHTTPFixture;
  private aborted = 0;
  constructor(ctx: { storage: DurableSQLStorage & AlarmStorage; waitUntil(task: Promise<void>): void }, env: { MEDIA: PrivateBucket }) {
    super(ctx, env); this.fixture = new WebHTTPFixture(ctx, env);
  }
  assets() { return this.fixture.fetch(new Request('http://localhost/fixture/assets')); }
  async stats() { return { ...(await (await this.fixture.fetch(new Request('http://localhost/fixture/streams'))).json() as object), aborted: this.aborted }; }
  alarm() { return this.fixture.alarm(); }
  fetch(incoming: Request) {
    const { request, peer } = trustedWebRequest(incoming);
    request.signal.addEventListener('abort', () => this.aborted++); return this.fixture.handle(request, peer);
  }
}
const files: Record<string, string> = { 'index.html': '<!doctype html><title>OFFLINE EDGE FIXTURE</title>' };
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
files['player-manifest.json'] = JSON.stringify({ version: 1, files: { 'index.html': digest(files['index.html']!) } });
const ASSETS = { async fetch(request: Request) {
  const value = files[new URL(request.url).pathname.slice(1)];
  return new Response(value ?? null, { status: value === undefined ? 404 : 200 });
} };
let aborted = 0;
export default { fetch(request: Request, env: { STATE: {
  idFromName(name: string): { toString(): string }; idFromString(id: string): unknown;
  get(id: unknown): { assets(): Promise<Response>; stats(): Promise<object>; fetch(request: Request): Promise<Response> };
} }) {
  const id = env.STATE.idFromName('edge');
  if (new URL(request.url).pathname === '/fixture/assets') return env.STATE.get(id).assets();
  if (new URL(request.url).pathname === '/fixture/streams') return env.STATE.get(id).stats().then(value => Response.json({ ...value, edgeAborted: aborted }));
  request.signal.addEventListener('abort', () => aborted++);
  // Only local test transport correction; production edge uses the real host unchanged.
  const headers = new Headers(request.headers);
  headers.set('host', headers.get('x-fixture-host') ?? 'fixture.invalid'); headers.delete('x-fixture-host');
  return edge.fetch(new Request(request, { headers }), { ORIGIN: 'https://fixture.invalid',
    BUSINESS_OBJECT_ID: id.toString(), BUSINESS: env.STATE,
    ASSET_MANIFEST_SHA256: digest(files['player-manifest.json']!), ASSETS });
} };

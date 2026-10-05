import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Miniflare } from 'miniflare';
import { testModules } from './modules.ts';

export function localRuntime(t: TestContext, entry: string, objects: Record<string, string>, buckets: string[] = [], services: { binding: string; entry: string; entrypoint: string }[] = [], flags: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'cf2-local-'));
  const migrations = readdirSync('apps/server/migrations').filter(f => /^\d+.*\.sql$/.test(f)).sort()
    .map((name, i) => ({ version: i + 1, sql: readFileSync(join('apps/server/migrations', name), 'utf8') }));
  let externalRequests = 0;
  const options = { modules: testModules(entry), modulesRoot: resolve('.'), compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat', ...flags],
    durableObjects: Object.fromEntries(Object.entries(objects).map(([name, className]) => [name, { className, useSQLite: true }])), durableObjectsPersist: dir,
    r2Buckets: buckets, r2Persist: join(dir, 'r2'),
    bindings: { MIGRATIONS: JSON.stringify(migrations) }, outboundService: () => { externalRequests++; return new Response('Forbidden', { status: 403 }); } };
  const config = services.length ? { durableObjectsPersist: dir, r2Persist: join(dir, 'r2'), workers: [
    { ...options, name: 'business', serviceBindings: Object.fromEntries(services.map(s => [s.binding, { name: s.binding, entrypoint: s.entrypoint }])) },
    ...services.map(s => ({ name: s.binding, modules: testModules(s.entry), modulesRoot: resolve('.'), compatibilityDate: options.compatibilityDate,
      compatibilityFlags: options.compatibilityFlags, outboundService: options.outboundService })),
  ] } : options;
  let mf = new Miniflare(config);
  t.after(async () => { await mf.dispose(); rmSync(dir, { recursive: true, force: true }); assert.equal(externalRequests, 0); });
  return {
    request: (url: string, init?: Parameters<Miniflare['dispatchFetch']>[1]) => mf.dispatchFetch(url, init),
    async call<T>(path: string, body?: unknown, status = 200, bearer?: string): Promise<T> {
      const response = await mf.dispatchFetch('http://localhost' + path, { ...(bearer ? { headers: { authorization: bearer } } : {}),
        ...(body === undefined ? {} : { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }) });
      const bodyText = await response.text(); assert.equal(response.status, status, bodyText); return JSON.parse(bodyText) as T;
    },
    async restart() { await mf.dispose(); mf = new Miniflare(config); },
  };
}

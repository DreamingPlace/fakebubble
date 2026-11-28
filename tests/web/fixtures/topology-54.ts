import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Miniflare } from 'miniflare';
import { testModules } from '../../cloudflare/modules.ts';
import { syntheticSelection } from './provider-selection.ts';
import { syntheticTone } from '../../../apps/server/platform/web-local-fake.ts';
import { WEB_PROVIDER_WELCOME } from '../../../config/web-v1.ts';
import { SYNTHETIC_TRIAL_FOOTER } from '../../../apps/server/conversation/web-vertical-publisher.ts';
import { webMaterialHash, type WebCloudMaterialPackage } from '../../../apps/server/cloudflare/web-setup.ts';
import { budgetHash, type CloudBudgetAuthorization } from '../../../apps/server/budget/web-provider-budget-contract.ts';
import { parseWebProviderBootstrap } from '../../../packages/contracts/web-provider.ts';

/** Part 54: the production topology (edge, business Durable Object, budget, generation) with a fake PROVIDER NETWORK only. */
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export type Latency = [min: number, max: number];
/** Everything the fake provider network does. `scale` multiplies every wait (1 = the real figures in the report). */
export interface ProviderModel {
  scale: number;
  draft: Latency;
  review: Latency;
  voice: Latency;
  /** Every Nth provider call is slow (slowMs) instead of the figures above. 0 = never. */
  slowEvery: number;
  slowMs: number;
  /** The first N calls of that stage never answer. 0 = none. */
  hangFirst: number;
  hangStage: 'draft' | 'review' | 'speech';
  /** Calls in flight above this get HTTP 429 (a provider concurrency limit). 0 = unlimited. */
  providerLimit: number;
}
export const REALISTIC: ProviderModel = {
  scale: 1,
  draft: [2000, 5000],
  review: [2000, 5000],
  voice: [3000, 8000],
  slowEvery: 20,
  slowMs: 15000,
  hangFirst: 0,
  hangStage: 'draft',
  providerLimit: 0,
};
export interface Topology54 {
  call(value: unknown, status?: number): ReturnType<Miniflare['dispatchFetch']>;
  restart(): Promise<void>;
  install(): Promise<void>;
  configure(model: Partial<ProviderModel>): Promise<void>;
  stats(): Promise<GenerationStats>;
  business(path: string): Promise<any>;
  newPlayer(n: number): Promise<Player>;
  send(player: Player, text?: string, delivery?: 'voice' | 'text'): Promise<string>;
  poll(player: Player, operationId: string, timeoutMs: number): Promise<any>;
  businessId: string;
  logs: string[];
}
export interface Player {
  cookie: string;
  csrf: string;
  ip: string;
}
export interface GenerationStats {
  calls: { stage: string; start: number; end: number; outcome: string }[];
  maxInFlight: number;
  opens: number;
  /** Calls the business object made to generation for replies (runText + runSpeech). */
  roundTrips: number;
}
export async function topology54(
  t: TestContext,
  entry = 'tests/web/fixtures/cloudflare-generation-54-worker.ts',
  env: Record<string, string> = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'web-54-'));
  const wav = syntheticTone(),
    selected = syntheticSelection();
  const material: WebCloudMaterialPackage = {
    selected,
    assets: selected.flatMap((item) =>
      (['welcome', 'footer'] as const).map((kind) => ({
        kind,
        characterId: item.characterId,
        voiceVersion: item.voice.voiceVersion,
        body: kind === 'welcome' ? WEB_PROVIDER_WELCOME[item.characterId].text : SYNTHETIC_TRIAL_FOOTER,
        sha256: hash(wav),
        byteLength: wav.length,
      })),
    ),
  };
  const shell = '<!doctype html><title>OFFLINE TOPOLOGY 54</title>';
  const manifest = JSON.stringify({ version: 1, files: { 'index.html': hash(shell) } });
  const logs: string[] = [];
  let outbound = 0;
  const build = (name: string, entryPath: string) => ({
    name,
    modules: testModules(entryPath),
    modulesRoot: resolve('.'),
    compatibilityDate: '2026-07-30',
    compatibilityFlags: ['nodejs_compat', 'enable_request_signal'],
    outboundService: () => {
      outbound++;
      return new Response(null, { status: 403 });
    },
  });
  const business = {
    ...build('business', 'tests/web/fixtures/cloudflare-business-54-worker.ts'),
    bindings: {
      INSTANCE_ID: '00000000-0000-4000-8000-000000000001',
      RECOVERY_EPOCH: '00000000-0000-4000-8000-000000000002',
      BUSINESS_OBJECT_ID: '0'.repeat(64),
      ORIGIN: 'https://fixture.invalid',
      COOKIE_NAME: '__Host-fixture',
      IP_KEY: Buffer.alloc(32, 1).toString('base64url'),
      SEAL_KEY: Buffer.alloc(32, 2).toString('base64url'),
      REQUEST_KEY: Buffer.alloc(32, 3).toString('base64url'),
      CURSOR_KEY: Buffer.alloc(32, 4).toString('base64url'),
      MATERIAL_PACKAGE_SHA256: webMaterialHash(material),
      BUDGET_GRANT_HASHES: '{}',
      BUDGET_POLICY: 'production-unlimited',
      PUBLIC_ENABLED: 'true',
      EXTERNAL_CALLS: 'true',
      OPERATOR_ENABLED: 'true',
      ...env,
    } as Record<string, string>,
    durableObjects: { BUSINESS: { className: 'WebBusinessObject', useSQLite: true } },
    r2Buckets: { MEDIA: 'private-web-media' },
    serviceBindings: {
      BUDGET: { name: 'budget', entrypoint: 'WebBudgetService' },
      GENERATION: { name: 'generation', entrypoint: 'SyntheticWebGenerationService' },
    },
  };
  const budget = {
    ...build('budget', 'workers/web-cloudflare/budget.ts'),
    bindings: {
      ACCOUNT_ID: 'a'.repeat(32),
      BUDGET_NAMESPACE_ID: 'b'.repeat(32),
      BUDGET_OBJECT_ID: '0'.repeat(64),
      OPERATOR_ENABLED: 'true',
    },
    durableObjects: { BUDGET: { className: 'WebBudgetObject', useSQLite: true } },
  };
  const edge = {
    ...build('edge', 'workers/web-cloudflare/edge.ts'),
    bindings: {
      ORIGIN: 'https://fixture.invalid',
      BUSINESS_OBJECT_ID: '0'.repeat(64),
      ASSET_MANIFEST_SHA256: hash(manifest),
    },
    durableObjects: { BUSINESS: { className: 'WebBusinessObject', scriptName: 'business', useSQLite: true } },
    serviceBindings: {
      ASSETS: (request: Request) => {
        const path = new URL(request.url).pathname;
        return new Response(path === '/index.html' ? shell : path === '/player-manifest.json' ? manifest : null, {
          status: ['/index.html', '/player-manifest.json'].includes(path) ? 200 : 404,
        });
      },
    },
  };
  const options = {
    handleRuntimeStdio: (out: import('node:stream').Readable, err: import('node:stream').Readable) => {
      for (const stream of [out, err]) stream.on('data', (chunk: Buffer) => logs.push(String(chunk)));
    },
    durableObjectsPersist: root,
    r2Persist: join(root, 'r2'),
    workers: [
      {
        ...build('driver', 'tests/web/fixtures/cloudflare-production-driver.ts'),
        serviceBindings: {
          OPERATOR: { name: 'business', entrypoint: 'WebOperatorService' },
          BUDGET_OPERATOR: { name: 'budget', entrypoint: 'WebBudgetOperatorService' },
          GENERATION: { name: 'generation', entrypoint: 'SyntheticWebGenerationService' },
          EDGE: 'edge',
          BUSINESS_HTTP: 'business',
          BUDGET_HTTP: 'budget',
          GENERATION_HTTP: 'generation',
        },
      },
      edge,
      business,
      budget,
      build('generation', entry),
    ],
  };
  let mf = new Miniflare(options);
  t.after(async () => {
    await mf.dispose();
    rmSync(root, { recursive: true, force: true });
    assert.equal(outbound, 0);
  });
  type Namespace = { idFromName(name: string): { toString(): string } };
  const businessId = ((await mf.getDurableObjectNamespace('BUSINESS', 'business')) as unknown as Namespace)
    .idFromName('business')
    .toString();
  const budgetId = ((await mf.getDurableObjectNamespace('BUDGET', 'budget')) as unknown as Namespace)
    .idFromName('budget')
    .toString();
  const grants: CloudBudgetAuthorization[] = (['deepseek', 'fish'] as const).map((provider) => ({
    id: `offline-${provider}`,
    accountId: budget.bindings.ACCOUNT_ID,
    namespaceId: budget.bindings.BUDGET_NAMESPACE_ID,
    objectId: budgetId,
    provider,
    createdAt: 1,
    version: 2 as const,
    purpose: 'production' as const,
    limit: 'unlimited' as const,
  }));
  business.bindings.BUSINESS_OBJECT_ID = edge.bindings.BUSINESS_OBJECT_ID = businessId;
  budget.bindings.BUDGET_OBJECT_ID = budgetId;
  business.bindings.BUDGET_GRANT_HASHES = JSON.stringify(
    Object.fromEntries(grants.map((g) => [g.provider, budgetHash(g)])),
  );
  const restart = async () => {
    await mf.dispose();
    mf = new Miniflare(options);
  };
  await restart();
  const call = async (value: unknown, status = 200) => {
    const response = await mf.dispatchFetch('http://localhost', { method: 'POST', body: JSON.stringify(value) });
    assert.equal(response.status, status, await response.clone().text());
    return response;
  };
  const api = '/api/web/provider';
  const self: Topology54 = {
    call,
    restart,
    logs,
    businessId,
    async install() {
      await call({ action: 'initialize', body: material });
      for (const asset of material.assets) await call({ action: 'asset', body: { ...asset, bytes: [...wav] } });
      await call({ action: 'budget-initialize', body: grants });
    },
    async configure(model) {
      await call({ action: 'generation-mode', body: JSON.stringify(model) });
    },
    async stats() {
      const rows = (await (await call({ action: 'generation-stats' })).json()) as string[];
      return JSON.parse(rows[0] ?? '{"calls":[],"maxInFlight":0,"opens":0,"roundTrips":0}') as GenerationStats;
    },
    async business(path) {
      return (await call({ action: 'business-http', path })).json();
    },
    async newPlayer(n) {
      const ip = `198.51.${Math.floor(n / 250)}.${(n % 250) + 1}`;
      const initial = await call({ action: 'edge', path: api + '/bootstrap', headers: { 'cf-connecting-ip': ip } });
      const cookie = initial.headers.get('set-cookie')!.split(';')[0]!;
      const boot = parseWebProviderBootstrap(await initial.json());
      return { cookie, csrf: boot.csrf, ip };
    },
    async send(player, text = '压力测试：今天过得怎么样？', delivery = 'voice') {
      const sent = (await (
        await call(
          {
            action: 'edge',
            path: api + '/characters/wei-guagua/operations',
            method: 'POST',
            headers: {
              cookie: player.cookie,
              origin: 'https://fixture.invalid',
              'x-csrf-token': player.csrf,
              'content-type': 'application/json',
              'cf-connecting-ip': player.ip,
            },
            body: { requestId: randomUUID(), text, delivery },
          },
          202,
        )
      ).json()) as any;
      return sent.operation.operationId as string;
    },
    async poll(player, operationId, timeoutMs) {
      let last: any;
      for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; ) {
        // A player's page polls about once a second; the edge's global request cap is respected, never worked around.
        const response = await mf.dispatchFetch('http://localhost', {
          method: 'POST',
          body: JSON.stringify({
            action: 'edge',
            path: api + '/operations/' + operationId,
            headers: { cookie: player.cookie, 'cf-connecting-ip': player.ip },
          }),
        });
        if (response.status === 200) {
          last = await response.json();
          if (['published', 'failed', 'cancelled', 'unknown'].includes(last.status)) return last;
        } else await response.text();
        await sleep(1200 + Math.random() * 600);
      }
      return last;
    },
  };
  return self;
}

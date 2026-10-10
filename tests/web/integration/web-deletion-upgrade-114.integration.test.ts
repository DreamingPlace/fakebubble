import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Miniflare } from 'miniflare';
import { testModules } from '../../cloudflare/modules.ts';
import { syntheticSelection } from '../fixtures/provider-selection.ts';
import { syntheticTone } from '../../../apps/server/platform/web-local-fake.ts';
import { WEB_PROVIDER_WELCOME } from '../../../config/web-v1.ts';
import { SYNTHETIC_TRIAL_FOOTER } from '../../../apps/server/conversation/web-vertical-publisher.ts';
import { webMaterialHash, type WebCloudMaterialPackage } from '../../../apps/server/cloudflare/web-setup.ts';
import { budgetHash, type CloudBudgetAuthorization } from '../../../apps/server/budget/web-provider-budget-contract.ts';
import { parseWebProviderBootstrap } from '../../../packages/contracts/web-provider.ts';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
async function fixture(t: test.TestContext, runtimeLogs?: string[]) {
  const retentionInspector = true,
    unlimitedProduction = false;
  const root = mkdtempSync(join(tmpdir(), 'web-production-'));
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
  const shell = '<!doctype html><title>OFFLINE PRODUCTION TOPOLOGY</title>';
  const manifest = JSON.stringify({ version: 1, files: { 'index.html': hash(shell) } });
  let outbound = 0;
  const build = (name: string, entry: string) => ({
    name,
    modules: testModules(entry),
    modulesRoot: resolve('.'),
    compatibilityDate: '2026-07-30',
    compatibilityFlags: ['nodejs_compat', 'enable_request_signal'],
    outboundService: () => {
      outbound++;
      return new Response(null, { status: 403 });
    },
  });
  const business = {
    ...build('business', 'tests/web/fixtures/cloudflare-production-113-worker.ts'),
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
      BUDGET_POLICY: unlimitedProduction ? 'production-unlimited' : 'test-cumulative',
      PUBLIC_ENABLED: 'true',
      EXTERNAL_CALLS: 'true',
      OPERATOR_ENABLED: 'true',
      LEGACY_113: 'true',
    },
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
    ...(runtimeLogs
      ? {
          handleRuntimeStdio: (out: import('node:stream').Readable, err: import('node:stream').Readable) => {
            for (const stream of [out, err]) stream.on('data', (chunk: Buffer) => runtimeLogs.push(String(chunk)));
          },
        }
      : {}),
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
      build('generation', 'tests/web/fixtures/cloudflare-generation-worker.ts'),
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
    ...(unlimitedProduction
      ? { version: 2 as const, purpose: 'production' as const, limit: 'unlimited' as const }
      : { version: 1 as const, micros: 2_999_700, priorSpentMicros: 100, priorHeldMicros: 200 }),
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
  return {
    business,
    budget,
    edge,
    grants,
    material,
    wav,
    businessId,
    restart,
    call,
    async install() {
      await call({ action: 'initialize', body: material });
      for (const asset of material.assets) await call({ action: 'asset', body: { ...asset, bytes: [...wav] } });
      await call({ action: 'budget-initialize', body: grants });
    },
  };
}

const api = '/api/web/provider';
const wait = async (read: () => Promise<boolean>, what: string) => {
  for (const deadline = Date.now() + 25_000; Date.now() < deadline; await sleep(100)) if (await read()) return;
  assert.fail(what);
};
type UpgradeState = {
  version: number;
  triggers: { name: string; sql: string }[];
  schema: { type: string; name: string; sql: string | null }[];
  deletionSchema: unknown[];
  items: { operation_id: string; ordinal: number; origin: string }[];
  attempts: { operation_id: string; phase: string; state: string; held_micros: number }[];
  spending: unknown[];
};
const deletionAware = (sql: string) => sql.includes('web_character_purge_gate');
const normalized = (sql: string) => sql.replace(/\s+/g, '');

test('production database at 113 with the deletion schema installed upgrades through 114-116 and the application starts', async (t) => {
  const f = await fixture(t);
  const state = async () =>
    (await (await f.call({ action: 'business-http', path: '/__test/upgrade-state' })).json()) as UpgradeState;
  await f.install();

  // What production looked like: the application ran on 113, so the deletion schema replaced the ten triggers.
  const players: { cookie: string; operationId: string; character: string }[] = [];
  for (const character of ['wei-guagua', 'jojo', 'chen-jimi']) {
    const initial = await f.call({ action: 'edge', path: api + '/bootstrap' });
    const cookie = initial.headers.get('set-cookie')!.split(';')[0]!,
      boot = parseWebProviderBootstrap(await initial.json());
    const sent = (await (
      await f.call(
        {
          action: 'edge',
          path: api + `/characters/${character}/operations`,
          method: 'POST',
          headers: {
            cookie,
            origin: 'https://fixture.invalid',
            'x-csrf-token': boot.csrf,
            'content-type': 'application/json',
          },
          body: { requestId: randomUUID(), text: '升级路径合成验收', delivery: 'voice' },
        },
        202,
      )
    ).json()) as any;
    await wait(
      async () =>
        ['published', 'failed', 'cancelled'].includes(
          (
            (await (
              await f.call({
                action: 'edge',
                path: api + '/operations/' + sent.operation.operationId,
                headers: { cookie },
              })
            ).json()) as any
          ).status,
        ),
      'operation did not finish',
    );
    players.push({ cookie, operationId: sent.operation.operationId, character });
  }
  const [guestA, guestB, guestC] = players as [(typeof players)[0], (typeof players)[0], (typeof players)[0]];
  await f.call({ action: 'business-http', path: `/__test/seed-unknown-speech?operation=${guestC.operationId}` });
  const old = await state();
  assert.equal(old.version, 113);
  assert.equal(old.triggers.length, 10);
  assert.ok(
    old.triggers.every((trigger) => deletionAware(trigger.sql)),
    'the old code left all ten guarded triggers deletion-aware',
  );
  assert.ok(old.items.length >= 3 && new Set(old.items.map((i) => i.operation_id)).size === 3);
  assert.equal(
    old.schema.some((row) => row.name === 'web_operation_metrics'),
    false,
    'no 114 table yet',
  );
  const unknown = old.attempts.filter((a) => a.state === 'unknown'),
    known = old.attempts.filter((a) => a.state === 'known');
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0]!.operation_id, guestC.operationId);
  assert.ok(known.length >= 4);

  // Restart on the current code: 114 (rebuilds web_publication_items), 115, 116 and 117 apply to the live database.
  // (Extended for migration 118.)
  f.business.bindings.LEGACY_113 = 'false';
  await f.restart();
  await f.call({ action: 'edge', path: api + '/bootstrap' }, 200);
  const upgraded = await state();
  assert.equal(upgraded.version, 118);
  assert.ok(upgraded.schema.some((row) => row.name === 'web_operation_metrics'));
  assert.deepEqual(
    upgraded.triggers,
    old.triggers,
    'every guarded trigger is the deletion-aware text again, byte for byte',
  );
  assert.deepEqual(upgraded.deletionSchema, old.deletionSchema, 'the stored digest is untouched');
  assert.deepEqual(upgraded.items, old.items, 'the rebuild kept every publication item');
  assert.deepEqual(upgraded.attempts, old.attempts, 'the UNKNOWN attempt stays UNKNOWN, known ones stay known');
  assert.deepEqual(upgraded.spending, old.spending, 'its reservation is still held');

  // A second start has nothing to repair and nothing to retry.
  await f.restart();
  await f.call({ action: 'edge', path: api + '/bootstrap' }, 200);
  const again = await state();
  assert.deepEqual(again.schema, upgraded.schema);
  assert.deepEqual(again.attempts, upgraded.attempts);
  assert.deepEqual(again.spending, upgraded.spending);
  assert.deepEqual(await (await f.call({ action: 'generation-stats' })).json(), [], 'nothing was sent to a provider');

  // The repaired trigger still lets the two real purge paths delete, and still refuses everything else.
  const ofOperation = (rows: UpgradeState['items'], id: string) => rows.filter((row) => row.operation_id === id);
  assert.ok(ofOperation(again.items, guestA.operationId).length > 0);
  const deleted = (await (
    await f.call({ action: 'business-http', path: `/__test/delete-character?character=${guestA.character}` })
  ).json()) as { state: string };
  assert.equal(deleted.state, 'deleted');
  const afterDeletion = await state();
  assert.equal(ofOperation(afterDeletion.items, guestA.operationId).length, 0, 'character deletion purged its items');
  assert.equal(
    ofOperation(afterDeletion.items, guestB.operationId).length,
    ofOperation(again.items, guestB.operationId).length,
  );
  assert.deepEqual(afterDeletion.triggers, old.triggers);

  await f.call({ action: 'business-http', path: `/__test/expire-character?character=${guestB.character}` });
  await wait(
    async () => ofOperation((await state()).items, guestB.operationId).length === 0,
    'guest retention did not purge the publication items',
  );
  const final = await state();
  assert.deepEqual(ofOperation(final.items, guestC.operationId), ofOperation(old.items, guestC.operationId));
  assert.deepEqual(
    final.attempts.filter((a) => a.operation_id === guestC.operationId),
    old.attempts.filter((a) => a.operation_id === guestC.operationId),
    'the UNKNOWN attempt survives both purges',
  );
  assert.deepEqual(final.triggers, old.triggers);
  assert.ok(final.triggers.every((trigger) => normalized(trigger.sql) !== ''));
});

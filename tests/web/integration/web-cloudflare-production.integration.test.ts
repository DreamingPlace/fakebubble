import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
async function fixture(
  t: test.TestContext,
  retentionInspector = false,
  unlimitedProduction = false,
  runtimeLogs?: string[],
) {
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
    ...build(
      'business',
      retentionInspector
        ? 'tests/web/fixtures/cloudflare-production-retention-worker.ts'
        : 'workers/web-cloudflare/business.ts',
    ),
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

test('production topology: private immutable setup, six fixed clips, separate budget/generation, three rounds and restart replay', async (t) => {
  const f = await fixture(t),
    api = '/api/web/provider';
  for (const action of ['business-http', 'budget-http', 'generation-http', 'operator-http'])
    await f.call({ action }, 404);
  await f.call({ action: 'edge', path: api + '/bootstrap' }, 503);
  assert.equal(await (await f.call({ action: 'object-id' })).json(), f.businessId);
  const init = (await (await f.call({ action: 'initialize', body: f.material })).json()) as { initializedAt: number };
  const duplicate = (await (await f.call({ action: 'initialize', body: f.material })).json()) as {
    duplicate: boolean;
    initializedAt: number;
  };
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.initializedAt, init.initializedAt);
  await f.call({ action: 'initialize', body: { ...f.material, selected: [] } }, 409);
  await f.call({ action: 'asset', body: { ...f.material.assets[0], bytes: [1, 2, 3] } }, 409);
  await f.install();
  const state = (await (await f.call({ action: 'status' })).json()) as any;
  assert.equal(state.setup.installed, 6);
  assert.ok(state.budget.every((r: any) => r.spentMicros === 0));
  const initial = await f.call({ action: 'edge', path: api + '/bootstrap' });
  const cookie = initial.headers.get('set-cookie')!.split(';')[0]!,
    boot = parseWebProviderBootstrap(await initial.json());
  const welcome = boot.characters[0]!.welcome.audio;
  assert.equal(welcome.state, 'available');
  if (welcome.state !== 'available') throw Error('missing welcome');
  const clip = await f.call({ action: 'edge', path: welcome.url });
  assert.equal(hash(new Uint8Array(await clip.arrayBuffer())), hash(f.wav));
  const headers = {
    cookie,
    origin: 'https://fixture.invalid',
    'x-csrf-token': boot.csrf,
    'content-type': 'application/json',
  };
  const requests: string[] = [],
    operations: string[] = [];
  for (let n = 0; n < 3; n++) {
    const requestId = randomUUID();
    requests.push(requestId);
    const response = await f.call(
      {
        action: 'edge',
        path: api + '/characters/wei-guagua/operations',
        method: 'POST',
        headers,
        body: { requestId, text: '完整隔离拓扑合成验收', delivery: 'voice' },
      },
      202,
    );
    const sent = (await response.json()) as any;
    operations.push(sent.operation.operationId);
    let last: any;
    for (const deadline = Date.now() + 25_000; Date.now() < deadline; ) {
      last = await (
        await f.call({ action: 'edge', path: api + '/operations/' + operations[n], headers: { cookie } })
      ).json();
      if (['published', 'failed', 'cancelled'].includes(last.status)) break;
      await sleep(150);
    }
    assert.equal(last.status, 'published', JSON.stringify(last));
    if (n === 2) assert.ok(last.publication.footerMessageId);
  }
  const before = (await (await f.call({ action: 'budget-summary' })).json()) as any[];
  assert.ok(before.every((row) => row.spentMicros > 0 && row.heldMicros === 0));
  const outsider = await f.call({ action: 'edge', path: api + '/bootstrap' });
  await f.call(
    {
      action: 'edge',
      path: api + '/operations/' + operations[0],
      headers: { cookie: outsider.headers.get('set-cookie')!.split(';')[0] },
    },
    404,
  );
  await f.restart();
  for (let n = 0; n < 3; n++) {
    const replay = (await (
      await f.call({
        action: 'edge',
        path: api + '/characters/wei-guagua/operations',
        method: 'POST',
        headers,
        body: { requestId: requests[n], text: '完整隔离拓扑合成验收', delivery: 'voice' },
      })
    ).json()) as any;
    assert.equal(replay.duplicate, true);
    assert.equal(replay.operation.operationId, operations[n]);
  }
  assert.deepEqual(await (await f.call({ action: 'budget-summary' })).json(), before);
  assert.deepEqual(await (await f.call({ action: 'generation-stats' })).json(), []);
});

test('private invite lookup returns only the selected grant ID after restart; revocation still needs admin authority', async (t) => {
  const f = await fixture(t),
    api = '/api/web/provider';
  await f.install();
  const grant = (await (await f.call({ action: 'grant' })).json()) as { token: string };
  const admin = await f.call({
    action: 'edge',
    path: api + '/admin/login',
    method: 'POST',
    headers: { origin: 'https://fixture.invalid', 'content-type': 'application/json' },
    body: { token: grant.token },
  });
  const headers = {
    cookie: admin.headers.get('set-cookie')!.split(';')[0]!,
    origin: 'https://fixture.invalid',
    'x-csrf-token': ((await admin.json()) as { csrf: string }).csrf,
    'content-type': 'application/json',
  };
  const issue = async () =>
    (await (
      await f.call(
        {
          action: 'edge',
          path: api + '/admin/invites/issue',
          method: 'POST',
          headers,
          body: {
            requestId: randomUUID(),
            redeemBy: Date.now() + 60_000,
            accessDurationMs: null,
            batch: 'offline',
            note: null,
          },
        },
        201,
      )
    ).json()) as { inviteId: string; code: string };
  const invite = await issue(),
    unused = await issue();
  assert.deepEqual(await (await f.call({ action: 'invite-grants', body: invite.inviteId })).json(), []);
  const response = await f.call({ action: 'edge', path: api + '/bootstrap' });
  const guestCookie = response.headers.get('set-cookie')!.split(';')[0]!,
    boot = parseWebProviderBootstrap(await response.json());
  const redeemed = await f.call(
    {
      action: 'edge',
      path: api + '/invites/redeem',
      method: 'POST',
      headers: { ...headers, cookie: guestCookie, 'x-csrf-token': boot.csrf },
      body: { requestId: randomUUID(), code: invite.code },
    },
    201,
  );
  const invitedCookie = redeemed.headers.get('set-cookie')!.split(';')[0]!,
    receipt = (await redeemed.json()) as { grantId: string };
  await f.restart();
  assert.deepEqual(await (await f.call({ action: 'invite-grants', body: invite.inviteId })).json(), [
    { grantId: receipt.grantId },
  ]);
  assert.deepEqual(await (await f.call({ action: 'invite-grants', body: unused.inviteId })).json(), []);
  for (const body of ['missing', 'bad/id', null]) await f.call({ action: 'invite-grants', body }, 409);
  await f.call({ action: 'operator-http', path: '/invite-grants' }, 404);
  await f.call(
    {
      action: 'edge',
      path: api + '/admin/invites/revoke-grant',
      method: 'POST',
      headers: { ...headers, cookie: invitedCookie },
      body: { id: receipt.grantId },
    },
    401,
  );
  await f.call({
    action: 'edge',
    path: api + '/admin/invites/revoke-grant',
    method: 'POST',
    headers,
    body: { id: receipt.grantId },
  });
  const after = parseWebProviderBootstrap(
    await (await f.call({ action: 'edge', path: api + '/bootstrap', headers: { cookie: invitedCookie } })).json(),
  );
  assert.equal(after.access.kind, 'invite');
  assert.equal(after.access.canSend, false);
  await f.call({ action: 'edge', path: api + '/admin/logout', method: 'POST', headers, body: {} });
  await f.call({ action: 'edge', path: api + '/admin/session', headers }, 401);
});

test('production gates default closed and deployment fingerprints prevent key/material/budget replacement', async (t) => {
  const f = await fixture(t),
    request = { action: 'edge', path: '/api/web/provider/bootstrap' };
  await f.install();
  for (const key of ['PUBLIC_ENABLED', 'EXTERNAL_CALLS'] as const) {
    f.business.bindings[key] = 'false';
    await f.restart();
    await f.call(request, 503);
    f.business.bindings[key] = 'true';
  }
  f.business.bindings.OPERATOR_ENABLED = 'false';
  f.budget.bindings.OPERATOR_ENABLED = 'false';
  await f.restart();
  for (const action of ['initialize', 'grant', 'invite-grants', 'object-id', 'status', 'asset'])
    await f.call({ action, body: f.material }, 409);
  await f.call({ action: 'budget-initialize', body: f.grants }, 409);
  await f.call(request);
  for (const key of ['REQUEST_KEY', 'MATERIAL_PACKAGE_SHA256', 'BUDGET_GRANT_HASHES'] as const) {
    const prior = f.business.bindings[key];
    f.business.bindings[key] =
      key === 'REQUEST_KEY'
        ? Buffer.alloc(32, 9).toString('base64url')
        : key === 'MATERIAL_PACKAGE_SHA256'
          ? 'f'.repeat(64)
          : JSON.stringify({ deepseek: 'f'.repeat(64), fish: 'e'.repeat(64) });
    await f.restart();
    await f.call(request, 503);
    f.business.bindings[key] = prior;
  }
  await f.restart();
  await f.call(request);
  assert.deepEqual(await (await f.call({ action: 'generation-stats' })).json(), []);
});

test('production Alarm persists idle guest expiry and clears SQL/R2 after restart with providers disabled', async (t) => {
  const f = await fixture(t, true),
    api = '/api/web/provider';
  await f.install();
  const initial = await f.call({ action: 'edge', path: api + '/bootstrap' });
  const cookie = initial.headers.get('set-cookie')!.split(';')[0]!,
    boot = parseWebProviderBootstrap(await initial.json());
  await f.call(
    {
      action: 'edge',
      path: api + '/characters/wei-guagua/operations',
      method: 'POST',
      headers: {
        cookie,
        origin: 'https://fixture.invalid',
        'x-csrf-token': boot.csrf,
        'content-type': 'application/json',
      },
      body: { requestId: randomUUID(), text: '真实生产Alarm离线清理验证', delivery: 'voice' },
    },
    202,
  );
  const inspect = async () => (await (await f.call({ action: 'business-http', path: '/__test/state' })).json()) as any;
  let state: any;
  for (const deadline = Date.now() + 25_000; Date.now() < deadline; ) {
    state = await inspect();
    if (state.operations[0]?.status === 'published' && state.alarm > Date.now() + 3_600_000) break;
    await sleep(100);
  }
  assert.equal(state.operations[0].status, 'published');
  assert.equal(state.alarm, state.retention[0].expires_at);
  assert.ok(state.outputs > 0);
  const budgets = await (await f.call({ action: 'budget-summary' })).json();
  f.business.bindings.EXTERNAL_CALLS = 'false';
  await f.restart();
  assert.equal((await inspect()).alarm, state.alarm);
  await f.call({ action: 'business-http', path: '/__test/expire' });
  await f.restart();
  for (const deadline = Date.now() + 10_000; Date.now() < deadline; ) {
    state = await inspect();
    if (state.retention[0].state === 'purged' && state.alarm === null) break;
    await sleep(100);
  }
  if (state.retention[0].state !== 'purged') {
    const diagnosis = await (await f.call({ action: 'business-http', path: '/__test/diagnose' })).json();
    assert.fail(JSON.stringify({ state, diagnosis }));
  }
  assert.ok(state.retention[0].db_cleared_at);
  assert.equal(state.alarm, null);
  assert.equal(state.outputs, 0);
  assert.equal(state.messages, 0);
  assert.equal(state.pendingObjects, 0);
  assert.deepEqual(await (await f.call({ action: 'budget-summary' })).json(), budgets);
  assert.deepEqual(await (await f.call({ action: 'generation-stats' })).json(), []);
});

test('uncapped production policy crosses the test ceiling in the real business SQL/runner and remains pinned after restart', async (t) => {
  const f = await fixture(t, true, true),
    api = '/api/web/provider';
  await f.install();
  const summary = (await (await f.call({ action: 'budget-summary' })).json()) as any[];
  assert.ok(
    summary.every(
      (r) => r.policy === 'production-unlimited' && r.allowanceMicros === null && r.remainingMicros === null,
    ),
  );
  const spending = (await (await f.call({ action: 'business-http', path: '/__test/spending' })).json()) as any[];
  assert.ok(spending.every((r) => r.limit_micros === null && r.spent_micros === 4_000_000));
  const initial = await f.call({ action: 'edge', path: api + '/bootstrap' });
  const cookie = initial.headers.get('set-cookie')!.split(';')[0]!,
    boot = parseWebProviderBootstrap(await initial.json());
  const headers = {
    cookie,
    origin: 'https://fixture.invalid',
    'x-csrf-token': boot.csrf,
    'content-type': 'application/json',
  };
  const body = { requestId: randomUUID(), text: '不设生产累计上限的离线测试', delivery: 'voice' };
  const sent = (await (
    await f.call(
      { action: 'edge', path: api + '/characters/wei-guagua/operations', method: 'POST', headers, body },
      202,
    )
  ).json()) as any;
  let operation: any;
  for (const deadline = Date.now() + 25_000; Date.now() < deadline; ) {
    operation = await (
      await f.call({ action: 'edge', path: api + '/operations/' + sent.operation.operationId, headers: { cookie } })
    ).json();
    if (['published', 'failed', 'cancelled'].includes(operation.status)) break;
    await sleep(100);
  }
  assert.equal(operation.status, 'published');
  const state = (await (await f.call({ action: 'business-http', path: '/__test/state' })).json()) as any;
  assert.ok(
    state.spending.every((r: any) => r.limit_micros === null && r.spent_micros > 4_000_000 && r.held_micros === 0),
  );
  await f.restart();
  assert.deepEqual(
    ((await (await f.call({ action: 'business-http', path: '/__test/state' })).json()) as any).spending,
    state.spending,
  );
  assert.deepEqual(await (await f.call({ action: 'generation-stats' })).json(), []);
  f.business.bindings.BUDGET_POLICY = 'test-cumulative';
  await f.restart();
  await f.call({ action: 'edge', path: api + '/bootstrap', headers: { cookie } }, 503);
  f.business.bindings.BUDGET_POLICY = 'production-unlimited';
  await f.restart();
  await f.call({ action: 'edge', path: api + '/bootstrap', headers: { cookie } });
});

test('operator inspect: read-only workerd snapshot, expected-vs-applied ledger, UNKNOWN ids only, no content, same gate as status', async (t) => {
  const f = await fixture(t, true),
    api = '/api/web/provider';
  const inspect = async () => (await (await f.call({ action: 'inspect' })).json()) as any;
  const snapshot = async () =>
    (await (await f.call({ action: 'business-http', path: '/__test/snapshot' })).json()) as any;
  // Before setup: works, reports an unavailable budget as a bounded code and no admin.
  const bare = await inspect();
  assert.equal(bare.schemaVersion, 116);
  assert.equal(bare.migrations.matches, true);
  assert.equal(bare.migrations.applied.length, 41);
  assert.deepEqual(bare.budget, { available: false, error: 'WEB_CLOUD_BUDGET_NOT_INITIALIZED' });
  assert.equal(bare.ownerAdminExists, false);
  await f.install();
  const initial = await f.call({ action: 'edge', path: api + '/bootstrap' });
  const cookie = initial.headers.get('set-cookie')!.split(';')[0]!,
    boot = parseWebProviderBootstrap(await initial.json());
  const text = '只读检查不得泄露的玩家消息';
  const sent = (await (
    await f.call(
      {
        action: 'edge',
        path: api + '/characters/wei-guagua/operations',
        method: 'POST',
        headers: {
          cookie,
          origin: 'https://fixture.invalid',
          'x-csrf-token': boot.csrf,
          'content-type': 'application/json',
        },
        body: { requestId: randomUUID(), text, delivery: 'voice' },
      },
      202,
    )
  ).json()) as any;
  let last: any;
  for (const deadline = Date.now() + 25_000; Date.now() < deadline; ) {
    last = await (
      await f.call({ action: 'edge', path: api + '/operations/' + sent.operation.operationId, headers: { cookie } })
    ).json();
    if (['published', 'failed', 'cancelled'].includes(last.status)) break;
    await sleep(100);
  }
  assert.equal(last.status, 'published');
  await f.call({ action: 'grant' });
  const seeded = (await (await f.call({ action: 'business-http', path: '/__test/seed-unknown' })).json()) as {
    provider: string[];
  };
  assert.equal(seeded.provider.length, 2);
  const budgets = await (await f.call({ action: 'budget-summary' })).json();
  const before = await snapshot();
  assert.ok(before.tables.length > 100 && before.totalChanges > 0);
  const report = await inspect();
  const again = await inspect();
  assert.deepEqual(await snapshot(), before, 'full table snapshot, schema and write counter are unchanged');
  assert.deepEqual(await (await f.call({ action: 'budget-summary' })).json(), budgets);
  assert.deepEqual(again, report);
  // Facts.
  assert.equal(report.schemaVersion, 116);
  assert.equal(report.migrations.matches, true);
  assert.equal(report.migrations.expected.active, 'r2');
  assert.deepEqual(report.migrations.applied, report.migrations.expected.r2);
  assert.equal(report.migrations.expected.inline.length, 41);
  assert.deepEqual(report.instance, {
    instanceId: f.business.bindings.INSTANCE_ID,
    recoveryEpoch: f.business.bindings.RECOVERY_EPOCH,
  });
  assert.deepEqual(
    report.budget.providers.map((row: any) => row.provider),
    ['deepseek', 'fish'],
  );
  for (const row of report.budget.providers) {
    assert.deepEqual(Object.keys(row).sort(), ['heldMicros', 'provider', 'spentMicros']);
    assert.ok(row.spentMicros > 0 && row.heldMicros >= 0);
  }
  assert.equal(report.unknownAttempts.webProvider.count, 2);
  assert.deepEqual(report.unknownAttempts.webProvider.ids, seeded.provider);
  assert.deepEqual(report.unknownAttempts.embed.ids, ['embed-unknown-1']);
  assert.equal(report.unknownAttempts.external.count, 0);
  assert.equal(report.ownerAdminExists, true);
  assert.deepEqual(report.flags, {
    PUBLIC_ENABLED: 'true',
    EXTERNAL_CALLS: 'true',
    OPERATOR_ENABLED: 'true',
    EMBEDDINGS_ENABLED: null,
  });
  // Nothing sensitive: not the message, not any key, hash or origin binding.
  const body = JSON.stringify(report);
  const secrets = [
    text,
    cookie,
    boot.csrf,
    f.business.bindings.IP_KEY,
    f.business.bindings.SEAL_KEY,
    f.business.bindings.REQUEST_KEY,
    f.business.bindings.CURSOR_KEY,
    f.business.bindings.MATERIAL_PACKAGE_SHA256,
    ...Object.values(JSON.parse(f.business.bindings.BUDGET_GRANT_HASHES) as Record<string, string>),
    f.business.bindings.ORIGIN,
    f.business.bindings.COOKIE_NAME,
    '@',
  ];
  for (const secret of secrets) assert.ok(!body.includes(secret), secret);
  // The same authentication as status: both refuse while the operator gate is closed, and both work again when open.
  f.business.bindings.OPERATOR_ENABLED = 'false';
  f.budget.bindings.OPERATOR_ENABLED = 'false';
  await f.restart();
  await f.call({ action: 'status' }, 409);
  await f.call({ action: 'inspect' }, 409);
  f.business.bindings.OPERATOR_ENABLED = 'true';
  f.business.bindings.PUBLIC_ENABLED = 'false';
  await f.restart();
  await f.call({ action: 'status' });
  assert.deepEqual((await inspect()).flags, {
    PUBLIC_ENABLED: 'false',
    EXTERNAL_CALLS: 'true',
    OPERATOR_ENABLED: 'true',
    EMBEDDINGS_ENABLED: null,
  });
});

test('offline expected-migrations output equals the steps the deployed business object computes', async (t) => {
  const f = await fixture(t, true);
  // No account, no Wrangler module, no proxy: the command is local and needs none of them.
  const run = spawnSync(process.execPath, ['scripts/web-cloudflare-operator.ts', 'expected-migrations'], {
    env: { PATH: process.env.PATH ?? '', HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9' },
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '');
  const offline = JSON.parse(run.stdout) as { inline: unknown[]; r2: unknown[] };
  assert.deepEqual(Object.keys(offline), ['inline', 'r2']);
  const live = (await (await f.call({ action: 'inspect' })).json()) as any;
  assert.deepEqual(offline.inline, live.migrations.expected.inline);
  assert.deepEqual(offline.r2, live.migrations.expected.r2);
  // And the deployed object's applied ledger is exactly the offline R2 list.
  assert.deepEqual(live.migrations.applied, offline.r2);
  assert.equal(live.migrations.matches, true);
  assert.equal(offline.r2.length, 41);
  const extra = spawnSync(process.execPath, ['scripts/web-cloudflare-operator.ts', 'expected-migrations', '--x=1'], {
    encoding: 'utf8',
  });
  assert.notEqual(extra.status, 0);
  assert.equal(extra.stdout, '');
});

test('startup failure is diagnosable from logs while the 503 response is unchanged', async (t) => {
  const logs: string[] = [];
  const f = await fixture(t, false, false, logs);
  await f.call({ action: 'initialize', body: f.material });
  for (const asset of f.material.assets) await f.call({ action: 'asset', body: { ...asset, bytes: [...f.wav] } });
  // The budget grants are deliberately not installed: start() fails in the budget RPC. The error crosses the
  // service binding as a plain Error (the DomainError class is lost), so its code is logged as the message.
  const response = await f.call(
    { action: 'edge', path: '/api/web/provider/bootstrap', headers: { cookie: 'secret-cookie' } },
    503,
  );
  assert.deepEqual(await response.json(), {
    error: { code: 'SERVICE_UNAVAILABLE', requestId: null, retryAfterMs: null },
  });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  await sleep(200);
  const text = logs.join('');
  const records = [...text.matchAll(/\{"event":"web_[a-z_]+"[^\n]*\}/g)].map(
    (m) => JSON.parse(m[0]) as Record<string, string>,
  );
  const started = records.find((r) => r.event === 'web_business_start_failed');
  const unavailable = records.find((r) => r.event === 'web_business_unavailable');
  assert.equal(started?.message, 'WEB_CLOUD_BUDGET_NOT_INITIALIZED', text);
  assert.equal(unavailable?.message, 'WEB_CLOUD_BUDGET_NOT_INITIALIZED');
  assert.equal(unavailable?.stage, 'start');
  assert.ok(!text.includes('secret-cookie'));
});

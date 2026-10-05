import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localRuntime } from '../../cloudflare/runtime.ts';
import { WebProviderBudget } from '../../../apps/server/web-provider-budget.ts';
import {
  budgetHash,
  type CloudBudgetTarget,
  type CloudProductionBudgetAuthorization,
} from '../../../apps/server/web-provider-budget-contract.ts';

test('local → workerd allowance is irrevocably held, target-bound, shared and restart-safe', async (t) => {
  const f = localRuntime(t, 'tests/web/fixtures/cloudflare-budget-worker.ts', {
    STATE: 'WebBudgetFixture',
    DISABLED: 'WebBudgetDisabledFixture',
  });
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'web-cloud-grant-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'local.sqlite'),
    clock = { now: () => 1234 };
  WebProviderBudget.initialize(
    path,
    (['deepseek', 'fish'] as const).map((provider) => ({
      source: 'offline-history',
      digest: 'a'.repeat(64),
      provider,
      spentMicros: 100,
      heldMicros: 50,
    })),
  );
  let local = new WebProviderBudget(path, clock);
  t.after(() => local.close());
  const target = await f.call<CloudBudgetTarget>('/target');
  for (const path of ['/public-worker', '/public-object'])
    assert.equal((await f.request('http://localhost' + path)).status, 404);
  assert.deepEqual(await f.call('/disabled', { grants: [] }, 409), { error: 'WEB_CLOUD_BUDGET_OPERATOR_DISABLED' });
  assert.deepEqual(await f.call('/summary', undefined, 409), { error: 'WEB_CLOUD_BUDGET_NOT_INITIALIZED' });
  const grants = (['deepseek', 'fish'] as const).map((provider) =>
    local.allocateCloud(`grant-${provider}`, target, provider, 2_999_850),
  );
  assert.ok(local.summary().every((row) => row.remainingMicros === 0 && row.heldMicros === 2_999_900));
  assert.throws(() => local.reserve('new-local-instance', 'deepseek', 'a'.repeat(64), 1), /BUDGET_EXHAUSTED/);
  // Crash after local commit but before cloud initialization: only a conservative hold exists.
  local.close();
  local = new WebProviderBudget(path, clock);
  assert.deepEqual(local.allocateCloud('grant-deepseek', target, 'deepseek', 2_999_850), grants[0]);
  assert.throws(
    () => local.allocateCloud('grant-deepseek', { ...target, objectId: 'f'.repeat(64) }, 'deepseek', 2_999_850),
    /GRANT_CONFLICT/,
  );
  assert.throws(() => local.settle('cloud-grant:grant-deepseek', budgetHash(grants[0]), 0, {}), /GRANT_IMMUTABLE/);
  await f.call('/initialize', { grants });
  assert.deepEqual(await f.call('/initialize?object=other-instance', { grants }, 409), {
    error: 'WEB_CLOUD_BUDGET_TARGET_MISMATCH',
  });
  const request = { provider: 'deepseek', fingerprint: 'c'.repeat(64), micros: 2_999_850 };
  const raced = await Promise.all(
    ['business-a', 'business-b'].map((id) =>
      f.request('http://localhost/reserve', {
        method: 'POST',
        body: JSON.stringify({ ...request, id }),
      }),
    ),
  );
  assert.deepEqual(raced.map((response) => response.status).sort(), [200, 409]);
  const winner = raced[0]!.status === 200 ? 'business-a' : 'business-b';
  await f.restart();
  await f.call('/initialize', { grants });
  assert.deepEqual(await f.call('/reserve', { ...request, id: winner }, 409), {
    error: 'WEB_SHARED_ATTEMPT_UNRESOLVED',
  });
  assert.deepEqual(await f.call('/reserve', { ...request, id: winner, fingerprint: 'd'.repeat(64) }, 409), {
    error: 'WEB_SHARED_REQUEST_CONFLICT',
  });
  assert.deepEqual(await f.call('/reserve', { ...request, id: 'business-c', micros: 1 }, 409), {
    error: 'WEB_SHARED_BUDGET_EXHAUSTED',
  });
  const receipt = { id: winner, fingerprint: request.fingerprint, micros: 2_999_850, receipt: { offline: true } };
  assert.deepEqual(await f.call('/settle', { ...receipt, micros: 2_999_851 }, 409), {
    error: 'WEB_SHARED_RECEIPT_INVALID',
  });
  await f.call('/settle', receipt);
  await f.restart();
  await f.call('/settle', receipt);
  assert.deepEqual(await f.call('/settle', { ...receipt, micros: 1 }, 409), { error: 'WEB_SHARED_RECEIPT_CONFLICT' });
  const summary = await f.call<{ remainingMicros: number; spentMicros: number; heldMicros: number }[]>('/summary');
  assert.equal(summary[0]!.remainingMicros, 0);
  assert.equal(summary[0]!.spentMicros, 2_999_850);
  assert.equal(summary[0]!.heldMicros, 0);
  assert.deepEqual(await f.call('/initialize', { grants: grants.map((g) => ({ ...g, id: 'reset' })) }, 409), {
    error: 'WEB_CLOUD_BUDGET_GRANT_CONFLICT',
  });
  assert.ok(local.summary().every((row) => row.remainingMicros === 0));
});

test('explicit uncapped production authority keeps shared holds, immutable receipts and restart history without test allocations', async (t) => {
  const f = localRuntime(t, 'tests/web/fixtures/cloudflare-budget-worker.ts', {
    STATE: 'WebBudgetFixture',
    DISABLED: 'WebBudgetDisabledFixture',
  });
  const target = await f.call<CloudBudgetTarget>('/target');
  const grants: CloudProductionBudgetAuthorization[] = (['deepseek', 'fish'] as const).map((provider) => ({
    ...target,
    version: 2,
    id: `production-${provider}`,
    provider,
    purpose: 'production',
    limit: 'unlimited',
    createdAt: 1,
  }));
  await f.call('/initialize', { grants: grants.map((g) => ({ ...g, purpose: 'test' })) }, 409);
  await f.call('/initialize', { grants: grants.map((g) => ({ ...g, micros: 3_000_000 })) }, 409);
  await f.call(
    '/initialize',
    {
      grants: [
        grants[0],
        {
          ...target,
          version: 1,
          id: 'test-fish',
          provider: 'fish',
          micros: 3_000_000,
          priorSpentMicros: 0,
          priorHeldMicros: 0,
          createdAt: 1,
        },
      ],
    },
    409,
  );
  await f.call('/initialize', { grants });
  const request = { provider: 'deepseek', fingerprint: 'c'.repeat(64), micros: 4_000_000 };
  await Promise.all(['business-a', 'business-b'].map((id) => f.call('/reserve', { ...request, id })));
  await f.restart();
  const summary = () =>
    f.call<{ policy: string; allowanceMicros: null; remainingMicros: null; heldMicros: number; spentMicros: number }[]>(
      '/summary',
    );
  let state = (await summary())[0]!;
  assert.equal(state.policy, 'production-unlimited');
  assert.equal(state.allowanceMicros, null);
  assert.equal(state.remainingMicros, null);
  assert.equal(state.heldMicros, 8_000_000);
  await f.call('/reserve', { ...request, id: 'business-a' }, 409);
  await f.call('/read', { id: 'business-a', fingerprint: 'd'.repeat(64) }, 409);
  await f.call('/reserve', { ...request, id: 'numeric-overflow', micros: Number.MAX_SAFE_INTEGER }, 409);
  const receipt = { id: 'business-a', fingerprint: request.fingerprint, micros: 3_500_000, receipt: { offline: true } };
  await f.call('/settle', receipt);
  await f.restart();
  await f.call('/settle', receipt);
  await f.call('/settle', { ...receipt, micros: 0 }, 409);
  await f.call('/initialize', { grants: grants.map((g) => ({ ...g, id: 'reset' })) }, 409);
  await f.call('/initialize', { grants });
  state = (await summary())[0]!;
  assert.equal(state.spentMicros, 3_500_000);
  assert.equal(state.heldMicros, 4_000_000);
  assert.equal(state.remainingMicros, null);
});

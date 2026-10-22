import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { localRuntime } from '../../cloudflare/runtime.ts';
import type {
  CloudBudgetTarget,
  CloudProductionBudgetAuthorization,
} from '../../../apps/server/budget/web-provider-budget-contract.ts';

type Row = {
  provider: string;
  allowanceMicros: number | null;
  spentMicros: number;
  heldMicros: number;
  remainingMicros: number | null;
  policy: string;
};
const runtime = (t: test.TestContext) =>
  localRuntime(t, 'tests/web/fixtures/cloudflare-budget-worker.ts', {
    STATE: 'WebBudgetFixture',
    DISABLED: 'WebBudgetDisabledFixture',
  });
const cappedGrants = (target: CloudBudgetTarget) =>
  (['deepseek', 'fish'] as const).map((provider) => ({
    ...target,
    version: 1,
    id: `grant-${provider}`,
    provider,
    micros: 3_000_000,
    priorSpentMicros: 0,
    priorHeldMicros: 0,
    createdAt: 1,
  }));
const id = (n: number) => `topup-request-${n}`;

test('22b 预算充值: a capped allowance grows by USD 1-50 per request, idempotently, with spend and holds untouched', async (t) => {
  const f = runtime(t);
  const target = await f.call<CloudBudgetTarget>('/target');
  const grants = cappedGrants(target);
  await f.call('/initialize', { grants });
  // Budget is reserved before the call: USD 2.9 held against the USD 3 allowance, then a second reservation is refused.
  const request = { provider: 'deepseek', fingerprint: 'c'.repeat(64), micros: 2_900_000 };
  await f.call('/reserve', { ...request, id: 'call-1' });
  assert.deepEqual(await f.call('/reserve', { ...request, id: 'call-2', fingerprint: 'd'.repeat(64) }, 409), {
    error: 'WEB_SHARED_BUDGET_EXHAUSTED',
  });
  const added = await f.call<Record<string, unknown>>('/topup', {
    requestId: id(1),
    provider: 'deepseek',
    micros: 5_000_000,
  });
  assert.deepEqual(added, {
    provider: 'deepseek',
    addedMicros: 5_000_000,
    allowanceMicros: 8_000_000,
    remainingMicros: 5_100_000,
    duplicate: false,
  });
  const summary = await f.call<Row[]>('/summary');
  assert.deepEqual(
    summary.map((r) => [r.provider, r.allowanceMicros, r.heldMicros, r.spentMicros, r.remainingMicros]),
    [
      ['deepseek', 8_000_000, 2_900_000, 0, 5_100_000],
      ['fish', 3_000_000, 0, 0, 3_000_000],
    ],
    'only the topped-up provider moved, and the hold is exactly as it was',
  );
  // The reservation that was refused now fits; the one that was held is still held (never released by a top-up).
  await f.call('/reserve', { ...request, id: 'call-2', fingerprint: 'd'.repeat(64), micros: 5_000_000 });
  assert.deepEqual(
    await f.call('/reserve', { ...request, id: 'call-3', fingerprint: 'e'.repeat(64), micros: 200_000 }, 409),
    {
      error: 'WEB_SHARED_BUDGET_EXHAUSTED',
    },
  );
  // Idempotent per request id; the same id with another amount or provider is a conflict; nothing is added twice.
  const replay = await f.call<Record<string, unknown>>('/topup', {
    requestId: id(1),
    provider: 'deepseek',
    micros: 5_000_000,
  });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.allowanceMicros, 8_000_000, 'the replay reports the allowance as it is');
  assert.deepEqual(await f.call('/topup', { requestId: id(1), provider: 'deepseek', micros: 6_000_000 }, 409), {
    error: 'WEB_BUDGET_TOPUP_CONFLICT',
  });
  assert.deepEqual(await f.call('/topup', { requestId: id(1), provider: 'fish', micros: 5_000_000 }, 409), {
    error: 'WEB_BUDGET_TOPUP_CONFLICT',
  });
  // Bounds: whole dollars from 1 to 50.
  for (const micros of [0, 999_999, 1_500_000, 51_000_000, -1_000_000, 1.5, '5000000'])
    assert.deepEqual(await f.call('/topup', { requestId: id(2), provider: 'fish', micros }, 409), {
      error: 'WEB_BUDGET_TOPUP_INVALID',
    });
  for (const requestId of ['', 'short', 'x'.repeat(129), 'bad id with spaces'])
    assert.deepEqual(await f.call('/topup', { requestId, provider: 'fish', micros: 1_000_000 }, 409), {
      error: 'WEB_BUDGET_TOPUP_INVALID',
    });
  assert.deepEqual(await f.call('/topup', { requestId: id(3), provider: 'gemini', micros: 1_000_000 }, 409), {
    error: 'WEB_BUDGET_TOPUP_INVALID',
  });
  // A second, different request adds again (USD 1 and USD 50 are the limits and both work).
  await f.call('/topup', { requestId: id(4), provider: 'fish', micros: 1_000_000 });
  const big = await f.call<Record<string, number>>('/topup', {
    requestId: id(5),
    provider: 'fish',
    micros: 50_000_000,
  });
  assert.equal(big.allowanceMicros, 54_000_000);
  // The allowance survives a restart, and the initialization ceremony still recognizes the deployed grants unchanged.
  await f.restart();
  await f.call('/initialize', { grants });
  const after = await f.call<Row[]>('/summary');
  assert.deepEqual(
    after.map((r) => [r.provider, r.allowanceMicros]),
    [
      ['deepseek', 8_000_000],
      ['fish', 54_000_000],
    ],
  );
  assert.equal(
    (await f.call<Record<string, unknown>>('/topup', { requestId: id(1), provider: 'deepseek', micros: 5_000_000 }))
      .duplicate,
    true,
  );
});

test('22b 预算充值: an unlimited (production) authority has no allowance and refuses', async (t) => {
  const f = runtime(t);
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
  await f.call('/initialize', { grants });
  assert.deepEqual(await f.call('/topup', { requestId: id(1), provider: 'deepseek', micros: 1_000_000 }, 409), {
    error: 'WEB_BUDGET_TOPUP_UNLIMITED',
  });
  const summary = await f.call<Row[]>('/summary');
  assert.ok(
    summary.every(
      (r) => r.policy === 'production-unlimited' && r.allowanceMicros === null && r.remainingMicros === null,
    ),
  );
});

test('22b 预算充值: only the business Worker binding can call it (the operator service and the edge have no such method)', () => {
  const source = readFileSync('workers/web-cloudflare/budget.ts', 'utf8');
  const classBody = (name: string) => {
    const start = source.indexOf(`export class ${name}`);
    assert.ok(start >= 0, name);
    const next = source.indexOf('\nexport ', start + 10);
    return source.slice(start, next < 0 ? undefined : next);
  };
  assert.match(classBody('WebBudgetService'), /async topUp\(/);
  assert.doesNotMatch(classBody('WebBudgetOperatorService'), /topUp/);
  // The business Worker is the only one that binds WebBudgetService (the generation Worker and the edge do not).
  for (const file of ['generation.json.example', 'edge.json.example', 'budget.json.example'])
    assert.doesNotMatch(readFileSync(`workers/web-cloudflare/deploy/${file}`, 'utf8'), /WebBudgetService/, file);
  assert.match(
    readFileSync('workers/web-cloudflare/deploy/business.json.example', 'utf8'),
    /"entrypoint": "WebBudgetService"/,
  );
  // The ledger's hashed schema (its identity) is unchanged: the top-ups live in their own additive table.
  assert.match(
    readFileSync('apps/server/cloudflare/web-budget.ts', 'utf8'),
    /CREATE TABLE IF NOT EXISTS cf_web_budget_topups/,
  );
});

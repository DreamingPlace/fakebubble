import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { localRuntime, initProviderInstance } from '../../../apps/server/platform/web-local-config.ts';
import { migrateProvider, openProviderStore } from '../../../scripts/web-provider.ts';
import { renderProviderAssets } from '../../../apps/server/generation/web-provider-assets.ts';
import { WebProviderBudget } from '../../../apps/server/budget/web-provider-budget.ts';
import { syntheticTone } from '../../../apps/server/platform/web-local-fake.ts';
import { FishAudio } from '../../../workers/audio/fish.ts';
import { syntheticSelection } from '../fixtures/provider-selection.ts';

function fixture(t: test.TestContext, spent = 0) {
  const { parent } = localRuntime();
  mkdirSync(parent, { recursive: true });
  const root = join(parent, `provider-asset-${randomUUID().slice(0, 8)}`);
  initProviderInstance(root);
  migrateProvider(root, syntheticSelection());
  const { store } = openProviderStore(root);
  t.after(() => store.close());
  const budgetPath = join(root, 'test-budget.sqlite');
  WebProviderBudget.initialize(
    budgetPath,
    ['deepseek', 'fish'].map((provider) => ({
      source: 'synthetic',
      provider: provider as 'deepseek' | 'fish',
      digest: 'a'.repeat(64),
      spentMicros: spent,
      heldMicros: 0,
    })),
  );
  const clock = { now: () => Date.now() };
  const budget = new WebProviderBudget(budgetPath, clock);
  t.after(() => budget.close());
  return { store, budget, clock };
}

test('material renders reserve globally before every call and skip all six persisted clips on restart', async (t) => {
  const f = fixture(t);
  let calls = 0;
  const audio = new FishAudio({
    apiKey: 'offline-only',
    fetch: async () => {
      assert.ok(f.budget.summary()[1]!.heldMicros > 0);
      calls++;
      return new Response(Uint8Array.from(syntheticTone()).buffer, {
        headers: { 'content-type': 'audio/wav', 'x-request-id': `fake-${calls}` },
      });
    },
  });
  assert.equal((await renderProviderAssets(f.store, f.clock, f.budget, audio.generate.bind(audio))).length, 6);
  assert.equal(calls, 6);
  assert.equal(f.budget.summary()[1]!.heldMicros, 0);
  assert.ok(f.budget.summary()[1]!.spentMicros > 0);
  assert.equal(
    (
      await renderProviderAssets(f.store, f.clock, f.budget, async () => {
        throw Error('must not resend');
      })
    ).length,
    0,
  );
});

test('materials: exhausted global allowance and unknown transport result never dispatch/retry', async (t) => {
  const full = fixture(t, 3_000_000);
  let calls = 0;
  const send = async (): Promise<never> => {
    calls++;
    throw Error('lost receipt');
  };
  await assert.rejects(renderProviderAssets(full.store, full.clock, full.budget, send), /BUDGET_EXHAUSTED/);
  assert.equal(calls, 0);
  const f = fixture(t);
  await assert.rejects(renderProviderAssets(f.store, f.clock, f.budget, send), /lost receipt/);
  const held = f.budget.summary()[1]!.heldMicros;
  assert.ok(held > 0);
  await assert.rejects(renderProviderAssets(f.store, f.clock, f.budget, send), /ATTEMPT_UNRESOLVED/);
  assert.equal(calls, 1);
  assert.equal(f.budget.summary()[1]!.heldMicros, held);
});

test('materials: crash gap after bill/output persistence reuses identical bytes without another call', async (t) => {
  const f = fixture(t);
  let calls = 0;
  const audio = new FishAudio({
    apiKey: 'offline-only',
    fetch: async () => {
      calls++;
      return new Response(Uint8Array.from(syntheticTone()).buffer, { headers: { 'content-type': 'audio/wav' } });
    },
  });
  f.store.db.exec(`CREATE TRIGGER test_material_crash BEFORE INSERT ON web_provider_welcome_assets
    BEGIN SELECT RAISE(ABORT,'TEST_CRASH_BEFORE_ASSET'); END`);
  await assert.rejects(
    renderProviderAssets(f.store, f.clock, f.budget, audio.generate.bind(audio)),
    /TEST_CRASH_BEFORE_ASSET/,
  );
  assert.equal(calls, 1);
  assert.equal(f.budget.summary()[1]!.heldMicros, 0);
  f.store.db.exec('DROP TRIGGER test_material_crash');
  const results = await renderProviderAssets(f.store, f.clock, f.budget, audio.generate.bind(audio));
  assert.equal(results[0]!.recovered, true);
  assert.equal(calls, 6);
});

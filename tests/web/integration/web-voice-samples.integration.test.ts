import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { EXPRESSIONS } from '../../../packages/contracts/index.ts';
import type { FishModel } from '../../../packages/contracts/audio.ts';
import { localRuntime, initProviderInstance } from '../../../apps/server/platform/web-local-config.ts';
import { migrateProvider, openProviderStore } from '../../../scripts/web-provider.ts';
import { writeVoiceSamples } from '../../../scripts/voice-samples.ts';
import {
  renderVoiceSamples,
  VOICE_SAMPLE_TEXT,
  type VoiceSampleClip,
} from '../../../apps/server/generation/web-voice-samples.ts';
import { WebProviderBudget } from '../../../apps/server/budget/web-provider-budget.ts';
import { syntheticTone } from '../../../apps/server/platform/web-local-fake.ts';
import { FishAudio } from '../../../workers/audio/fish.ts';
import { syntheticSelection } from '../fixtures/provider-selection.ts';

function fixture(t: test.TestContext, spent = 0) {
  const { parent } = localRuntime();
  mkdirSync(parent, { recursive: true });
  const root = join(parent, `provider-samples-${randomUUID().slice(0, 8)}`);
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
  return { store, budget, clock, root };
}
const characters = (f: ReturnType<typeof fixture>) =>
  f.store.all<{ character_id: string }>(
    "SELECT character_id FROM web_provider_voice_bindings WHERE source='user_selected' AND approved=1",
  ).length;

function fish(f: ReturnType<typeof fixture>, model: FishModel, seen: { header: string; text: string }[]) {
  return new FishAudio({
    apiKey: 'offline-only',
    model,
    fetch: async (_url, init) => {
      assert.ok(f.budget.summary()[1]!.heldMicros > 0, 'the budget hold exists before the provider call');
      seen.push({
        header: (init?.headers as Record<string, string>).model!,
        text: JSON.parse(String(init?.body)).text,
      });
      return new Response(Uint8Array.from(syntheticTone()).buffer, {
        headers: { 'content-type': 'audio/wav', 'x-request-id': `fake-${seen.length}` },
      });
    },
  });
}

for (const model of ['s2.1-pro', 'drama-3'] as const)
  test(`voice samples (${model}): one clip per character per expression, reserved first, reused on a second run`, async (t) => {
    const f = fixture(t);
    const seen: { header: string; text: string }[] = [];
    const audio = fish(f, model, seen);
    const sunk: VoiceSampleClip[] = [];
    const run = () =>
      renderVoiceSamples(f.store, f.clock, f.budget, audio.generate.bind(audio), {
        model,
        sink: (clip) => sunk.push(clip),
      });
    const clips = await run();
    assert.equal(characters(f) > 0, true);
    assert.equal(clips.length, characters(f) * EXPRESSIONS.length);
    assert.equal(seen.length, clips.length);
    assert.ok(seen.every((call) => call.header === model));
    assert.ok(seen.every((call) => call.text.endsWith(VOICE_SAMPLE_TEXT)));
    assert.equal(f.budget.summary()[1]!.heldMicros, 0);
    assert.ok(f.budget.summary()[1]!.spentMicros > 0);
    for (const character of new Set(clips.map((clip) => clip.characterId)))
      assert.deepEqual(
        clips.filter((clip) => clip.characterId === character).map((clip) => clip.expression),
        [...EXPRESSIONS],
      );
    const again = await run();
    assert.equal(seen.length, clips.length, 'a second run sends nothing');
    assert.ok(again.every((clip) => clip.recovered));
  });

test('voice samples: only voice bindings, prices and the instance id are read (no player data)', async (t) => {
  const f = fixture(t);
  const sql: string[] = [];
  const spy = new Proxy(f.store, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (key === 'get' || key === 'all' || key === 'run')
        return (query: string, ...rest: unknown[]) => {
          sql.push(query);
          return (value as (...args: unknown[]) => unknown).call(target, query, ...rest);
        };
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const audio = fish(f, 'drama-3', []);
  await renderVoiceSamples(spy as typeof f.store, f.clock, f.budget, audio.generate.bind(audio), {
    model: 'drama-3',
    sink: () => {},
  });
  assert.ok(sql.length >= 3);
  for (const query of sql) assert.match(query, /web_instance|web_provider_prices|web_provider_voice_bindings/, query);
  assert.equal(
    sql.some((query) => /messages|memor|player|conversation|principal/i.test(query)),
    false,
  );
});

test('voice samples: an exhausted budget never dispatches; an unknown result is never resent and keeps its hold', async (t) => {
  const full = fixture(t, 3_000_000);
  let calls = 0;
  const send = async (): Promise<never> => {
    calls++;
    throw Error('lost receipt');
  };
  const run = (f: ReturnType<typeof fixture>) =>
    renderVoiceSamples(f.store, f.clock, f.budget, send, { model: 'drama-3', sink: () => {} });
  await assert.rejects(run(full), /BUDGET_EXHAUSTED/);
  assert.equal(calls, 0);
  const f = fixture(t);
  await assert.rejects(run(f), /lost receipt/);
  const held = f.budget.summary()[1]!.heldMicros;
  assert.ok(held > 0);
  await assert.rejects(run(f), /ATTEMPT_UNRESOLVED/);
  assert.equal(calls, 1);
  assert.equal(f.budget.summary()[1]!.heldMicros, held, 'the hold is never released');
});

test('voice samples: a model without a price row is refused before any hold or call', async (t) => {
  const f = fixture(t);
  let calls = 0;
  await assert.rejects(
    renderVoiceSamples(
      f.store,
      f.clock,
      f.budget,
      async () => {
        calls++;
        throw Error('unreachable');
      },
      { model: 's2-pro', sink: () => {} },
    ),
    /WEB_PROVIDER_PRICE_REQUIRED/,
  );
  assert.equal(calls, 0);
  assert.equal(f.budget.summary()[1]!.heldMicros, 0);
});

test('voice samples CLI entry refuses a misspelled model and a non-empty output folder before any call', async () => {
  const env = mkdtempSync(join(tmpdir(), 'voice-env-'));
  writeFileSync(join(env, '.env.voice'), 'FISH_API_KEY=offline-only\n', { mode: 0o600 });
  await assert.rejects(
    writeVoiceSamples('unused-root', env, join(env, 'out-a'), 'drama-3-preview'),
    /INVALID_FISH_VOICE_MODEL/,
  );
  mkdirSync(join(env, 'out-b'));
  writeFileSync(join(env, 'out-b', 'keep.txt'), 'x');
  await assert.rejects(
    writeVoiceSamples('unused-root', env, join(env, 'out-b'), 'drama-3'),
    /VOICE_SAMPLES_OUTPUT_NOT_EMPTY/,
  );
  assert.deepEqual(readdirSync(join(env, 'out-b')), ['keep.txt']);
  assert.equal(readFileSync(join(env, 'out-b', 'keep.txt'), 'utf8'), 'x');
});

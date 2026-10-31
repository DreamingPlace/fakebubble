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
import { FishAudio, speechPayload } from '../../../workers/audio/fish.ts';
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

// Part 23b: the staging listening aid speaks each character's own direction on Drama 3, and only there.
const DIRECTION = '语速舒缓，句尾常拖长。';
const withDirection = (f: ReturnType<typeof fixture>) => {
  const [first] = f.store.all<{ character_id: string }>(
    "SELECT character_id FROM web_provider_voice_bindings WHERE source='user_selected' AND approved=1 ORDER BY character_id",
  );
  f.store.run(
    "UPDATE character_templates SET config_json=json_set(config_json,'$.voice',json(?)) WHERE id=?",
    JSON.stringify({ profileId: 'p', version: 1, speed: 1, direction: DIRECTION }),
    first!.character_id,
  );
  return first!.character_id;
};

test('voice samples: a character with a direction is heard with it on drama-3; s2.1-pro and the others are unchanged', async (t) => {
  const f = fixture(t);
  const directed = withDirection(f);
  const heard: Record<string, { text: string }[]> = {};
  for (const model of ['drama-3', 's2.1-pro'] as const) {
    const seen: { header: string; text: string }[] = [];
    const audio = fish(f, model, seen);
    const clips = await renderVoiceSamples(f.store, f.clock, f.budget, audio.generate.bind(audio), {
      model,
      sink: () => {},
    });
    heard[model] = clips.map((clip, i) => ({ text: seen[i]!.text, ...clip }));
    const mine = heard[model]!.filter((c) => (c as unknown as { characterId: string }).characterId === directed);
    assert.equal(mine.length, EXPRESSIONS.length);
    if (model === 'drama-3') {
      assert.ok(mine.every((c) => c.text.startsWith(`[${DIRECTION}] `) && c.text.endsWith(VOICE_SAMPLE_TEXT)));
      const others = heard[model]!.filter((c) => (c as unknown as { characterId: string }).characterId !== directed);
      assert.ok(others.length > 0 && others.every((c) => !c.text.includes('语速舒缓')));
    } else assert.ok(heard[model]!.every((c) => !c.text.includes(DIRECTION)));
  }
});

test('voice samples: the same run without any direction sends exactly what it always did', async (t) => {
  const f = fixture(t);
  const seen: { header: string; text: string }[] = [];
  const audio = fish(f, 'drama-3', seen);
  const clips = await renderVoiceSamples(f.store, f.clock, f.budget, audio.generate.bind(audio), {
    model: 'drama-3',
    sink: () => {},
  });
  assert.equal(seen.length, clips.length);
  clips.forEach((clip, i) => {
    const expected = speechPayload(
      {
        jobId: 'x',
        text: VOICE_SAMPLE_TEXT,
        expression: clip.expression,
        speed: 1,
        deliveryStyle: 'conversational',
        voice: { profileId: 'p', referenceId: 'r', version: 1 },
        model: 'drama-3',
      },
      'drama-3',
    ).text;
    assert.equal(seen[i]!.text, expected);
  });
});

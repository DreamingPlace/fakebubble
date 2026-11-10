import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WELCOME_LIMITS,
  evenWeights,
  legacyWelcomeId,
  pickWelcome,
  upgradeProfile,
  upgradeWelcomes,
  welcomeProblems,
  type WelcomeLine,
} from '../../../packages/contracts/web-welcomes.ts';
import { describeChange } from '../../../packages/contracts/web-character-history.ts';
import { prng } from '../../../apps/player-web/src/features/brand/palette-skin.ts';

const line = (id: string, text: string, weight: number): WelcomeLine => ({ id, text, weight });

test('Part 24k-2: the weights must sum to exactly 100 and every problem is located', () => {
  assert.deepEqual(welcomeProblems([line('a', '嗨', 100)]), []);
  assert.deepEqual(welcomeProblems([line('a', '嗨', 60), line('b', '哟', 40)]), []);
  const off = welcomeProblems([line('a', '嗨', 60), line('b', '哟', 30)]);
  assert.deepEqual(
    off.map((p) => [p.line, p.field]),
    [[0, 'total']],
  );
  assert.match(off[0]!.message, /90%/);
  // a bad line is named by its number; the sum is not judged while a weight is unusable
  const bad = welcomeProblems([line('a', '嗨', 50), line('b', '', 50), line('c', '哟', 0)]);
  assert.deepEqual(
    bad.map((p) => [p.line, p.field]),
    [
      [2, 'text'],
      [3, 'weight'],
    ],
  );
  assert.equal(welcomeProblems([line('a', '嗨', 100.5)])[0]!.field, 'weight');
  assert.equal(welcomeProblems([line('a', '嗨', 101)])[0]!.field, 'weight');
  assert.ok(welcomeProblems([line('a', '嗨', 50), line('a', '哟', 50)]).some((p) => p.line === 2 && p.field === 'id'));
  assert.ok(welcomeProblems([line('a', `${'字'.repeat(200)}`, 100)]).length === 0, '200 characters are allowed');
  assert.equal(welcomeProblems([line('a', '字'.repeat(201), 100)])[0]!.field, 'text');
  assert.equal(welcomeProblems([line('a', '带\u0000控制符', 100)])[0]!.field, 'text');
});

test('Part 24k-2: 1 and 8 lines are the bounds', () => {
  assert.equal(welcomeProblems([]).length, 1);
  const eight = evenWeights(8).map((w, i) => line(`l${i}`, `第${i}条`, w));
  assert.deepEqual(welcomeProblems(eight), []);
  const nine = evenWeights(9).map((w, i) => line(`l${i}`, `第${i}条`, w));
  assert.equal(welcomeProblems(nine)[0]!.line, 0);
  assert.equal(WELCOME_LIMITS.maxLines, 8);
  assert.equal(welcomeProblems('x')[0]!.field, 'lines');
});

test('Part 24k-2: adding lines splits evenly: three lines are 34 / 33 / 33, always summing to 100', () => {
  assert.deepEqual(evenWeights(1), [100]);
  assert.deepEqual(evenWeights(2), [50, 50]);
  assert.deepEqual(evenWeights(3), [34, 33, 33]);
  for (let n = 1; n <= 8; n += 1)
    assert.equal(
      evenWeights(n).reduce((a, b) => a + b, 0),
      100,
    );
});

test('Part 24k-2: an old single welcome upgrades in memory, losslessly, with a stable id, and nothing is written back', () => {
  const stored = {
    presentation: { displayName: 'x', publicDescription: '', welcome: { text: '你好，我来了', version: 'welcome-v1' } },
    template: { id: 't' },
  };
  const before = JSON.stringify(stored);
  const up = upgradeProfile(stored);
  assert.deepEqual(up.presentation.welcomes, [
    { id: legacyWelcomeId('你好，我来了'), text: '你好，我来了', weight: 100 },
  ]);
  assert.equal('welcome' in up.presentation, false);
  assert.equal(JSON.stringify(stored), before, 'the stored object is untouched');
  assert.equal(legacyWelcomeId('你好，我来了'), legacyWelcomeId('你好，我来了'), 'stable');
  assert.notEqual(legacyWelcomeId('甲'), legacyWelcomeId('乙'));
  // a profile that already has the list is returned as it is (copied)
  const listed = { presentation: { welcomes: [line('a', '嗨', 100)] } };
  assert.deepEqual(upgradeWelcomes(listed.presentation), listed.presentation.welcomes);
  assert.deepEqual(upgradeProfile(listed).presentation.welcomes, listed.presentation.welcomes);
});

test('Part 24k-2: the readable diff treats an old welcome and its upgraded one-line list as the same, and lines as different', () => {
  const base = {
    template: { id: 't', name: 'n', persona: 'p' },
    presentation: { displayName: 'd', publicDescription: '' },
  };
  const old = { ...base, presentation: { ...base.presentation, welcome: { text: '嗨', version: 'v1' } } };
  const listed = {
    ...base,
    presentation: { ...base.presentation, welcomes: upgradeWelcomes({ welcome: { text: '嗨' } }) },
  };
  assert.equal(describeChange(old, listed), '内容与上一版相同');
  const more = {
    ...base,
    presentation: { ...base.presentation, welcomes: [line('a', '嗨', 50), line('b', '哟', 50)] },
  };
  assert.equal(describeChange(listed, more), '改动：欢迎词');
});

test('Part 24k-2: a large synthetic sample follows the weights', () => {
  const lines = [line('a', '甲', 50), line('b', '乙', 30), line('c', '丙', 20)];
  const rand = prng(20241102);
  const counts: Record<string, number> = { a: 0, b: 0, c: 0 };
  const N = 60_000;
  for (let i = 0; i < N; i += 1) counts[pickWelcome(lines, rand()).id]! += 1;
  for (const l of lines) {
    const share = (counts[l.id]! / N) * 100;
    assert.ok(Math.abs(share - l.weight) < 1.2, `${l.id} ${share.toFixed(2)} vs ${l.weight}`);
  }
  // the edges of the unit interval fall on the first and last line, never off the end
  assert.equal(pickWelcome(lines, 0).id, 'a');
  assert.equal(pickWelcome(lines, 0.9999999).id, 'c');
  assert.equal(pickWelcome(lines, 1.5).id, 'c');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { landingIndex } from '../../src/features/prototype/landing.ts';

// Part 31b (owner decision 2026-11-14): a first visit lands on a random character; the old "position 1" tests were replaced by these.
const ring = [undefined, undefined, 'a', 'b', 'c', undefined, 'd'].map((characterId) =>
  characterId ? { characterId } : {},
);

test('a first visit picks any real character, never a placeholder', () => {
  const seen = new Set<number>();
  for (const r of [0, 0.24, 0.26, 0.5, 0.74, 0.99, 1]) {
    const { index, resumed } = landingIndex(ring, undefined, 7, () => r);
    assert.equal(resumed, false);
    assert.ok(ring[index]!.characterId, `index ${index} is a character`);
    seen.add(index);
  }
  assert.deepEqual([...seen].sort(), [2, 3, 4, 6]);
});

test('a returning visitor lands on the last-viewed card; an unknown id counts as no memory', () => {
  assert.deepEqual(
    landingIndex(ring, 'c', 7, () => 0),
    { index: 4, resumed: true },
  );
  assert.deepEqual(
    landingIndex(ring, 'gone', 7, () => 0),
    { index: 2, resumed: false },
  );
  assert.deepEqual(
    landingIndex(ring, 'gone', 7, () => 0.99),
    { index: 6, resumed: false },
  );
});

test('a page with no character at all keeps the fallback slot', () => {
  assert.deepEqual(
    landingIndex([{}, {}], undefined, 7, () => 0.5),
    { index: 7, resumed: false },
  );
});

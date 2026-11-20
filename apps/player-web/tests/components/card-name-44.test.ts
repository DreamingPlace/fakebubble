import test from 'node:test';
import assert from 'node:assert/strict';
import { NAME_SIZE_MAX, NAME_SIZE_MIN, fitNameSize } from '../../src/features/prototype/card-name.ts';

// Part 44: one size rule for every nickname: a fixed maximum, shrunk only to fit the card's width, never below the minimum.
test('a name that fits keeps the one fixed size, whatever its length', () => {
  assert.equal(fitNameSize(100, 252), NAME_SIZE_MAX);
  assert.equal(fitNameSize(0, 252), NAME_SIZE_MAX, 'nothing measured yet: the fixed size');
});
test('a name wider than the card shrinks in proportion, so its width is the card’s width (within a hair)', () => {
  const size = fitNameSize(400, 252);
  assert.ok(size < NAME_SIZE_MAX && size > NAME_SIZE_MIN);
  assert.ok(Math.abs((400 * size) / NAME_SIZE_MAX - 252) < 252 * 0.03, 'the fitted width is about the room');
  assert.ok((400 * size) / NAME_SIZE_MAX <= 252, 'never wider than the room');
});
test('the size never leaves [min, max]', () => {
  for (const natural of [1, 50, 252, 253, 400, 1000, 100000]) {
    const size = fitNameSize(natural, 252);
    assert.ok(size >= NAME_SIZE_MIN && size <= NAME_SIZE_MAX, `${natural}: ${size}`);
  }
  assert.equal(fitNameSize(100000, 252), NAME_SIZE_MIN);
});

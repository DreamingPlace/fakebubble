import assert from 'node:assert/strict';
import test from 'node:test';
import { orbitStyle, ringOffset } from '../../src/features/prototype/orbit.ts';

test('fifteen positions wrap in both directions', () => {
  assert.equal(ringOffset(0, 14, 15), 1);
  assert.equal(ringOffset(14, 0, 15), -1);
  assert.deepEqual(Array.from({ length: 15 }, (_, i) => ringOffset(i, 7, 15)).sort((a, b) => a - b),
    [-7, -6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7]);
});

test('front five are layered at 0.382-card-width steps', () => {
  assert.equal(orbitStyle(0, 15).x, 0);
  assert.equal(orbitStyle(1, 15).x, .382);
  assert.equal(orbitStyle(-1, 15).x, -.382);
  assert.equal(orbitStyle(2, 15).x, .764);
  assert.equal(orbitStyle(-2, 15).x, -.764);
  assert.ok(orbitStyle(0, 15).z > orbitStyle(1, 15).z);
  assert.ok(orbitStyle(1, 15).z > orbitStyle(2, 15).z);
});

test('back half fades and avatar front is larger', () => {
  assert.ok(orbitStyle(3, 15).opacity < orbitStyle(2, 15).opacity);
  assert.ok(orbitStyle(7, 15).opacity < orbitStyle(3, 15).opacity);
  assert.ok(orbitStyle(0, 15).avatarScale > orbitStyle(1, 15).avatarScale);
  assert.equal(orbitStyle(-1, 15).avatarY, orbitStyle(1, 15).avatarY);
  assert.ok(orbitStyle(7, 15).avatarY < 104);
  assert.equal(orbitStyle(7, 15).avatarOpacity, 0);
});

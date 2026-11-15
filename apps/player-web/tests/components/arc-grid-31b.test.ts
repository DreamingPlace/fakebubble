import assert from 'node:assert/strict';
import test from 'node:test';
import { gridStep, moved, slotAtGrid } from '../../src/features/admin/ui/drag-order.ts';

// Part 31b: the 首页顺序 editor is one sequence shown in rows of three.
test('←/→ move one place, ↑/↓ one row, and nothing moves out of the list', () => {
  assert.equal(gridStep('ArrowRight', 4, 15, 3), 5);
  assert.equal(gridStep('ArrowLeft', 4, 15, 3), 3);
  assert.equal(gridStep('ArrowDown', 4, 15, 3), 7);
  assert.equal(gridStep('ArrowUp', 4, 15, 3), 1);
  assert.equal(gridStep('ArrowLeft', 0, 15, 3), null);
  assert.equal(gridStep('ArrowRight', 14, 15, 3), null);
  assert.equal(gridStep('ArrowUp', 2, 15, 3), null);
  assert.equal(gridStep('ArrowDown', 13, 15, 3), null);
  assert.equal(gridStep('a', 4, 15, 3), null);
  // a single column behaves like the old list
  assert.equal(gridStep('ArrowDown', 0, 5, 1), 1);
});

test('the sequence after a keyboard move is the reading order with that tile shifted', () => {
  const ids = Array.from({ length: 15 }, (_, i) => `c${i + 1}`);
  assert.deepEqual(moved(ids, 4, gridStep('ArrowRight', 4, 15, 3)!).slice(3, 7), ['c4', 'c6', 'c5', 'c7']);
  assert.deepEqual(moved(ids, 4, gridStep('ArrowDown', 4, 15, 3)!).slice(3, 9), ['c4', 'c6', 'c7', 'c8', 'c5', 'c9']);
});

test('a tile dragged across rows lands on the slot nearest to where it is dropped', () => {
  const centres = Array.from({ length: 15 }, (_, i) => ({ x: 100 + (i % 3) * 200, y: 40 + Math.floor(i / 3) * 60 }));
  assert.equal(slotAtGrid(centres, 0, { x: 110, y: 50 }), 0);
  assert.equal(slotAtGrid(centres, 0, { x: 310, y: 45 }), 1, 'right, same row');
  assert.equal(slotAtGrid(centres, 0, { x: 120, y: 160 }), 6, 'down two rows, same column');
  assert.equal(slotAtGrid(centres, 0, { x: 480, y: 330 }), 14, 'the far corner');
  assert.equal(slotAtGrid(centres, 14, { x: 95, y: 35 }), 0, 'and back to the first place');
  assert.equal(slotAtGrid(centres, 7, { x: 300, y: 165 }), 7, 'a tile left where it is stays');
});

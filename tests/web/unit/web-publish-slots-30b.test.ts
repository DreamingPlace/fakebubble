import assert from 'node:assert/strict';
import test from 'node:test';
import { publishBlocker, slotLabel, slotState } from '../../../apps/player-web/src/features/admin/publish-slots.ts';
import type { ClipTakes, Slot, Take } from '../../../apps/player-web/src/services/clip-takes-api.ts';

/** Part 30b: the owner's shape (four welcome lines, no footer slot); the client refuses before any request and names the slot. */
const take = (over: Partial<Take> = {}): Take => ({
  takeId: 't',
  name: '第 1 条',
  note: '',
  origin: 'generated',
  status: 'ready',
  durationMs: 1000,
  sha256: 'x',
  createdAt: 1,
  selected: true,
  usable: true,
  ...over,
});
const slot = (n: number, over: Partial<Slot> = {}): Slot => ({
  slotKey: `line:${n}`,
  kind: 'welcome',
  lineId: String(n),
  text: '嗯',
  takes: [take({ takeId: `t${n}` })],
  selectedTakeId: `t${n}`,
  approved: true,
  issue: null,
  ...over,
});
const clips = (slots: Slot[]): ClipTakes => ({
  voice: null,
  footerRequired: false,
  speechAvailable: true,
  directionAvailable: true,
  slots,
  ready: slots.every((s) => s.approved),
});

test('every slot approved: nothing blocks', () => {
  assert.equal(publishBlocker(clips([1, 2, 3, 4].map((n) => slot(n)))), null);
});
test('a slot that is not approved is named 欢迎 N, in the standing sentence', () => {
  const view = clips([slot(1), slot(2), slot(3, { approved: false }), slot(4)]);
  assert.equal(publishBlocker(view), '欢迎 3 还没批准');
  assert.equal(slotState(view.slots[2]!), 'unapproved');
});
test('a 选用 take that is no longer usable, or a changed line with no usable take, is 已失效', () => {
  const gone = clips([slot(1), slot(2, { takes: [take({ takeId: 't2', usable: false })], approved: true })]);
  assert.equal(publishBlocker(gone), '欢迎 2 的选用版本已失效，请重录或另选');
  const changed = clips([
    slot(1, { takes: [take({ usable: false, selected: false })], selectedTakeId: null, approved: false }),
  ]);
  assert.equal(publishBlocker(changed), '欢迎 1 的选用版本已失效，请重录或另选');
});
test('the footer is 结束 and the labels count welcome lines only', () => {
  const view = clips([
    slot(1),
    slot(2),
    { ...slot(3, { approved: false }), kind: 'footer', lineId: null, slotKey: 'footer' },
  ]);
  assert.equal(slotLabel(view.slots, 2), '结束');
  assert.equal(publishBlocker(view), '结束 还没批准');
  assert.equal(slotLabel(view.slots, 1), '欢迎 2');
});
test('an empty slot (no takes) is not approved', () => {
  assert.equal(
    publishBlocker(clips([slot(1, { takes: [], selectedTakeId: null, approved: false })])),
    '欢迎 1 还没批准',
  );
});

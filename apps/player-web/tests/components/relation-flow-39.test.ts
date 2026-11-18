// Part 39 / 39b (named exception, owner decision 2026-11-18): the relation flow of the co-creation sheet is opened FROM one character (the
// anchor). The old tests, which rolled two characters of the whole catalog, are replaced by the tests below: the relation always includes
// the anchor, 🎲 picks a random OTHER one, the ratings are anchor 对 X and X 对 anchor, the anchor cannot be removed, up to eight.
import assert from 'node:assert/strict';
import test from 'node:test';
import { relationFlow, resetRelationDraft, type RelationSend } from '../../src/features/cocreation/relation-flow.ts';
import { RELATION_STAR_LABELS } from '../../../../packages/contracts/cocreation-relations.ts';
import { type FakeElement, installFakeDom } from './fake-dom.ts';

const EVERYONE = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬'].map((name, i) => ({
  characterId: `c${i}`,
  name,
}));

function setup(t: test.TestContext, anchor = 'c3', random: () => number = () => 0, fresh = true) {
  installFakeDom(t);
  if (fresh) resetRelationDraft();
  t.after(resetRelationDraft);
  const sent: RelationSend[] = [];
  const heads: string[] = [];
  const flow = relationFlow({
    send: async (input) => {
      sent.push(structuredClone(input));
      return { earned: 5 };
    },
    everyone: EVERYONE,
    anchor,
    random,
    newRequestId: () => `req-${sent.length + 1}`,
    track: () => {},
    onHead: (head) => heads.push(`${head.open}|${head.glyph}|${head.title}|${head.progress}`),
    onSent: () => {},
  });
  const screen = flow.screen as unknown as FakeElement;
  const roll = () => (flow.entry as unknown as FakeElement).querySelector('.cc-rel-dice')!.click();
  return {
    flow,
    screen,
    sent,
    heads,
    roll,
    members: () => screen.querySelectorAll('.cc-rel-chip').map((c) => c.getAttribute('data-member')),
    q: (selector: string) => screen.querySelector(selector)!,
    all: (selector: string) => screen.querySelectorAll(selector),
  };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test('the dice picks a random OTHER character: the relation is the anchor plus that one, in the console order', (t) => {
  const s = setup(t, 'c3', () => 0);
  s.roll();
  assert.equal(s.flow.isOpen(), true);
  assert.deepEqual(s.members(), ['c0', 'c3'], 'random 0 is the first OTHER character, never the anchor twice');
  assert.equal(
    s
      .all('.cc-rel-chip')
      .find((c) => c.getAttribute('data-member') === 'c3')!
      .getAttribute('data-anchor'),
    'true',
  );
  // Every other character is reachable by the roll, uniformly and whatever the catalog order: 8 values of the random number hit 8 different ones.
  const hit = new Set<string>();
  for (let k = 0; k < 8; k++) {
    const roller = setup(t, 'c3', () => (k + 0.5) / 8);
    roller.roll();
    const other = roller.members().find((id) => id !== 'c3')!;
    assert.ok(other !== 'c3');
    assert.equal(roller.members().length, 2, 'never two OTHER characters');
    assert.ok(roller.members().includes('c3'), 'the anchor is always a member');
    hit.add(other);
  }
  assert.equal(hit.size, 8);
  // A roll never yields an anchor-less pair, for any random value at the edges.
  for (const value of [0, 0.999999]) {
    const edge = setup(t, 'c8', () => value);
    edge.roll();
    assert.ok(edge.members().includes('c8') && edge.members().length === 2);
  }
});

test('the anchor cannot be removed; the others can while two remain; ＋ and 🎲 add up to eight in all', (t) => {
  const s = setup(t, 'c3', () => 0);
  s.roll();
  assert.equal(s.all('.cc-rel-x').length, 0, 'two members: nobody can be removed');
  // 🎲 again adds one more random non-member; ＋ lists everyone and adds the chosen one.
  s.q('.cc-rel-again').click();
  assert.equal(s.members().length, 3);
  assert.ok(s.members().includes('c3'));
  s.q('.cc-rel-plus').click();
  s.all('.cc-rel-option')
    .find((o) => o.getAttribute('data-option') === 'c8')!
    .click();
  assert.ok(s.members().includes('c8'), 'chosen directly from the list');
  const removable = s.all('.cc-rel-chip').filter((c) => c.querySelector('.cc-rel-x'));
  assert.equal(removable.length, 3, 'every member but the anchor has a ✕');
  assert.ok(!removable.some((c) => c.getAttribute('data-member') === 'c3'));
  for (let n = 0; n < 4; n++) s.q('.cc-rel-again').click();
  assert.equal(s.members().length, 8);
  assert.equal(s.all('.cc-rel-again').length, 0, 'eight is the most');
  assert.equal(s.all('.cc-rel-plus').length, 0);
  assert.ok(s.members().includes('c3'));
  assert.equal(s.screen.getAttribute('data-mode'), 'group');
  assert.equal(s.all('.cc-star').length, 0, 'a group has no stars');
  // Removing others never takes the anchor with them.
  while (s.all('.cc-rel-x').length > 0) s.q('.cc-rel-x').click();
  assert.equal(s.members().length, 2);
  assert.ok(s.members().includes('c3'));
});

test('a pair: anchor 对 X, then X 对 anchor, whole stars with their words, reason, story, then one send with both directions', async (t) => {
  const s = setup(t, 'c3', () => 0);
  s.roll();
  s.q('.cc-rel-next').click();
  assert.equal(s.q('.cc-rel-next').disabled, true, 'both ratings first');
  const rows = s.all('.cc-rate');
  assert.deepEqual(
    rows.map((row) => row.getAttribute('aria-label')),
    ['丁对甲', '甲对丁'],
    'A 对 X and X 对 A: the anchor (丁) first, never two other characters',
  );
  rows[0]!.querySelector('[data-stars="4"]')!.click();
  rows[1]!.querySelector('[data-stars="0"]')!.click();
  assert.equal(rows[0]!.querySelector('.cc-word .is-shown')!.textContent, RELATION_STAR_LABELS[4]);
  assert.equal(rows[1]!.querySelector('.cc-word .is-shown')!.textContent, RELATION_STAR_LABELS[0]);
  assert.equal(s.q('.cc-rel-next').disabled, false);
  s.q('.cc-rel-next').click();
  assert.equal(s.q('.cc-rel-next').disabled, true, 'a reason is needed');
  s.q('.cc-rel-area').type_('一个爱闹一个嫌吵');
  s.q('.cc-rel-next').click();
  s.q('.cc-rel-area').type_('同桌三年');
  assert.equal(s.q('.cc-rel-next').textContent, '发送');
  s.q('.cc-rel-next').click();
  await flush();
  assert.equal(s.sent.length, 1);
  assert.deepEqual(s.sent[0], {
    requestId: 'req-1',
    characterIds: ['c0', 'c3'],
    ratings: [
      { from: 'c3', to: 'c0', stars: 4 },
      { from: 'c0', to: 'c3', stars: 0 },
    ],
    reason: '一个爱闹一个嫌吵',
    text: '同桌三年',
  });
  assert.equal(s.flow.isOpen(), false);
});

test('the header button goes one step back, then out to the deck; a group sends no ratings and no reason', async (t) => {
  const s = setup(t, 'c3', () => 0);
  s.roll();
  s.q('.cc-rel-next').click();
  assert.equal(s.flow.back(), true);
  assert.equal(s.screen.getAttribute('data-step'), 'choose');
  s.q('.cc-rel-plus').click();
  s.all('.cc-rel-option')
    .find((o) => o.getAttribute('aria-disabled') === 'false')!
    .click();
  s.q('.cc-rel-area').type_('三个人的梗');
  s.q('.cc-rel-next').click();
  await flush();
  assert.deepEqual(s.sent[0], {
    requestId: 'req-1',
    characterIds: ['c0', 'c1', 'c3'],
    ratings: null,
    reason: null,
    text: '三个人的梗',
  });
});

test('the back and next buttons are real buttons that answer click and keyboard; a draft of another character is never carried over', (t) => {
  const s = setup(t, 'c3', () => 0);
  s.roll();
  for (const selector of ['.cc-rel-back', '.cc-rel-next']) assert.equal(s.q(selector).tagName.toLowerCase(), 'button');
  s.q('.cc-rel-next').click();
  assert.equal(s.screen.getAttribute('data-step'), 'rate');
  s.q('.cc-rel-back').click();
  assert.equal(s.screen.getAttribute('data-step'), 'choose');
  // Opened from another character, the earlier draft (anchor c3) is dropped: nothing is open and nothing is chosen.
  const other = setup(t, 'c5', () => 0, false);
  assert.equal(other.flow.isOpen(), false);
  other.roll();
  assert.deepEqual(other.members(), ['c0', 'c5']);
});

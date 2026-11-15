// Part 39: the relation flow of the co-creation sheet (dice, ＋, whole stars, steps, name insertion).
import assert from 'node:assert/strict';
import test from 'node:test';
import { relationFlow, resetRelationDraft, type RelationSend } from '../../src/features/cocreation/relation-flow.ts';
import { RELATION_STAR_LABELS } from '../../../../packages/contracts/cocreation-relations.ts';
import { type FakeElement, installFakeDom } from './fake-dom.ts';

const EVERYONE = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬'].map((name, i) => ({
  characterId: `c${i}`,
  name,
}));

function setup(t: test.TestContext) {
  installFakeDom(t);
  resetRelationDraft();
  t.after(resetRelationDraft);
  const sent: RelationSend[] = [];
  const heads: string[] = [];
  const flow = relationFlow({
    send: async (input) => {
      sent.push(structuredClone(input));
      return { earned: 5 };
    },
    everyone: EVERYONE,
    random: () => 0,
    newRequestId: () => `req-${sent.length + 1}`,
    track: () => {},
    onHead: (head) => heads.push(`${head.open}|${head.glyph}|${head.title}|${head.progress}`),
    onSent: () => {},
  });
  const screen = flow.screen as unknown as FakeElement;
  return {
    flow,
    screen,
    sent,
    heads,
    q: (selector: string) => screen.querySelector(selector)!,
    all: (selector: string) => screen.querySelectorAll(selector),
  };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test('the dice picks two in the console order; ＋ adds up to eight; three make a group with the story only', (t) => {
  const s = setup(t);
  (s.flow.entry as unknown as FakeElement).querySelector('.cc-rel-dice')!.click();
  assert.equal(s.flow.isOpen(), true);
  assert.deepEqual(
    s.all('.cc-rel-chip').map((c) => c.getAttribute('data-member')),
    ['c0', 'c1'],
  );
  for (let n = 0; n < 6; n++) {
    s.q('.cc-rel-plus').click();
    const option = s.all('.cc-rel-option').find((o) => o.getAttribute('aria-disabled') === 'false')!;
    option.click();
  }
  assert.equal(s.all('.cc-rel-chip').length, 8);
  assert.equal(s.all('.cc-rel-plus').length, 0, 'eight is the most');
  assert.equal(s.screen.getAttribute('data-mode'), 'group');
  assert.equal(s.all('.cc-star').length, 0, 'a group has no stars');
  assert.deepEqual(
    s.all('.cc-rel-chip').map((c) => c.getAttribute('data-member')),
    ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'],
  );
});

test('a pair: whole stars with their words, reason, story, in order, then one send with both directions', async (t) => {
  const s = setup(t);
  (s.flow.entry as unknown as FakeElement).querySelector('.cc-rel-dice')!.click();
  s.q('.cc-rel-next').click();
  assert.equal(s.q('.cc-rel-next').disabled, true, 'both ratings first');
  const rows = s.all('.cc-rate');
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
    characterIds: ['c0', 'c1'],
    ratings: [
      { from: 'c0', to: 'c1', stars: 4 },
      { from: 'c1', to: 'c0', stars: 0 },
    ],
    reason: '一个爱闹一个嫌吵',
    text: '同桌三年',
  });
  assert.equal(s.flow.isOpen(), false);
});

test('the header button goes one step back, then out to the deck; a group sends no ratings and no reason', async (t) => {
  const s = setup(t);
  (s.flow.entry as unknown as FakeElement).querySelector('.cc-rel-dice')!.click();
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
    characterIds: ['c0', 'c1', 'c2'],
    ratings: null,
    reason: null,
    text: '三个人的梗',
  });
});

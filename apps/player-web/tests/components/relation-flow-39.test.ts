// Part 39 / 39b (named exception, owner decision 2026-11-18): the relation flow of the co-creation sheet is opened FROM one character (the
// anchor). The old tests, which rolled two characters of the whole catalog, are replaced by the tests below: the relation always includes
// the anchor, 🎲 picks a random OTHER one, the ratings are anchor 对 X and X 对 anchor, the anchor cannot be removed, up to eight.
// Part 47 (named exception, owner decision 2026-11-21): the first step of the flow is the LAST CARD of the deck, shown directly as the sentence
// 「A和[X]之间有什么故事？」 (no separate dice card, no chip row, no explanation line). The tests of the removed behaviour (the dice card that
// opened the screen, the chip row with 🎲 and ＋ beside it, 下一步 of the choose step inside the screen) are replaced by the tests below; the
// pair and group flows after the card (ratings, reason, story, one send) keep their assertions.
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
  const entry = flow.entry as unknown as FakeElement;
  return {
    flow,
    screen,
    entry,
    sent,
    heads,
    /** The people of the sentence: the anchor (plain text) and every slot, in the order shown. */
    members: () =>
      entry
        .querySelectorAll('[data-member]')
        .filter((n) => n.tagName.toLowerCase() === 'button')
        .map((c) => c.getAttribute('data-member')),
    sentence: () => entry.querySelector('.cc-rel-sentence')!.textContent.replaceAll('▾', '').replaceAll('✕', ''),
    q: (selector: string) => screen.querySelector(selector)!,
    all: (selector: string) => screen.querySelectorAll(selector),
    e: (selector: string) => entry.querySelector(selector)!,
    eAll: (selector: string) => entry.querySelectorAll(selector),
    pickOption: (id: string) =>
      entry
        .querySelectorAll('.cc-rel-option')
        .find((o) => o.getAttribute('data-option') === id)!
        .click(),
  };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test('the card shows the sentence directly: the anchor is fixed text, a random OTHER character is the partner slot; no chip row, no explanation line', (t) => {
  const s = setup(t, 'c3', () => 0);
  assert.equal(s.flow.available, true);
  assert.equal(s.flow.isOpen(), false, 'the screen is closed: the card of the deck IS the first step');
  assert.equal(s.sentence(), '丁和甲🎲之间有什么故事？');
  assert.equal(s.e('.cc-rel-me').tagName.toLowerCase(), 'span', 'the main character is plain text, not a control');
  assert.equal(s.e('.cc-rel-me').textContent, '丁');
  assert.deepEqual(s.members(), ['c0']);
  assert.equal(s.e('.cc-rel-slot').tagName.toLowerCase(), 'button');
  assert.equal(s.eAll('.cc-rel-chip').length + s.all('.cc-rel-chips').length, 0, 'no chip row');
  const words = s.entry.textContent;
  assert.ok(!words.includes('随机再加一位') && !words.includes('可以打分'), 'no explanation line');
  assert.ok(!/^🎲/u.test(s.sentence()), 'no 🎲 at the start of any text');
  for (const node of s.eAll('button'))
    assert.ok(!node.textContent.trim().startsWith('🎲') || node.textContent.trim() === '🎲');
  // Every other character can be the first partner, uniformly and whatever the catalog order: 8 values hit 8 different ones.
  const hit = new Set<string>();
  for (let k = 0; k < 8; k++) {
    const built = setup(t, 'c3', () => (k + 0.5) / 8);
    const other = built.members().find((id) => id !== 'c3')!;
    assert.equal(built.members().length, 1);
    hit.add(other!);
  }
  assert.equal(hit.size, 8);
  for (const value of [0, 0.999999]) assert.equal(setup(t, 'c8', () => value).members().length, 1);
});

test('tapping the partner name opens the list of every other character; choosing one replaces the partner, the main character is never in it', (t) => {
  const s = setup(t, 'c3', () => 0);
  s.e('.cc-rel-slot').click();
  assert.equal(s.e('.cc-rel-list').hidden, false);
  const options = s.eAll('.cc-rel-option').map((o) => o.getAttribute('data-option'));
  assert.deepEqual(
    options,
    EVERYONE.filter((p) => p.characterId !== 'c3').map((p) => p.characterId),
  );
  assert.equal(s.e('.cc-rel-slot').getAttribute('aria-expanded'), 'true');
  s.pickOption('c6');
  assert.equal(s.sentence(), '丁和庚🎲之间有什么故事？');
  assert.deepEqual(s.members(), ['c6']);
  assert.equal(s.e('.cc-rel-list').hidden, true, 'the list closes after a choice');
  // The main character cannot be changed: there is no control for it at all.
  assert.equal(s.eAll('.cc-rel-me').filter((n) => n.tagName.toLowerCase() === 'button').length, 0);
});

test('🎲 beside the partner picks another random OTHER character (never the one shown, never the anchor)', (t) => {
  let n = 0;
  const s = setup(t, 'c3', () => (n++ === 0 ? 0 : 0.99));
  assert.deepEqual(s.members(), ['c0']);
  s.e('.cc-rel-dice').click();
  const next = s.members();
  assert.equal(next.length, 1);
  assert.ok(next[0] !== 'c0' && next[0] !== 'c3');
  assert.equal(next[0], 'c8', 'random 0.99 over the others without the one shown');
  // Over many rolls the partner is always another character than the one before.
  let now = s.members()[0]!;
  for (let k = 0; k < 20; k++) {
    s.e('.cc-rel-dice').click();
    const after = s.members()[0]!;
    assert.ok(after !== now && after !== 'c3');
    now = after;
  }
});

test('＋ adds people INTO the sentence (「A、B和C」), each can be removed while two remain, up to eight in all; 🎲 is for the pair only', (t) => {
  const s = setup(t, 'c3', () => 0);
  assert.equal(s.eAll('.cc-rel-x').length, 0, 'two people: nobody can be removed');
  s.e('.cc-rel-plus').click();
  s.pickOption('c8');
  assert.equal(s.sentence(), '丁、甲和壬之间有什么故事？');
  assert.deepEqual(s.members(), ['c0', 'c8']);
  assert.equal(s.eAll('.cc-rel-dice').length, 0, 'a group has no 🎲');
  assert.equal(s.eAll('.cc-rel-x').length, 2, 'every person but the main character has a ✕');
  // up to eight in all
  for (let k = 0; k < 5; k++) {
    s.e('.cc-rel-plus').click();
    s.eAll('.cc-rel-option')
      .find((o) => o.getAttribute('aria-disabled') === 'false')!
      .click();
  }
  assert.equal(s.members().length, 7);
  assert.equal(s.e('.cc-rel-plus').hidden, true, 'eight is the most');
  // removing never takes the main character, and stops at two
  while (s.eAll('.cc-rel-x').length > 0) s.e('.cc-rel-x').click();
  assert.equal(s.members().length, 1);
  assert.match(s.sentence(), /^丁和.🎲之间有什么故事？$/u);
});

test('下一步 on the card: two people go to the ratings, three or more go to the group story', (t) => {
  const pair = setup(t, 'c3', () => 0);
  pair.e('.cc-rel-card-next').click();
  assert.equal(pair.flow.isOpen(), true);
  assert.equal(pair.screen.getAttribute('data-step'), 'rate');
  assert.equal(pair.screen.getAttribute('data-mode'), 'pair');
  const group = setup(t, 'c3', () => 0);
  group.e('.cc-rel-plus').click();
  group.pickOption('c8');
  group.e('.cc-rel-card-next').click();
  assert.equal(group.flow.isOpen(), true);
  assert.equal(group.screen.getAttribute('data-step'), 'group');
  assert.equal(group.screen.getAttribute('data-mode'), 'group');
  assert.equal(group.all('.cc-star').length, 0, 'a group has no stars');
});

test('a pair: anchor 对 X, then X 对 anchor, whole stars with their words, reason, story, then one send with both directions', async (t) => {
  const s = setup(t, 'c3', () => 0);
  s.e('.cc-rel-card-next').click();
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

test('the header button goes one step back, then out to the card; a group sends no ratings and no reason', async (t) => {
  const s = setup(t, 'c3', () => 0);
  s.e('.cc-rel-card-next').click();
  assert.equal(s.flow.back(), true);
  assert.equal(s.flow.isOpen(), false, 'the first step of the screen goes back to the card of the deck');
  s.e('.cc-rel-plus').click();
  s.eAll('.cc-rel-option')
    .find((o) => o.getAttribute('aria-disabled') === 'false')!
    .click();
  s.e('.cc-rel-card-next').click();
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

test('the buttons are real buttons that answer click; a draft of another character is never carried over', (t) => {
  const s = setup(t, 'c3', () => 0);
  for (const selector of ['.cc-rel-slot', '.cc-rel-dice', '.cc-rel-plus', '.cc-rel-card-next'])
    assert.equal(s.e(selector).tagName.toLowerCase(), 'button');
  s.e('.cc-rel-card-next').click();
  assert.equal(s.screen.getAttribute('data-step'), 'rate');
  s.q('.cc-rel-back').click();
  assert.equal(s.flow.isOpen(), false);
  assert.equal(s.sentence(), '丁和甲🎲之间有什么故事？', 'the choice is kept on the card');
  // Opened from another character, the earlier draft (anchor c3) is dropped: a new partner is drawn.
  const other = setup(t, 'c5', () => 0, false);
  assert.equal(other.flow.isOpen(), false);
  assert.deepEqual(other.members(), ['c0']);
  assert.equal(other.e('.cc-rel-me').textContent, '己');
});

// Part 47: the fixed card 「{name}的一天都会干什么？」 in the sheet: always in the deck, right after the five themes and before the relation card;
// six optional parts; at least one written to hand it in; the answers are one text answer per written part; spent for the day once handed over.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  openCocreationSheet,
  resetCocreationDrafts,
  type CocreationApi,
} from '../../src/features/cocreation/cocreation-sheet.ts';
import type { CocreationAnswer } from '../../../../packages/contracts/cocreation-cards.ts';
import { COCREATION_THEME_IDS } from '../../../../packages/contracts/cocreation-wordings.ts';
import { type FakeElement, flush, installFakeDom } from './fake-dom.ts';

const EVERYONE = ['瓜瓜', '乙', '丙'].map((name, i) => ({ characterId: i === 0 ? 'wei-guagua' : `c${i}`, name }));

function setup(t: test.TestContext, over: Partial<CocreationApi> = {}, relation = true) {
  const doc = installFakeDom(t);
  resetCocreationDrafts();
  t.after(resetCocreationDrafts);
  const calls: { requestId: string; answers: CocreationAnswer[] }[] = [];
  const api: CocreationApi = {
    submitCocreation: async (input) => {
      calls.push(structuredClone({ requestId: input.requestId, answers: input.answers }));
      return { submissionId: `s${calls.length}`, answered: input.answers.length, duplicate: false };
    },
    ...(relation ? { submitRelation: async () => ({ submissionId: 'r', duplicate: false }) } : {}),
    ...over,
  };
  let n = 0;
  const sheet = openCocreationSheet({
    api,
    characterId: 'wei-guagua',
    name: '瓜瓜',
    mount: doc.body as unknown as HTMLElement,
    random: () => 0,
    newRequestId: () => `request-${++n}`,
    thanksMs: 0,
    ...(relation ? { everyone: EVERYONE } : {}),
  });
  const root = () => sheet.element as unknown as FakeElement;
  const day = () => root().querySelector('[data-card="day"]')!;
  const part = (name: string) => day().querySelector(`textarea[data-part="${name}"]`)!;
  return {
    root,
    day,
    part,
    calls,
    send: () => root().querySelector('.cc-send')!,
    progress: () => root().querySelector('.cc-progress')!.textContent,
  };
}

test('the deck: five themes, then 「一天」, then the relation card (the last one)', async (t) => {
  const s = setup(t);
  await flush();
  const order = s
    .root()
    .querySelectorAll('.cc-deck .cc-card')
    .map((card) => card.getAttribute('data-card'));
  assert.deepEqual(order, [...COCREATION_THEME_IDS, 'day', 'relation']);
  assert.equal(s.day().querySelector('.cc-prompt')!.textContent, '瓜瓜的一天都会干什么？');
  assert.equal(s.root().querySelectorAll('.cc-dots i').length, 7);
  // without the relation flow the deck ends with 一天
  const plain = setup(t, {}, false);
  await flush();
  assert.deepEqual(
    plain
      .root()
      .querySelectorAll('.cc-deck .cc-card')
      .map((card) => card.getAttribute('data-card')),
    [...COCREATION_THEME_IDS, 'day'],
  );
});

test('six parts, none required alone: at least one must be written to hand the card in', async (t) => {
  const s = setup(t);
  await flush();
  s.day().querySelector('.cc-face')!.click();
  const labels = s
    .day()
    .querySelectorAll('.cc-day-label')
    .map((l) => l.textContent.replace('✓', ''));
  assert.deepEqual(labels, ['早上', '中午', '下午', '晚上', '深夜', '一整天的故事']);
  assert.equal(s.send().disabled, true, 'nothing written yet');
  assert.equal(s.part('whole').getAttribute('maxlength'), '800');
  assert.equal(s.part('morning').getAttribute('maxlength'), '300');
  s.part('lateNight').type_('   ');
  assert.equal(s.send().disabled, true, 'blank is not written');
  s.part('lateNight').type_('看星星');
  assert.equal(s.send().disabled, false, 'one part is enough');
  assert.equal(s.progress(), '1 / 6', 'the card counts once however many parts are written');
  s.part('morning').type_('先喂猫');
  assert.equal(s.progress(), '1 / 6');
});

test('hand-over: one text answer per written part (no wording), in the order of the day; one request id; a retry cannot double', async (t) => {
  let fail = true;
  const s = setup(t, {
    submitCocreation: async (input) => {
      s.calls.push(structuredClone({ requestId: input.requestId, answers: input.answers }));
      if (fail) {
        fail = false;
        throw Object.assign(new Error('x'), { code: 'NETWORK' });
      }
      return { submissionId: 'ok', answered: input.answers.length, duplicate: false };
    },
  });
  await flush();
  s.day().querySelector('.cc-face')!.click();
  s.part('whole').type_('一整天都在晒太阳');
  s.part('morning').type_('先喂猫');
  s.send().click();
  await flush();
  assert.equal(s.root().querySelector('.cc-thanks')!.hidden, true, 'a failed send keeps the sheet and the draft');
  assert.equal((s.part('morning') as unknown as { value: string }).value, '先喂猫');
  s.send().click();
  await flush();
  assert.equal(s.calls.length, 2);
  assert.equal(s.calls[0]!.requestId, s.calls[1]!.requestId, 'the same content keeps the same request id');
  assert.deepEqual(s.calls[1]!.answers, [
    { cardId: 'day-morning', text: '先喂猫' },
    { cardId: 'day-whole', text: '一整天都在晒太阳' },
  ]);
  assert.equal(s.root().querySelector('.cc-thanks')!.hidden, false, 'the same thank-you as the other cards');
});

test('a part answered today closes the card: it shows as used and cannot be opened', async (t) => {
  const s = setup(t, { cocreationToday: async () => ({ cardIds: ['day-noon'] }) });
  await flush();
  await flush();
  assert.ok(s.day().className.includes('is-used'));
  assert.equal(s.day().querySelector('.cc-face')!.disabled, true);
});

test('clearing the card takes every part back out; drafts stay in memory across closing and opening', async (t) => {
  const s = setup(t);
  await flush();
  s.day().querySelector('.cc-face')!.click();
  s.part('noon').type_('午睡');
  assert.equal(s.progress(), '1 / 6');
  s.day().querySelector('.cc-skip')!.click();
  assert.equal(s.progress(), '0 / 6');
  assert.equal((s.part('noon') as unknown as { value: string }).value, '');
});

// ---- the admin side: a part is adopted into 一天的安排 of the DRAFT (a pure change of the template; nothing is published here) ----
import { boxKind, draftBox, withField } from '../../src/features/admin/cocreation-draft-box.ts';

const template = (settings: Record<string, unknown> = {}) =>
  ({ persona: 'p', authorCanon: { kind: 'author_canon', settings } }) as never;

test('adopting a part: the box shows that part only, the field changes only that part of dailyLife, an emptied part goes away', (t) => {
  installFakeDom(t);
  assert.equal(boxKind(template(), 'dailyLife', 'morning'), 'text');
  assert.equal(boxKind(template({ dailyLife: { morning: '先喂猫' } }), 'dailyLife', 'noon'), 'text');
  assert.equal(
    boxKind(template({ dailyLife: 'oops' }), 'dailyLife', 'noon'),
    'unsupported',
    'another shape is never rewritten',
  );
  const base = template({ speechStyle: '短句', dailyLife: { morning: '先喂猫' } });
  const next = withField(base, 'dailyLife', '先喂猫\n再煮咖啡', 'morning') as unknown as {
    authorCanon: { settings: Record<string, unknown> };
    persona: string;
  };
  assert.deepEqual(next.authorCanon.settings, { speechStyle: '短句', dailyLife: { morning: '先喂猫\n再煮咖啡' } });
  const more = withField(next, 'dailyLife', '晒太阳', 'whole') as unknown as {
    authorCanon: { settings: Record<string, any> };
  };
  assert.deepEqual(Object.keys(more.authorCanon.settings.dailyLife), ['morning', 'whole']);
  const none = withField(
    withField(template({ dailyLife: { noon: '午睡' } }), 'dailyLife', '', 'noon'),
    'dailyLife',
    '',
    'noon',
  ) as unknown as {
    authorCanon: { settings: Record<string, unknown> };
  };
  assert.equal('dailyLife' in none.authorCanon.settings, false);
  // the input is never mutated
  assert.deepEqual((base as unknown as { authorCanon: { settings: unknown } }).authorCanon.settings, {
    speechStyle: '短句',
    dailyLife: { morning: '先喂猫' },
  });
  // the box: 加入草稿 puts the note into the part's text; a too-long result is refused with a sentence
  const box = draftBox({
    template: template({ dailyLife: { morning: '先喂猫' } }),
    field: 'dailyLife',
    part: 'morning',
    source: { text: '再煮咖啡' },
    character: '瓜瓜',
    readOnly: false,
    onEdit: () => {},
  });
  assert.equal(box.insert(), true);
  const result = box.result();
  assert.ok(result.ok && result.value === '先喂猫\n再煮咖啡');
  const long = draftBox({
    template: template({ dailyLife: { morning: '长'.repeat(299) } }),
    field: 'dailyLife',
    part: 'morning',
    source: { text: '再来一些' },
    character: '瓜瓜',
    readOnly: false,
    onEdit: () => {},
  });
  long.insert();
  const refused = long.result();
  assert.ok(!refused.ok && refused.error.includes('300'));
});

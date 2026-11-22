// Part 47: the fixed card 「{name}的一天都会干什么？」 (six optional parts, each its own text answer) and 「一天的安排」 in the 说话档案.
import assert from 'node:assert/strict';
import test from 'node:test';
import { validatedTemplate } from '../../../apps/server/characters/template-validation.ts';
import {
  DAILY_LIFE_KEY,
  DAY_PARTS,
  DAY_PART_LABELS,
  DAY_PART_MAX,
  dailyLifeValid,
  dayCardId,
  dayPartOf,
} from '../../../packages/contracts/cocreation-day.ts';
import { cocreationCard, validateCocreationAnswers } from '../../../packages/contracts/cocreation-cards.ts';
import {
  SpeechProfileError,
  readDailyLife,
  settingsOf,
  writeDailyPart,
} from '../../../packages/contracts/speech-profile.ts';
import { textRequest } from '../../text-fixtures.ts';

const code = (work: () => unknown) => {
  try {
    work();
  } catch (error) {
    assert.ok(error instanceof SpeechProfileError, String(error));
    return error.code;
  }
  return 'ok';
};
const tpl = (settings: Record<string, unknown> = {}) => ({
  id: 'a',
  name: 'A',
  version: 1,
  fictional: true,
  persona: 'p',
  schedule: textRequest().character.schedule,
  authorCanon: { kind: 'author_canon', settings },
});

test('the six parts: labels, caps (300 each, 800 for the whole-day story), card ids and the way back', () => {
  assert.deepEqual(
    DAY_PARTS.map((part) => DAY_PART_LABELS[part]),
    ['早上', '中午', '下午', '晚上', '深夜', '一整天的故事'],
  );
  assert.deepEqual(
    DAY_PARTS.map((part) => DAY_PART_MAX[part]),
    [300, 300, 300, 300, 300, 800],
  );
  for (const part of DAY_PARTS) {
    assert.equal(dayPartOf(dayCardId(part)), part);
    assert.equal(cocreationCard(dayCardId(part))?.kind, 'text', 'an ordinary text card: no table change');
    assert.equal(cocreationCard(dayCardId(part))?.day, part);
  }
  assert.equal(dayPartOf('day-evening-x'), null);
  assert.equal(dayPartOf('theme-habit'), null);
});

test('answers: one part is enough, which parts were answered is which answers there are, each part has its own cap', () => {
  const ok = validateCocreationAnswers([{ cardId: 'day-morning', text: '先喂猫' }]);
  assert.ok(ok.ok && ok.answers.length === 1);
  const several = validateCocreationAnswers([
    { cardId: 'day-lateNight', text: '看星星' },
    { cardId: 'day-whole', text: '长'.repeat(800) },
  ]);
  assert.ok(several.ok && several.answers.map((answer) => answer.cardId).join() === 'day-lateNight,day-whole');
  assert.deepEqual(validateCocreationAnswers([]), { ok: false, code: 'COCREATION_EMPTY' });
  assert.deepEqual(validateCocreationAnswers([{ cardId: 'day-noon', text: '   ' }]), {
    ok: false,
    code: 'COCREATION_TEXT_INVALID',
  });
  assert.deepEqual(validateCocreationAnswers([{ cardId: 'day-noon', text: '长'.repeat(301) }]), {
    ok: false,
    code: 'COCREATION_TEXT_INVALID',
  });
  assert.deepEqual(validateCocreationAnswers([{ cardId: 'day-whole', text: '长'.repeat(801) }]), {
    ok: false,
    code: 'COCREATION_TEXT_INVALID',
  });
  // a part carries no wording; a part twice is refused
  assert.deepEqual(validateCocreationAnswers([{ cardId: 'day-noon', text: 'a', wording: 'x' }]), {
    ok: false,
    code: 'INVALID_REQUEST',
  });
  assert.deepEqual(
    validateCocreationAnswers([
      { cardId: 'day-noon', text: 'a' },
      { cardId: 'day-noon', text: 'b' },
    ]),
    { ok: false, code: 'COCREATION_CARD_INVALID' },
  );
});

test('一天的安排: read, adopt part by part (appended on a line), replace, clear, caps, and nothing else of the template moves', () => {
  const start = tpl({ speechStyle: '短句' });
  assert.deepEqual(readDailyLife(start), {
    parts: { morning: '', noon: '', afternoon: '', evening: '', lateNight: '', whole: '' },
    editable: true,
  });
  const one = writeDailyPart(start, 'morning', '先喂猫', 'append');
  const two = writeDailyPart(one, 'morning', '再煮咖啡', 'append');
  assert.equal(readDailyLife(two).parts.morning, '先喂猫\n再煮咖啡');
  assert.deepEqual(Object.keys(settingsOf(two).dailyLife as object), ['morning']);
  assert.equal(settingsOf(two).speechStyle, '短句', 'the other keys are untouched');
  assert.equal(JSON.stringify(settingsOf(start)), '{"speechStyle":"短句"}', 'the input is never mutated');
  const whole = writeDailyPart(two, 'whole', '长'.repeat(800), 'replace');
  assert.equal(readDailyLife(whole).parts.whole.length, 800);
  assert.equal(
    code(() => writeDailyPart(whole, 'whole', '多', 'append')),
    'PROFILE_DAILY_TOO_LONG',
  );
  assert.equal(
    code(() => writeDailyPart(two, 'noon', '长'.repeat(301), 'replace')),
    'PROFILE_DAILY_TOO_LONG',
  );
  assert.equal(
    code(() => writeDailyPart(two, 'noon', '  ', 'append')),
    'PROFILE_TEXT_REQUIRED',
  );
  const cleared = writeDailyPart(writeDailyPart(one, 'morning', '', 'replace'), 'noon', '', 'replace');
  assert.equal(DAILY_LIFE_KEY in settingsOf(cleared), false, 'an empty record is removed');
  // a stored value that is not a record is never rewritten
  assert.deepEqual(readDailyLife(tpl({ dailyLife: 'x' })).editable, false);
  assert.equal(
    code(() => writeDailyPart(tpl({ dailyLife: 'x' }), 'noon', 'a', 'append')),
    'PROFILE_DAILY_SHAPE_UNSUPPORTED',
  );
});

test('the template validation allows dailyLife (no schema change) and refuses another shape', () => {
  assert.doesNotThrow(() => validatedTemplate(tpl({ dailyLife: { morning: '先喂猫', whole: '长'.repeat(800) } })));
  for (const bad of [
    'text',
    ['a'],
    { brunch: '吃' },
    { morning: 3 },
    { morning: '  ' },
    { morning: '长'.repeat(301) },
    { whole: '长'.repeat(801) },
  ])
    assert.throws(() => validatedTemplate(tpl({ dailyLife: bad })), /INVALID_DAILY_LIFE/, JSON.stringify(bad));
  assert.equal(dailyLifeValid({ evening: '散步' }), true);
});

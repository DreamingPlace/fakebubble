import assert from 'node:assert/strict';
import test from 'node:test';
import type { TextGenerationRequest } from '../../../packages/contracts/index.ts';
import {
  REHEARSAL_RULES_TONE_SETS,
  REHEARSAL_SET_LABELS,
  rehearsalTurnsMin,
} from '../../../packages/contracts/web-rehearsal.ts';
import { PROMPTS_V8 } from '../../../apps/server/generation/writer-prompts.generated.ts';
import {
  GUARD_REASONS,
  applyReview,
  cleanSpokenLine,
  parseDraft,
  writerGuardTool,
  type WriterDraft,
} from '../../../apps/server/generation/writer-v8.ts';
import { builtinSet } from '../../../apps/server/characters/web-rehearsal-sets.ts';
import { textRequest } from '../../text-fixtures.ts';

/** Part 51, rule 6: emotional intensity in proportion to what happened. */
const v8 = (over: Partial<TextGenerationRequest> = {}) => {
  const { relationship: _drop, ...base } = textRequest();
  return { ...base, writer: 'v8', ...over } as TextGenerationRequest;
};
const noFix = { fixes: [], mode: 'casual', endsSession: false, topics: [], factOps: [] };
const draftOf = (request: TextGenerationRequest, text: string) => parseDraft({ text }, request) as WriterDraft;

test('51 rule 6 in writer.md: proportion, only big moments are strong (and short), no melodrama, personality sets the colour, voice too', () => {
  const text = PROMPTS_V8.writer;
  for (const phrase of [
    '情绪的强弱要和真正发生的事相称',
    '日常小事（吃的、忙了一天、小抱怨）就平静自然地接',
    '强烈的感情只留给真正的大事，就算那时也要短，用你自己的口气',
    '不要演：不突然表白深情，不哭不哽咽，不叠一串感叹号、问号、省略号',
    '不过度担心或夸奖（比如对一件小事说“我好心疼你！！”）',
    '你的性格决定情绪的颜色：冷淡的人开心时也冷淡，活泼的人活泼但不歇斯底里',
    '语音也一样',
    '口气不要突然大变',
  ])
    assert.ok(text.includes(phrase), phrase);
  // the 37a-3 line is replaced, not kept beside the new one
  assert.ok(!text.includes('情绪写在字里'));
  assert.ok([...text].length < 4000);
});

test('51 the guard has a ninth reason for it, and the 37a-2 direction filter for voice is unchanged', () => {
  const g = PROMPTS_V8.guard;
  assert.equal(GUARD_REASONS.length, 9);
  assert.ok(GUARD_REASONS.includes('over_intense' as never));
  assert.ok(g.includes('只有下面九种情况') && g.includes('没有这九种问题'));
  for (const phrase of [
    'over_intense：情绪强度和对方这条消息明显不相称',
    '小事（吃的、忙了一天、小抱怨）却哭、哽咽、突然剖白深情、叠一串感叹号问号省略号、过度担心或夸奖（如“我好心疼你！！”）',
    '对方真的遇到大事时强烈一点不算',
    '只是语气比平时活泼、不够克制，也不算',
    '替换成同样意思、短、平静自然的一句，保持角色的性格',
  ])
    assert.ok(g.includes(phrase), phrase);
  const tool = writerGuardTool(v8()) as unknown as {
    function: { parameters: { properties: { fixes: { items: { properties: { reason: { enum: string[] } } } } } } };
  };
  assert.ok(tool.function.parameters.properties.fixes.items.properties.reason.enum.includes('over_intense'));
  // a direction that asks for shouting is still dropped (words stay), a calm one still survives
  assert.deepEqual(cleanSpokenLine('[大喊]好耶', true), { text: '好耶', markup: null });
  assert.equal(cleanSpokenLine('[笑着，慢一点]好呀', true).markup, '[笑着，慢一点]好呀');
});

test('51 the guard flags a reply out of proportion to a small thing, and lets a big moment and a calm reply through', () => {
  const base = textRequest();
  const small = v8({ messages: [{ ...base.messages[0]!, text: '今天公交晚点了十分钟' }] });
  const over = '呜呜呜我好心疼你！！！你一定很难受吧……！！';
  const calm = '啊，晚点最烦了，赶上就好';
  const flagged = applyReview(
    { ...noFix, fixes: [{ index: 0, reason: 'over_intense', text: '晚点最烦了，赶上就好' }] },
    draftOf(small, over),
    small,
  );
  assert.deepEqual(flagged.guardReasons, ['over_intense']);
  assert.equal(flagged.bubbles[0]!.text, '晚点最烦了，赶上就好');
  assert.equal(flagged.reviewChanged, true);
  // a calm reply to the small thing: no fix, published as written
  assert.equal(applyReview(noFix, draftOf(small, calm), small).reviewChanged, false);
  // something big: a short, strong reply is not flagged
  const big = v8({ messages: [{ ...base.messages[0]!, text: '我考研成绩出来了，过线了，还是专业第一' }] });
  const reply = '真的假的，太棒了，你这两年没白熬';
  const passed = applyReview(noFix, draftOf(big, reply), big);
  assert.equal(passed.reviewChanged, false);
  assert.deepEqual(passed.guardReasons, []);
});

test('51 「v8 规则 51」 情绪: three small things and one big one, short, each in its own set', () => {
  assert.deepEqual(REHEARSAL_RULES_TONE_SETS, [
    'rules-51-small-bus',
    'rules-51-small-coffee',
    'rules-51-small-day',
    'rules-51-big',
  ]);
  for (const set of REHEARSAL_RULES_TONE_SETS) {
    const turns = builtinSet(set);
    assert.ok(REHEARSAL_SET_LABELS[set].startsWith('v8 规则 51 · 情绪 '));
    assert.equal(rehearsalTurnsMin(set), 4);
    assert.ok(turns.length >= 4 && turns.length <= 20, set);
    assert.ok(turns.every((turn) => turn.length > 0 && turn.length <= 200));
  }
  assert.ok(builtinSet('rules-51-small-bus').some((t) => t.includes('公交晚点')));
  assert.ok(builtinSet('rules-51-small-coffee').some((t) => t.includes('咖啡')));
  assert.ok(builtinSet('rules-51-small-day').some((t) => t.includes('忙了一整天')));
  assert.ok(builtinSet('rules-51-big').some((t) => t.includes('考研成绩') && t.includes('第一')));
});

import assert from 'node:assert/strict';
import test from 'node:test';
import type { TextGenerationRequest } from '../../../packages/contracts/index.ts';
import { WELCOME_LIMITS, welcomeProblems } from '../../../packages/contracts/web-welcomes.ts';
import { clipManifest } from '../../../apps/server/characters/web-clip-manifest.ts';
import { OPENING_NOTE_PLAYER_MESSAGES, openingForWriter } from '../../../apps/server/generation/opening-line.ts';
import {
  applyReview,
  cleanSpokenLine,
  parseDraft,
  writerDraftMessages,
} from '../../../apps/server/generation/writer-v8.ts';
import { PROMPTS_V8 } from '../../../apps/server/generation/writer-prompts.generated.ts';
import { LOUD_DIRECTION_WORDS, dropLoudDirections, speechPayload } from '../../../workers/audio/fish.ts';
import { textRequest } from '../../text-fixtures.ts';

const v8 = (over: Partial<TextGenerationRequest> = {}): TextGenerationRequest => {
  const { relationship: _drop, ...base } = textRequest();
  return { ...base, writer: 'v8', ...over } as TextGenerationRequest;
};
const NOTE = '弟弟家朋用你的账号在他的电话手表上加了玩家，你刚发现。这是你和玩家第一次说话。';

// ---- 1. the 情境 note ------------------------------------------------------------------------------------------------------

test('a welcome line may carry a 情境 note of at most 200 characters, no control characters; no note is fine', () => {
  const line = (context?: unknown) => [
    { id: 'a', text: '家朋怎么又拿电话手表乱加人', weight: 100, ...(context === undefined ? {} : { context }) },
  ];
  assert.deepEqual(welcomeProblems(line()), []);
  assert.deepEqual(welcomeProblems(line(NOTE)), []);
  assert.deepEqual(welcomeProblems(line('字'.repeat(WELCOME_LIMITS.context))), []);
  assert.equal(welcomeProblems(line('字'.repeat(WELCOME_LIMITS.context + 1)))[0]?.field, 'context');
  assert.equal(welcomeProblems(line('a\u0000b'))[0]?.field, 'context');
  assert.equal(welcomeProblems(line(5))[0]?.field, 'context');
});

test('the note is never spoken: the clip manifest (what the audio is keyed to) is the same with and without it', () => {
  const store = { publicFreeTier: false, get: () => undefined, all: () => [] } as never;
  const profile = (context?: string) => ({
    presentation: {
      welcomes: [
        { id: 'w1', text: '家朋怎么又拿电话手表乱加人', weight: 50, ...(context ? { context } : {}) },
        { id: 'w2', text: '嗨，你好呀', weight: 50 },
      ],
    },
  });
  const without = clipManifest(store, profile(), { referenceId: 'voice-1' }, 's2.1-pro');
  const withNote = clipManifest(store, profile(NOTE), { referenceId: 'voice-1' }, 's2.1-pro');
  assert.deepEqual(withNote, without, 'editing a note changes no slot, so no clip goes stale');
  assert.ok(!JSON.stringify(withNote).includes('弟弟家朋'), 'the note is not a slot text');
  assert.deepEqual(
    withNote.slots.filter((slot) => slot.kind === 'welcome').map((slot) => slot.text),
    ['家朋怎么又拿电话手表乱加人', '嗨，你好呀'],
  );
});

test("the v8 writer is told what was happening when the opening was sent, as the character's own first message", () => {
  const [system, user] = writerDraftMessages(v8({ opening: { text: '家朋怎么又拿电话手表乱加人', context: NOTE } }));
  const body = JSON.parse(user!.content) as { opening: Record<string, unknown>[]; messages: unknown[] };
  assert.deepEqual(body.opening, [
    { authorKind: 'character', delivery: 'voice', text: '家朋怎么又拿电话手表乱加人', situation: NOTE },
  ]);
  assert.ok(Object.keys(body).indexOf('opening') < Object.keys(body).indexOf('messages'), 'before every other message');
  assert.ok(system!.content.includes('opening是你自己发出的第一条消息'));
  // no note, no key
  const bare = JSON.parse(writerDraftMessages(v8({ opening: { text: '嗨' } }))[1]!.content) as { opening: object[] };
  assert.deepEqual(bare.opening, [{ authorKind: 'character', delivery: 'voice', text: '嗨' }]);
});

test('the note stays for the first %d player messages of a v8 chat and never reaches v7', () => {
  const opening = { text: '嗨', context: NOTE };
  assert.equal(OPENING_NOTE_PLAYER_MESSAGES, 6);
  for (let n = 1; n <= 6; n++) assert.equal(openingForWriter(opening, true, n).context, NOTE, `message ${n}`);
  assert.deepEqual(openingForWriter(opening, true, 7), { text: '嗨' });
  assert.deepEqual(openingForWriter(opening, false, 1), { text: '嗨' }, 'v7 is byte-identical');
});

// ---- 2. who the character is to every player -----------------------------------------------------------------------------

test("the roster rides in the persona prompt for every v8 reply; the player's preset identity is not sent", () => {
  const roster = [
    { name: '甲', aliases: ['小甲'], oneLiner: '爱笑的主唱' },
    { name: '乙', aliases: [], oneLiner: '' },
  ];
  const association = {
    association: 'fan',
    revision: 1,
    initialTrust: 80,
    initialFamiliarity: 70,
    policyVersion: 1,
  } as never;
  const request = v8({
    roster,
    playerIntroduction: { source: 'player_setup', revision: 2, name: '小明', age: 20, association },
  });
  const [system, user] = writerDraftMessages(request);
  assert.ok(system!.content.includes('队友名单（JSON'));
  assert.ok(
    system!.content.includes(
      JSON.stringify([{ name: '甲', aliases: ['小甲'], oneLiner: '爱笑的主唱' }, { name: '乙' }]),
    ),
  );
  assert.ok(!system!.content.includes('persona'), 'cards only');
  const body = JSON.parse(user!.content) as { playerIntroduction: Record<string, unknown> };
  assert.deepEqual(body.playerIntroduction, { source: 'player_setup', revision: 2, name: '小明', age: 20 });
  assert.ok(!user!.content.includes('initialTrust') && !user!.content.includes('association'));
  // no roster, no block
  assert.ok(!writerDraftMessages(v8())[0]!.content.includes('队友名单（JSON'));
  assert.throws(() => writerDraftMessages(v8({ roster: [{ name: '', aliases: [], oneLiner: '' }] })), {
    message: 'INVALID_TEXT_REQUEST',
  });
});

test('the writer prompt states the default (everyone knows them, they have only just met this player), dialect and identity', () => {
  const text = PROMPTS_V8.writer;
  for (const phrase of [
    '每个玩家都见过你',
    '第一次和这位玩家说话',
    '你有队友',
    '不带方言词和口音',
    '啥子',
    '人设里没有的身份不编',
    '在哪长大',
  ])
    assert.ok(text.includes(phrase), phrase);
});

// ---- 4. voice -------------------------------------------------------------------------------------------------------------

test('Drama 3 directions: shouting directions are dropped, the words and the calm directions stay', () => {
  assert.deepEqual(
    [...LOUD_DIRECTION_WORDS],
    ['大喊', '尖叫', '嘶吼', '咆哮', '激动地喊', 'shout', 'scream', 'yell', 'roar'],
  );
  const cases: [string, string][] = [
    ['[大喊]真的假的', '真的假的'],
    ['[激动地喊，快一点]太好了', '太好了'],
    ['[尖叫]啊啊啊好开心', '啊啊啊好开心'],
    ['[Shouting]太棒了', '太棒了'],
    ['[screaming with joy]太棒了', '太棒了'],
    ['[roar][yell]走吧', '走吧'],
    ['[嘶吼]你来', '你来'],
    ['[咆哮]你来', '你来'],
    ['[慢一点]好吧，[停一下]我想想', '[慢一点]好吧，[停一下]我想想'],
    ['<whisper>[small laugh]小声说</whisper>', '<whisper>[small laugh]小声说</whisper>'],
  ];
  for (const [input, kept] of cases) assert.equal(dropLoudDirections(input), kept, input);
  // through the writer's own reading of a line: the text is the same, the markup has lost only the loud direction
  const line = cleanSpokenLine('[慢一点]好的，[大喊]我来了', true);
  assert.equal(line.text, '好的，我来了');
  assert.equal(line.markup, '[慢一点]好的，我来了');
  const loud = cleanSpokenLine('[大喊]我来了', true);
  assert.deepEqual(loud, { text: '我来了', markup: null });
  // and again right before Fish, on whatever markup was stored
  const request = {
    jobId: 'j1',
    text: '我来了',
    markup: '[咆哮]我来了',
    expression: 'neutral',
    speed: 1,
    voice: { profileId: 'p', referenceId: 'r', version: 1 },
  } as never;
  assert.ok(speechPayload(request, 'drama-3').text.includes('我来了'));
});

test('a v8 voice reply with a shouting direction publishes the text and sends Fish no shouting direction', () => {
  const request = v8({ deliveryMode: 'voice', voiceDirections: true });
  const draft = parseDraft({ text: '[大喊]太好了\n[慢一点]那我们晚点说[停一下]好吗' }, request);
  assert.deepEqual(
    draft.bubbles.map((bubble) => bubble.text),
    ['太好了', '那我们晚点说好吗'],
  );
  const markups = (draft as unknown as { markups: (string | null)[] }).markups;
  assert.equal(markups[0], null);
  assert.equal(markups[1], '[慢一点]那我们晚点说[停一下]好吗');
  const candidate = applyReview(
    { fixes: [], mode: 'casual', endsSession: false, topics: [], factOps: [] },
    draft,
    request,
  );
  assert.ok(!JSON.stringify(candidate.bubbleMarkup).includes('大喊'));
});

test('the directions prompt asks for speech, sparing pace directions and calm excitement', () => {
  const text = PROMPTS_V8.writerDirections;
  for (const phrase of ['写给人听', '翻译腔', '[快一点]', '[慢一点]', '[停一下]', '多数句子不需要', '不喊叫'])
    assert.ok(text.includes(phrase), phrase);
});

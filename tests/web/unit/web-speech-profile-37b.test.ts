import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { TextGenerationRequest } from '../../../packages/contracts/index.ts';
import {
  CORE_FIELDS,
  CORE_FIELD_KEYS,
  CORE_FIELD_MAX,
  EXAMPLES_PER_SITUATION_MAX,
  SPEECH_SITUATIONS,
  SpeechProfileError,
  UNCATEGORIZED,
  addSample,
  bankCounts,
  checkIndependence,
  deleteSample,
  moveSample,
  normalizeLine,
  readBank,
  readCoreCard,
  similarity,
  writeCoreCard,
} from '../../../packages/contracts/speech-profile.ts';
import {
  REHEARSAL_PROFILE_SETS,
  REHEARSAL_PROFILE_TURNS,
  REHEARSAL_SETS,
  isRehearsalModels,
  parseRehearsalColumn,
  rehearsalColumnKey,
  rehearsalColumnLabel,
  rehearsalTurnsMin,
} from '../../../packages/contracts/web-rehearsal.ts';
import { promptMessages } from '../../../apps/server/generation/accepted-text-prompt.ts';
import {
  writerDraftMessages,
  writerGuardMessages,
  writerPins,
  writerPolicyHash,
} from '../../../apps/server/generation/writer-v8.ts';
import {
  PROFILE_EXAMPLES_MAX,
  WRITER_PROFILE_SHA256,
  pickExamples,
  pickSituation,
  writerProfileHash,
} from '../../../apps/server/generation/writer-profile.ts';
import { rehearsalRequest } from '../../../apps/server/characters/web-rehearsal-request.ts';
import { builtinSet } from '../../../apps/server/characters/web-rehearsal-sets.ts';
import { validatedTemplate } from '../../../apps/server/characters/template-validation.ts';
import { textRequest } from '../../text-fixtures.ts';

const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const code = (work: () => unknown) => {
  try {
    work();
  } catch (error) {
    assert.ok(error instanceof SpeechProfileError, String(error));
    return error.code;
  }
  return 'NO_ERROR';
};
const tpl = (settings: Record<string, unknown> | null = {}) =>
  ({ persona: '人设', ...(settings ? { authorCanon: { kind: 'author_canon', settings } } : {}) }) as {
    persona: string;
    authorCanon?: { kind: 'author_canon'; settings: Record<string, unknown> };
  };
const settingsOf = (template: object) => (template as ReturnType<typeof tpl>).authorCanon!.settings;

// ---- 核心卡 ------------------------------------------------------------------------------------------------------------------

test('the four 核心卡 fields map onto existing keys where they already mean that, and two new keys', () => {
  assert.deepEqual(CORE_FIELD_KEYS, {
    speechHabit: 'speechStyle',
    humor: 'humorStyle',
    neverSay: 'neverSay',
    length: 'dialogueStyle',
  });
  assert.equal(CORE_FIELD_MAX, 300);
});

test('adopting into each 核心卡 field writes its key; a second one is appended on its own line', () => {
  for (const field of CORE_FIELDS) {
    const once = writeCoreCard(tpl(null), field, '  第一条  ');
    assert.equal(settingsOf(once)[CORE_FIELD_KEYS[field]], '第一条');
    const twice = writeCoreCard(once, field, '第二条');
    assert.equal(settingsOf(twice)[CORE_FIELD_KEYS[field]], '第一条\n第二条');
    assert.equal(readCoreCard(twice)[field], '第一条\n第二条');
  }
  // the original is never touched
  const base = tpl({ speechStyle: '短句' });
  writeCoreCard(base, 'speechHabit', '加一句');
  assert.equal(base.authorCanon!.settings.speechStyle, '短句');
  // a list-shaped field is read as lines; its own shape is replaced by text only when the owner edits it
  const list = tpl({ speechStyle: ['爱用叠词', '语速快'] });
  assert.equal(readCoreCard(list).speechHabit, '爱用叠词\n语速快');
  assert.equal(
    code(() => writeCoreCard(tpl({ speechStyle: { a: 1 } }), 'speechHabit', 'x')),
    'PROFILE_FIELD_SHAPE_UNSUPPORTED',
  );
});

test('a 核心卡 field holds at most 300 characters; blank is refused; replace sets or clears the field', () => {
  assert.equal(
    code(() => writeCoreCard(tpl(), 'humor', '   ')),
    'PROFILE_TEXT_REQUIRED',
  );
  assert.equal(
    code(() => writeCoreCard(tpl(), 'humor', '好'.repeat(CORE_FIELD_MAX + 1))),
    'PROFILE_CARD_TOO_LONG',
  );
  const full = writeCoreCard(tpl(), 'humor', '好'.repeat(CORE_FIELD_MAX));
  assert.equal(
    code(() => writeCoreCard(full, 'humor', '再加')),
    'PROFILE_CARD_TOO_LONG',
  );
  const replaced = writeCoreCard(full, 'humor', '短', 'replace');
  assert.equal(settingsOf(replaced).humorStyle, '短');
  assert.equal('humorStyle' in settingsOf(writeCoreCard(replaced, 'humor', '', 'replace')), false);
});

test('until a field has adopted content, the current settings are the card (nothing is invented or required)', () => {
  const old = tpl({ speechStyle: '短句，爱用叠词', dialogueStyle: '一次一两句' });
  assert.deepEqual(readCoreCard(old), { speechHabit: '短句，爱用叠词', humor: '', neverSay: '', length: '一次一两句' });
  assert.deepEqual(readCoreCard(tpl(null)), { speechHabit: '', humor: '', neverSay: '', length: '' });
});

test('the two new keys are allowed in settings by the template validation (no schema change)', () => {
  const base = {
    id: 'a',
    name: 'A',
    version: 1,
    fictional: true,
    persona: 'p',
    schedule: textRequest().character.schedule,
    authorCanon: { kind: 'author_canon', settings: { humorStyle: '冷幽默', neverSay: '“亲亲”' } },
  };
  assert.doesNotThrow(() => validatedTemplate(base));
});

// ---- 说话样本 ----------------------------------------------------------------------------------------------------------------

test('adopting a sample into each of the eight situations; a free situation string stays untouched and reads as 未分类', () => {
  assert.equal(SPEECH_SITUATIONS.length, 8);
  let template = tpl({
    dialogueExamples: [
      { situation: '日常聊天', player: '嗨', reply: ['嗨呀'] },
      { player: '无情境', reply: ['哦'] },
    ],
  });
  const before = structuredClone(template);
  for (const situation of SPEECH_SITUATIONS)
    template = addSample(template, { situation, player: `玩家说${situation}`, reply: [`回复${situation}`] });
  const counts = bankCounts(template);
  for (const situation of SPEECH_SITUATIONS) assert.equal(counts[situation], 1, situation);
  assert.equal(counts[UNCATEGORIZED], 2);
  // the two old ones are exactly as they were, in place
  assert.deepEqual(settingsOf(template).dialogueExamples, [
    ...(before.authorCanon!.settings.dialogueExamples as unknown[]),
    ...SPEECH_SITUATIONS.map((situation) => ({ situation, player: `玩家说${situation}`, reply: [`回复${situation}`] })),
  ]);
  assert.deepEqual(
    readBank(template)
      .filter((entry) => entry.situation === UNCATEGORIZED)
      .map((entry) => entry.index),
    [0, 1],
  );
});

test('six per situation: the seventh is refused until one is deleted; moving into a full situation is refused too', () => {
  let template = tpl(null);
  for (let i = 0; i < EXAMPLES_PER_SITUATION_MAX; i++)
    template = addSample(template, { situation: '调侃', player: `玩家${i}`, reply: [`回复${i}`] });
  assert.equal(
    code(() => addSample(template, { situation: '调侃', player: 'x', reply: ['y'] })),
    'PROFILE_SITUATION_FULL',
  );
  // another situation is not affected
  template = addSample(template, { situation: '抱怨', player: 'x', reply: ['y'] });
  assert.equal(
    code(() => moveSample(template, 6, '调侃')),
    'PROFILE_SITUATION_FULL',
  );
  const freed = deleteSample(template, 0);
  assert.equal(bankCounts(freed)['调侃'], 5);
  const moved = moveSample(freed, readBank(freed).find((e) => e.situation === '抱怨')!.index, '调侃');
  assert.equal(bankCounts(moved)['调侃'], 6);
  assert.equal(bankCounts(moved)['抱怨'], 0);
  // validation
  assert.equal(
    code(() => addSample(tpl(null), { situation: '日常聊天 ', player: 'x', reply: ['y'] })),
    'PROFILE_SITUATION_INVALID',
  );
  assert.equal(
    code(() => addSample(tpl(null), { situation: '调侃', player: 'x', reply: [] })),
    'PROFILE_EXAMPLE_INVALID',
  );
  assert.equal(
    code(() => addSample(tpl(null), { situation: '调侃', player: 'x', reply: ['a', 'b', 'c'] })),
    'PROFILE_EXAMPLE_INVALID',
  );
  assert.equal(
    code(() => deleteSample(tpl(null), 0)),
    'PROFILE_SAMPLE_MISSING',
  );
});

test('moving an 未分类 sample gives it a situation without rewriting anything else', () => {
  const old = tpl({ dialogueExamples: [{ situation: '随便', player: 'a', reply: ['b'], extra: 1 }] });
  const moved = moveSample(old, 0, '安慰');
  assert.deepEqual(settingsOf(moved).dialogueExamples, [{ situation: '安慰', player: 'a', reply: ['b'], extra: 1 }]);
  assert.equal(bankCounts(moved)[UNCATEGORIZED], 0);
});

// ---- independence ------------------------------------------------------------------------------------------------------------

const others = (...rows: [string, object][]) => rows.map(([characterId, template]) => ({ characterId, template }));
const withReply = (line: string) => tpl({ dialogueExamples: [{ situation: '调侃', player: 'x', reply: [line] }] });

test('independence: an identical line in another character is blocked; near is a warning; the same character is allowed', () => {
  const theirs = others(['b', withReply('哎呀妈呀你可真行啊老铁')]);
  const same = checkIndependence(tpl(null), withReply('哎呀妈呀，你可真行啊，老铁！'), theirs);
  assert.equal(same.level, 'block');
  assert.equal(same.hits[0]!.characterId, 'b');
  const near = checkIndependence(tpl(null), withReply('哎呀妈呀你可真行，我服了老铁'), theirs);
  assert.equal(near.level, 'warn');
  assert.ok(near.hits[0]!.score >= 0.6 && near.hits[0]!.score < 0.9, String(near.hits[0]!.score));
  const different = checkIndependence(tpl(null), withReply('今天的云看起来像棉花糖'), theirs);
  assert.deepEqual(different, { level: 'ok', hits: [] });
  // the same character's own lines are never compared with themselves: only the lines that are NEW count, and only others are read
  const mine = withReply('我自己说过的一句话');
  assert.equal(checkIndependence(mine, mine, theirs).level, 'ok');
  assert.equal(checkIndependence(tpl(null), withReply('哎呀妈呀你可真行啊老铁'), []).level, 'ok');
  // a card field line is compared with the others' card lines and sample replies, line by line
  const card = checkIndependence(tpl(null), tpl({ humorStyle: '先吐槽再认怂\n哎呀妈呀你可真行啊老铁' }), theirs);
  assert.equal(card.level, 'block');
  // very short lines are nobody's own
  assert.equal(checkIndependence(tpl(null), withReply('哈哈'), others(['b', withReply('哈哈')])).level, 'ok');
});

test('independence is deterministic and works on normalised text', () => {
  assert.equal(normalizeLine(' 哎呀！妈呀… ABC😀'), '哎呀妈呀abc');
  assert.equal(similarity('哎呀妈呀你可真行', '哎呀，妈呀！你可真行'), 1);
  assert.equal(similarity('今天吃火锅', '明天去爬山'), 0);
  const a = checkIndependence(
    tpl(null),
    withReply('哎呀妈呀你可真行啊老弟'),
    others(['b', withReply('哎呀妈呀你可真行啊老铁')]),
  );
  const b = checkIndependence(
    tpl(null),
    withReply('哎呀妈呀你可真行啊老弟'),
    others(['b', withReply('哎呀妈呀你可真行啊老铁')]),
  );
  assert.deepEqual(a, b);
});

// ---- the situation picker ----------------------------------------------------------------------------------------------------

const TABLE: [string, string[]][] = [
  [
    '日常闲聊',
    [
      '在吗，随便聊聊呗',
      '你今天心情怎么样',
      '嗨，在干嘛呢',
      '晚上你一般几点睡',
      '最近有什么好玩的事吗',
      '刚吃完饭，你吃了吗',
    ],
  ],
  [
    '调侃',
    [
      '哈哈哈你这人也太会了吧',
      '笑死，你是不是又在装',
      '行行行，你最厉害，满意了吧',
      '就这？我还以为你多厉害呢',
      '你这个小笨蛋😏',
    ],
  ],
  [
    '抱怨',
    [
      '今天又加班到十点，打工人真的破防了',
      '地铁挤死我了，人也太多了',
      '老板又临时加需求，无语了',
      '这个天气热死了，一点都不想出门',
      '今天下班路上堵死了',
    ],
  ],
  [
    '安慰',
    [
      '今天有点难过，说不上来为什么',
      '我好像又搞砸了一件事',
      '最近老是睡不着，emo 了',
      '被领导说了一顿，有点委屈😭',
      '好想哭啊',
    ],
  ],
  [
    '吵架',
    ['你够了吧，别再说了', '你凭什么这样说我', '我真的受够了，不想跟你说了', '你再说一遍试试', '气死我了，你太过分了'],
  ],
  [
    '分享日常',
    [
      '今天终于把那本书看完了',
      '刚刚路过一家新开的奶茶店，排了好长的队',
      '周末去爬山了，风景绝绝子',
      '我家猫昨晚又半夜跑酷了',
      '刚到家，先瘫一会',
    ],
  ],
  ['内部梗', ['还记得上次那个梗吗', '又来了又来了，老规矩', '你的口头禅我都会背了', '懂的都懂，嘿嘿']],
  [
    '认真',
    [
      '我想认真问你一件事',
      '你觉得我该不该辞职',
      '说实话我最近有点迷茫，不知道未来该怎么办',
      '谢谢你听我说，这对我很重要',
      '下个月有个面试，你有什么建议吗',
    ],
  ],
];
test('the situation picker: real-style player messages land in all eight tags', () => {
  assert.deepEqual(
    TABLE.map(([tag]) => tag),
    [...SPEECH_SITUATIONS],
  );
  for (const [tag, messages] of TABLE)
    for (const message of messages) assert.equal(pickSituation(message), tag, message);
  assert.equal(pickSituation(''), '日常闲聊');
  assert.equal(pickSituation('   '), '日常闲聊');
});

test('the situation picker: a phrase the character herself said a moment ago is an 内部梗; priorities hold', () => {
  const recent = [{ authorKind: 'character', text: '本宫今天心情大好，赏你一块糖' }];
  assert.equal(pickSituation('本宫今天心情大好哈', recent), '内部梗');
  // the same words said by the PLAYER earlier are not the character's own phrase
  assert.notEqual(
    pickSituation('本宫心情大好哈哈哈', [{ authorKind: 'player', text: '本宫心情大好哈哈哈' }]),
    '内部梗',
  );
  // 吵架 beats everything; 安慰 beats 抱怨; a long message is 认真
  assert.equal(pickSituation('你够了，加班已经够烦了'), '吵架');
  assert.equal(pickSituation('加班到崩溃了，想哭'), '安慰');
  assert.equal(pickSituation('好'.repeat(60)), '认真');
});

test('every turn of the eight built-in 档案 scripts reads as its own situation (and the sets are real sets)', () => {
  assert.equal(REHEARSAL_PROFILE_SETS.length, 8);
  // NAMED EXCEPTION (Part 37c-1): the four 网络梗 sets follow the eight 档案 sets, so the profile sets are slice(3, 11).
  assert.deepEqual(REHEARSAL_SETS.slice(3, 11), [...REHEARSAL_PROFILE_SETS]);
  REHEARSAL_PROFILE_SETS.forEach((set, i) => {
    const turns = builtinSet(set);
    assert.equal(turns.length, REHEARSAL_PROFILE_TURNS, set);
    assert.equal(rehearsalTurnsMin(set), REHEARSAL_PROFILE_TURNS);
    for (const turn of turns) assert.equal(pickSituation(turn), SPEECH_SITUATIONS[i], `${set}: ${turn}`);
  });
  assert.equal(rehearsalTurnsMin('chat'), 6);
  assert.equal(rehearsalTurnsMin('opening'), 5);
});

// ---- the writer --------------------------------------------------------------------------------------------------------------

const CANON = {
  kind: 'author_canon',
  settings: {
    speechStyle: '短句，爱用叠词',
    dialogueStyle: '一次一两句',
    dialogueExamples: [
      { situation: '日常聊天', player: '在吗', reply: ['在呀'] },
      { situation: '调侃', player: '你好笨', reply: ['你才笨'] },
    ],
    interests: ['做饭'],
  },
};
const v7Request = () => {
  const base = textRequest();
  return { ...base, character: { ...base.character, authorCanon: CANON } } as TextGenerationRequest;
};
const v8Request = (over: Partial<TextGenerationRequest> = {}) => {
  const { relationship: _drop, ...rest } = v7Request();
  return { ...rest, writer: 'v8', ...over } as TextGenerationRequest;
};
const profileRequest = (over: Partial<TextGenerationRequest> = {}) => v8Request({ writerProfile: true, ...over });

test('旧 and 新 are byte-identical to what they were before Part 37b (hashes taken on main before the change)', () => {
  const v8 = v8Request();
  assert.equal(sha(promptMessages(v7Request())), '275253132d301adbf8d888c972c6dc26953ce8bedb497d0bdb5deeda2003214f');
  assert.equal(sha(writerDraftMessages(v8)), '6a2811beec7ce3e606e213050389abd9fae33e82dcc6240fe915377fd9f29d1d');
  assert.equal(
    sha(writerDraftMessages(v8, 'deepseek')),
    'd4162a33a15c86cc3650de3916c9439e4cdde85897d3778fb08eca6e531556c9',
  );
  assert.equal(
    sha(writerDraftMessages(v8, 'gemini')),
    '111393145f9040be7144a99ad9d5800534ab47cb8d81551c12914b3f72a443ca',
  );
  assert.equal(sha(writerDraftMessages(v8, 'xai')), 'dfc48dd15a139f2d5924a112437d02eec3bc7fb390541275f500b6de94103faa');
  const { relationship: _r, ...plain } = textRequest();
  assert.equal(
    sha(writerDraftMessages({ ...plain, writer: 'v8' } as TextGenerationRequest)),
    'ac3f62b6cb67ab4e5c9904ce7663a36bf29bbbd6b6e5c39d85662cde4fab0861',
  );
  assert.equal(
    sha(
      writerGuardMessages(v8, {
        mode: 'casual',
        bubbles: [{ text: 'x', expression: 'neutral' }],
        endsSession: false,
        markups: [null],
      } as never),
    ),
    '10e9f910962a1f879fd29794b61a6a9522d75792eb641cc5b19f537dd922de10',
  );
  assert.equal(writerPolicyHash('{"a":1}'), '6526ec04e3351517f5bef375077d27bf8bcbb00c4909aafbf0abdc47df66469b');
  assert.deepEqual(writerPins(), {
    protocolDigest: '698b389cae6b0a77fa3645081ae7971e502a934b3e73bbef149ccfbdb589408a',
    promptDigest: '64f475be748d641f58c04801f61fc9fe1b81679c27302a80476f0e568fddbd79',
  });
});

test('新+档案 has its own pins: the profile words and rules, and hashes that differ from 新 only for it', () => {
  assert.equal(writerProfileHash(), WRITER_PROFILE_SHA256);
  assert.notEqual(writerPolicyHash('{"a":1}', true), writerPolicyHash('{"a":1}'));
  assert.notEqual(writerPins(true).promptDigest, writerPins().promptDigest);
  assert.equal(writerPins(true).protocolDigest, writerPins().protocolDigest);
});

test('新+档案: the card sits right after the persona; the examples come after everything stable; same input, same prompt', () => {
  const request = profileRequest({
    messages: [{ ...textRequest().messages[0]!, text: '哈哈哈你这人也太会了吧' }],
  });
  const [system] = writerDraftMessages(request, 'deepseek');
  const text = system!.content;
  const card = text.indexOf('说话档案（');
  assert.ok(card > text.indexOf('只用于离线测试。') && card < text.indexOf('作者设定（JSON）'));
  assert.ok(text.includes('- 说话习惯：短句，爱用叠词') && text.includes('- 回复长短：一次一两句'));
  // the card fields and the tagged examples are not repeated in the canon JSON; the rest of the canon stays
  const canonJson = text.slice(text.indexOf('作者设定（JSON）：'));
  assert.ok(!canonJson.split('\n')[0]!.includes('speechStyle'));
  assert.ok(canonJson.split('\n')[0]!.includes('interests'));
  // the untagged old example ('日常聊天' is not one of the eight) stays in the canon: nothing is lost before it is tagged
  assert.ok(canonJson.split('\n')[0]!.includes('日常聊天'));
  assert.ok(!canonJson.split('\n')[0]!.includes('你才笨'));
  // the picked example is at the very end, after the stable prefix
  const examples = text.indexOf('你在类似场合说过的话');
  assert.ok(examples > text.indexOf('作者设定（JSON）') && examples > card);
  assert.ok(text.endsWith('玩家：你好笨\n测试角色：你才笨'));
  assert.deepEqual(writerDraftMessages(request, 'deepseek'), writerDraftMessages(request, 'deepseek'));
  // the 37a-3 addenda still work with it
  assert.ok(writerDraftMessages(request, 'gemini')[0]!.content.includes('说话档案（'));
  assert.notEqual(writerDraftMessages(request, 'gemini')[0]!.content, writerDraftMessages(request, 'xai')[0]!.content);
});

test('新+档案 with nothing to add is exactly 新 (no card, no tagged examples)', () => {
  const plain = {
    ...v8Request(),
    character: { ...v8Request().character, authorCanon: undefined },
  } as unknown as TextGenerationRequest;
  assert.deepEqual(writerDraftMessages({ ...plain, writerProfile: true }), writerDraftMessages(plain));
  // writerProfile without v8 is refused
  const { writer: _w, ...noWriter } = profileRequest();
  assert.throws(() => writerDraftMessages(noWriter as TextGenerationRequest), /WRITER_V8_REQUIRED/);
});

test('a situation with no examples falls back to 日常闲聊; with none either, nothing is added', () => {
  const bank = tpl({
    dialogueExamples: [
      { situation: '日常闲聊', player: '在吗', reply: ['在'] },
      { situation: '日常闲聊', player: '吃了吗', reply: ['吃了'] },
    ],
  });
  const fallback = pickExamples(bank, '你够了吧，别再说了');
  assert.equal(fallback.situation, '吵架');
  assert.equal(fallback.examples.length, 2);
  const none = pickExamples(tpl({ dialogueExamples: [{ situation: '调侃', player: 'a', reply: ['b'] }] }), '你够了吧');
  assert.deepEqual(none.examples, []);
  assert.deepEqual(pickExamples(tpl(null), '你好').examples, []);
  // 未分类 examples are never picked
  assert.deepEqual(
    pickExamples(tpl({ dialogueExamples: [{ situation: '随便', player: 'a', reply: ['b'] }] }), '你好').examples,
    [],
  );
});

test('2–3 examples, from the situation, in a stable order: the same message gives the same pick, no randomness', () => {
  const six = tpl({
    dialogueExamples: Array.from({ length: 6 }, (_, i) => ({
      situation: '抱怨',
      player: `玩家${i}`,
      reply: [`回复${i}`],
    })),
  });
  const a = pickExamples(six, '今天又加班到十点');
  const b = pickExamples(six, '今天又加班到十点');
  assert.deepEqual(a, b);
  assert.equal(a.examples.length, PROFILE_EXAMPLES_MAX);
  assert.equal(a.situation, '抱怨');
  // consecutive stored entries (wrapping), never random
  const starts = new Set<string>();
  for (const message of ['加班好烦', '老板又加班', '加班加班加班', '真的烦死了', '烦死了烦死了']) {
    const pick = pickExamples(six, message).examples.map((e) => e.player);
    assert.equal(new Set(pick).size, 3);
    starts.add(pick[0]!);
  }
  assert.ok(starts.size >= 2, 'the start moves with the message');
});

test('no other character’s text ever reaches a prompt: across all 15 characters', () => {
  const ids = Array.from({ length: 15 }, (_, i) => `角色${String(i).padStart(2, '0')}`);
  const templates = ids.map((id, i) => ({
    id,
    canon: {
      kind: 'author_canon',
      settings: {
        speechStyle: `${id}专属说话习惯Q${i}Q`,
        humorStyle: `${id}专属幽默Q${i}Q`,
        neverSay: `${id}专属禁语Q${i}Q`,
        dialogueStyle: `${id}专属长短Q${i}Q`,
        dialogueExamples: SPEECH_SITUATIONS.map((situation) => ({
          situation,
          player: `${id}玩家${situation}Q${i}Q`,
          reply: [`${id}回复${situation}Q${i}Q`],
        })),
      },
    },
  }));
  for (const [i, mine] of templates.entries()) {
    for (const message of TABLE.flatMap(([, list]) => list.slice(0, 2))) {
      const base = v8Request();
      const request = {
        ...base,
        writerProfile: true,
        character: { ...base.character, name: mine.id, authorCanon: mine.canon },
        messages: [{ ...base.messages[0]!, text: message }],
      } as TextGenerationRequest;
      for (const provider of [undefined, 'deepseek', 'gemini', 'xai'] as const) {
        const [system, user] = writerDraftMessages(request, provider);
        const all = `${system!.content}\n${user!.content}`;
        assert.ok(all.includes(`专属说话习惯Q${i}Q`));
        for (const [j, other] of templates.entries()) {
          if (j === i) continue;
          assert.ok(!all.includes(`Q${j}Q`), `${mine.id} prompt holds a mark of ${other.id}`);
          assert.ok(!all.includes(other.id), `${mine.id} prompt names ${other.id}`);
        }
      }
    }
  }
});

test('the extra input of 新+档案 per reply is small and bounded (typical and maximum)', () => {
  const total = (request: TextGenerationRequest) => [...writerDraftMessages(request, 'deepseek')[0]!.content].length;
  const base = v8Request();
  const sized = (authorCanon: unknown, text = '今天又加班到十点') =>
    ({
      ...base,
      character: { ...base.character, authorCanon },
      messages: [{ ...base.messages[0]!, text }],
    }) as TextGenerationRequest;
  // The maximum block: four card fields of 300 characters, and three examples of the longest size (120 + 2 × 120).
  const full = Object.fromEntries(CORE_FIELDS.map((field) => [CORE_FIELD_KEYS[field], '字'.repeat(CORE_FIELD_MAX)]));
  const longExample = { situation: '抱怨', player: '玩'.repeat(120), reply: ['回'.repeat(120), '复'.repeat(120)] };
  const maxCanon = {
    kind: 'author_canon',
    settings: { ...full, dialogueExamples: [longExample, longExample, longExample] },
  };
  const withP = total({ ...sized(maxCanon), writerProfile: true });
  const withoutP = total(sized(maxCanon));
  // 新 prints every stored example and the card fields in the canon JSON; 新+档案 moves them (the card to the front, the picked
  // examples to the end), so on the SAME draft it adds only its headings and line labels.
  assert.ok(withP - withoutP < 400, `same draft, extra characters: ${withP - withoutP}`);
  // The block itself (what an owner adds by filling the card and the bank): at most ~2,500 characters, about 1,800 tokens.
  const block = (request: TextGenerationRequest) =>
    [...writerDraftMessages(request, 'deepseek')[0]!.content].length -
    [
      ...writerDraftMessages(
        {
          ...request,
          writerProfile: undefined,
          character: { ...request.character, authorCanon: undefined },
        } as unknown as TextGenerationRequest,
        'deepseek',
      )[0]!.content,
    ].length;
  const maxBlock = block({ ...sized(maxCanon), writerProfile: true });
  assert.ok(maxBlock > 0 && maxBlock < 2600, `max block characters: ${maxBlock}`);
  const typicalBlock = block({ ...sized(CANON, '你好笨哈哈你这人'), writerProfile: true });
  assert.ok(typicalBlock > 0 && typicalBlock < 700, `typical block characters: ${typicalBlock}`);
  // A big bank only gets cheaper: 48 stored examples are not all printed any more.
  const bank = SPEECH_SITUATIONS.flatMap((situation) =>
    Array.from({ length: 6 }, () => ({ ...longExample, situation })),
  );
  const bigCanon = { kind: 'author_canon', settings: { dialogueExamples: bank } };
  assert.ok(total({ ...sized(bigCanon), writerProfile: true }) < total(sized(bigCanon)));
});

// ---- rehearsal columns -------------------------------------------------------------------------------------------------------

test('新+档案 is a column like 新: its key, its label, its parse; 旧 and 新 keys are unchanged', () => {
  assert.equal(rehearsalColumnKey('deepseek', 'v7'), 'deepseek');
  assert.equal(rehearsalColumnKey('deepseek', 'v8'), 'deepseek-v8');
  assert.equal(rehearsalColumnKey('deepseek', 'v8', true), 'deepseek-v8p');
  // NAMED EXCEPTION (Part 37c-1): a parsed column also says whether it is 新+档案+梗 (`memes`); false for these three, as every field they had is unchanged.
  assert.deepEqual(parseRehearsalColumn('deepseek-v8p'), {
    model: 'deepseek',
    writer: 'v8',
    profile: true,
    memes: false,
  });
  assert.deepEqual(parseRehearsalColumn('xai-v8'), { model: 'xai', writer: 'v8', profile: false, memes: false });
  assert.deepEqual(parseRehearsalColumn('gemini'), { model: 'gemini', writer: 'v7', profile: false, memes: false });
  assert.equal(parseRehearsalColumn('deepseek-v9'), null);
  assert.equal(
    rehearsalColumnLabel('deepseek-v8p'),
    'DeepSeek·新+档案'.replace('DeepSeek', rehearsalColumnLabel('deepseek').split('·')[0]!),
  );
  assert.ok(isRehearsalModels(['deepseek', 'deepseek-v8', 'deepseek-v8p']));
});

test('a 新+档案 column freezes writerProfile into its request (and only it); 旧 and 新 requests gain no key', () => {
  const frozen = { template: v8Request().character, baseAt: Date.parse('2026-09-09T12:00:00+08:00') } as never;
  const plain = rehearsalRequest(frozen, 'run', 'deepseek', 1, ['在吗'], []);
  const fresh = rehearsalRequest(frozen, 'run', 'deepseek-v8', 1, ['在吗'], []);
  const profile = rehearsalRequest(frozen, 'run', 'deepseek-v8p', 1, ['你够了吧'], []);
  assert.equal(plain.writer, undefined);
  assert.equal(plain.writerProfile, undefined);
  assert.equal(fresh.writer, 'v8');
  assert.ok(!('writerProfile' in fresh));
  assert.equal(profile.writer, 'v8');
  assert.equal(profile.writerProfile, true);
  assert.ok(!('relationship' in profile));
  // the prompt it makes holds this character's card and, for a 吵架 message with no 吵架 sample, nothing from another situation
  const [system] = writerDraftMessages(profile, 'deepseek');
  assert.ok(system!.content.includes('- 说话习惯：短句，爱用叠词'));
  assert.ok(!system!.content.includes('你才笨'));
});

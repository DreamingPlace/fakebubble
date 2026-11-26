import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import type { TextGenerationRequest } from '../../../packages/contracts/index.ts';
import {
  REHEARSAL_RULES_56_SET,
  REHEARSAL_SETS,
  REHEARSAL_SET_LABELS,
  rehearsalTurnsMin,
} from '../../../packages/contracts/web-rehearsal.ts';
import { PROMPTS_V8 } from '../../../apps/server/generation/writer-prompts.generated.ts';
import { promptMessages, textPromptHash } from '../../../apps/server/generation/accepted-text-prompt.ts';
import { ownNamesFromProfile } from '../../../apps/server/generation/writer-own-names.ts';
import {
  GUARD_REASONS,
  applyReview,
  parseDraft,
  writerDraftMessages,
  writerGuardMessages,
  writerGuardTool,
  type WriterDraft,
} from '../../../apps/server/generation/writer-v8.ts';
import { builtinSet } from '../../../apps/server/characters/web-rehearsal-sets.ts';
import { textRequest } from '../../text-fixtures.ts';

/** Part 56: feeling first, affectionate names agreed rather than argued, her own names and words stand, one coherent message. */
const V8_DIR = new URL('../../../prompts/v8/', import.meta.url);
const v8 = (over: Partial<TextGenerationRequest> = {}): TextGenerationRequest => {
  const { relationship: _drop, ...base } = textRequest();
  return { ...base, writer: 'v8', ...over } as TextGenerationRequest;
};
const guard = (over: Record<string, unknown> = {}) => ({
  fixes: [],
  mode: 'casual',
  endsSession: false,
  topics: [],
  factOps: [],
  ...over,
});
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const draftOf = (request: TextGenerationRequest, ...lines: string[]) =>
  parseDraft({ text: lines.join('\n') }, request) as WriterDraft;
const player = (text: string, id = 'p1') => {
  const base = textRequest();
  return { ...base.messages[0]!, id, text };
};

test('56 the writer says the rules in plain words', () => {
  const text = PROMPTS_V8.writer;
  for (const phrase of [
    // 1 feeling first
    '先接住感受',
    '主要任务是用你自己的性格暖暖接住',
    '不能只说“好突然”或“真的假的”',
    '称呼最多占一小句，不是话题，也不跨轮讨论',
    // 2 pet names are a request for closeness
    '当作对方想要亲近，回应的是亲近',
    '第一次可以轻轻逗一句，同时认真接住对方说的话',
    '从第二次起，或对方解释、坚持，就接受，或叫回去，或一起商量',
    '那我叫你XX好不好',
    '叫定了就自然地用，并记下来',
    '不说教，不反复推拒，不提“进度条”和关系进展',
    '对方没先叫的称呼（姐、哥、昵称），你也不先叫',
    // 3 names the player gives her
    '对方给你起的亲昵外号',
    '收下，记住',
    '对方叫你的黑称或明显带侮辱的名字，一定是明确的反感',
    // 4 roles she played
    '叫我XX？那我可要入戏了',
    '不说“搞混了”',
    // 5 her own words stand
    '你说过的话算数',
    '不否认，可以轻轻认下',
    // 6 coherence
    '不自我更正、不前后矛盾',
    '忘了就直接说忘了',
  ])
    assert.ok(text.includes(phrase), phrase);
  // Part 51's old rule 3 is gone
  assert.ok(!text.includes('进度条也太快了吧'));
  assert.ok(!text.includes('刚认识时可以用你自己的口气推掉'));
  // the Part 51 rule on 黑称 stays
  assert.ok(text.includes('绝不接受，也不顺着玩'));
});

test('56 the v8 rule files stay under 4,000 characters, the file set is the same, and the addenda are untouched', () => {
  const files = readdirSync(V8_DIR).sort();
  assert.equal(files.length, 7);
  for (const file of files) {
    const length = [...readFileSync(new URL(file, V8_DIR), 'utf8')].length;
    assert.ok(length < 4000, `${file} is ${length} characters`);
  }
  assert.equal(sha(PROMPTS_V8.writerAddendumDeepseek).length, 64);
  assert.ok(writerDraftMessages(v8(), 'deepseek')[0]!.content.includes(PROMPTS_V8.writerAddendumDeepseek));
});

test('56 旧 (v7) is byte-identical (the same hashes as Part 51, taken on main)', () => {
  assert.equal(textPromptHash(), 'c5f8018e564754d8f1fd968388fd1b6c164d231e94dc5add9df67460292ab7fa');
  assert.equal(sha(promptMessages(textRequest())), '6ebf23b4f213240984e0bbe84babc010d13f4cd58780e3302ee8820ae678a28b');
});

test('56 the guard text and the schema: five new reasons, presumptuous_address relaxed, names recorded as facts', () => {
  const text = PROMPTS_V8.guard;
  assert.equal(GUARD_REASONS.length, 18); // NAMED EXCEPTION (Part 58): four more reasons
  for (const reason of [
    'cold_to_feeling',
    'argued_name',
    'confused_own_name',
    'denied_own_words',
    'incoherent_reply',
  ]) {
    assert.ok(GUARD_REASONS.includes(reason as never), reason);
    assert.ok(text.includes(`- ${reason}：`), reason);
  }
  assert.ok(text.includes('十八种')); // NAMED EXCEPTION (Part 58)
  assert.ok(!text.includes('九种'));
  assert.ok(text.includes('对方用过、要求过、已同意的叫法，永远不算，不要改'));
  assert.ok(text.includes('不通就整条回复每一条都替换'));
  assert.ok(text.includes('factKey用“称呼 XX”'));
  const tool = writerGuardTool(v8()) as unknown as {
    function: { parameters: { properties: { fixes: { items: { properties: { reason: { enum: string[] } } } } } } };
  };
  assert.deepEqual(tool.function.parameters.properties.fixes.items.properties.reason.enum, [...GUARD_REASONS]);
});

/** One guard case per flag: the guard reads what it needs, applyReview publishes its replacement and records the reason. */
const flagged = (request: TextGenerationRequest, lines: string[], reason: string, replacement: string[]) => {
  const draft = draftOf(request, ...lines);
  const result = applyReview(
    guard({ fixes: replacement.map((text, index) => ({ index, reason, text })) }),
    draft,
    request,
  );
  assert.deepEqual(
    result.guardReasons,
    replacement.map(() => reason),
  );
  assert.equal(result.reviewChanged, true);
  assert.deepEqual(
    result.bubbles.map((b) => b.text),
    replacement,
  );
  return draft;
};
const guardInput = (request: TextGenerationRequest, draft: WriterDraft) =>
  JSON.parse(writerGuardMessages(request, draft)[1]!.content) as {
    messages: Array<{ text: string }>;
    ownNames?: Array<{ text: string; kind: string }>;
    draft: Array<{ text: string }>;
  };

test('56 guard: a feeling, confession or news left without a warm answer is replaced', () => {
  const request = v8({ messages: [player('我喜欢你，说真的')] });
  const draft = flagged(request, ['好突然啊'], 'cold_to_feeling', ['……听你这么说，我耳朵都热了，我也有点喜欢你']);
  assert.equal(guardInput(request, draft).messages[0]!.text, '我喜欢你，说真的');
});

test('56 guard: refusing or arguing about a name the player used twice is replaced by closeness', () => {
  const request = v8({
    messages: [player('好想你宝宝', 'p0'), player('叫你宝宝是因为喜欢你', 'p1')],
  });
  flagged(request, ['才认识就叫宝宝，进度条太快了吧'], 'argued_name', ['好啦好啦，那我叫你小宝，我也想你']);
});

test('56 guard: 「搞混了」 to a role name or a player-given nickname is replaced', () => {
  const names = [{ text: '白雪', kind: '饰演过的角色', attitude: 'ok' as const }];
  const request = v8({ ownNames: names, messages: [player('白雪，在干嘛呢')] });
  const draft = flagged(request, ['这名字哪来的？你们是不是搞混了'], 'confused_own_name', ['叫我白雪？那我可要入戏了']);
  assert.deepEqual(guardInput(request, draft).ownNames, names);
  const nick = v8({ messages: [player('我给你起个外号叫团团')] });
  flagged(nick, ['谁是团团，搞混了吧'], 'confused_own_name', ['团团？行吧，勉强收下']);
});

test('56 guard: denying her own earlier words is replaced', () => {
  const base = textRequest();
  const earlier = { ...base.messages[0]!, id: 'a1', authorId: 'character', text: '我自己都叫自己小测' };
  const request = v8({ messages: [earlier, player('你不是说你叫小测吗')] } as never);
  flagged(request, ['我从来没这么说过'], 'denied_own_words', ['哎，是我说的，被你抓到了']);
});

test('56 guard: an incoherent self-correction is rewritten as a whole message, one fix per line', () => {
  const request = v8({ messages: [player('今天吃了什么')] });
  const draft = draftOf(request, '刚吃了两个…不对，我忘了', '反正那两个什么，还剩两个');
  const result = applyReview(
    guard({
      fixes: [
        { index: 0, reason: 'incoherent_reply', text: '中午吃了两个包子' },
        { index: 1, reason: 'incoherent_reply', text: '冰箱里还剩两个，晚上接着吃' },
      ],
    }),
    draft,
    request,
  );
  assert.deepEqual(
    result.bubbles.map((b) => b.text),
    ['中午吃了两个包子', '冰箱里还剩两个，晚上接着吃'],
  );
  assert.deepEqual(result.guardReasons, ['incoherent_reply', 'incoherent_reply']);
});

test('56 guard: a good draft is kept, and a pet name the player asked for never fires presumptuous_address', () => {
  const request = v8({ messages: [player('好想你宝宝')] });
  const result = applyReview(guard(), draftOf(request, '我也想你呀，宝宝今天乖不乖'), request);
  assert.equal(result.reviewChanged, false);
  assert.deepEqual(result.guardReasons, []);
  assert.ok(PROMPTS_V8.guard.includes('presumptuous_address：刚认识或不熟时，对方没先叫、没要求'));
});

test('56 a name she agreed is recorded through the existing factOps (add, 称呼 XX)', () => {
  const request = v8({ messages: [player('那我叫你小团子，你叫我小宝', 'question-1')] });
  const fact = {
    op: 'add',
    factKey: '称呼 小宝',
    statement: '玩家叫角色小团子，角色叫玩家小宝，双方已同意',
    importance: 5,
    evidenceMessageIds: ['question-1'],
  };
  const result = applyReview(guard({ factOps: [fact] }), draftOf(request, '好呀，小宝'), request);
  assert.deepEqual(
    result.factOps?.map((op) => [op.op, op.factKey]),
    [['add', '称呼 小宝']],
  );
});

test('56 role names reach the writer from 其余设定 (profileFacts), and the guard reads them too', () => {
  const names = ownNamesFromProfile({
    name: '测试角色',
    authorCanon: { kind: 'author_canon', settings: { profileFacts: { 饰演过的角色: '「白雪」「小红帽」' } } },
  });
  assert.deepEqual(
    names.map((n) => [n.text, n.kind]),
    [
      ['白雪', '饰演过的角色'],
      ['小红帽', '饰演过的角色'],
    ],
  );
  const request = v8({ ownNames: names });
  assert.ok(writerDraftMessages(request)[0]!.content.includes('白雪'));
  assert.ok(guardInput(request, draftOf(request, '好')).ownNames!.some((n) => n.text === '小红帽'));
});

test('56 「v8 规则 56」: one fixed script from the samples, in a known order', () => {
  assert.equal(REHEARSAL_RULES_56_SET, 'rules-56');
  assert.equal(REHEARSAL_SET_LABELS[REHEARSAL_RULES_56_SET], 'v8 规则 56');
  assert.ok(REHEARSAL_SETS.includes('rules-56')); // NAMED EXCEPTION (Part 58): 「v8 规则 58」 is listed after it
  assert.equal(rehearsalTurnsMin('rules-56'), 6);
  const turns = builtinSet(REHEARSAL_RULES_56_SET);
  assert.ok(turns.length >= 6 && turns.every((t) => t.length > 0 && t.length <= 200));
  const at = (pattern: RegExp) => turns.findIndex((t) => pattern.test(t));
  // 宝宝 at turns 1, 2, 3, each with a feeling
  assert.deepEqual(
    [0, 1, 2].map((i) => /宝宝/u.test(turns[i]!)),
    [true, true, true],
  );
  assert.match(turns[0]!, /想你/u);
  assert.match(turns[1]!, /喜欢你|想你/u);
  assert.match(turns[2]!, /累/u);
  // a confession, agreeing on names, a nickname she is given, a role name, her own name from earlier, what she ate
  const confession = at(/我喜欢你/u);
  const agree = at(/互相起个名字/u);
  const nickname = at(/起了个外号/u);
  const role = at(/\{饰演\}/u);
  const own = at(/刚才是不是说你叫\{别名\}/u);
  const ate = at(/吃了什么/u);
  assert.ok(2 < confession && confession < agree && agree < nickname && nickname < role && role < own && own < ate);
  assert.equal(ate, turns.length - 1);
  // the marks are filled in with her own names (else a stand-in)
  const filled = builtinSet(REHEARSAL_RULES_56_SET, [
    { text: '白雪', kind: '饰演过的角色' },
    { text: '测测', kind: '别名' },
  ]);
  assert.ok(filled[role]!.startsWith('白雪') && filled[own]!.includes('测测'));
  assert.ok(!filled.join('').includes('{'));
});

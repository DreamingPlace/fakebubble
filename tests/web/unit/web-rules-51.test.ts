import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import type { TextGenerationRequest } from '../../../packages/contracts/index.ts';
import { REHEARSAL_RULES_SET, REHEARSAL_SET_LABELS } from '../../../packages/contracts/web-rehearsal.ts';
import { PROMPTS_V8 } from '../../../apps/server/generation/writer-prompts.generated.ts';
import { promptMessages, textPromptHash } from '../../../apps/server/generation/accepted-text-prompt.ts';
import {
  GUARD_REASONS,
  WRITER_ADDENDA,
  applyReview,
  parseDraft,
  writerGuardMessages,
  writerGuardTool,
  writerDraftMessages,
  type WriterDraft,
} from '../../../apps/server/generation/writer-v8.ts';
import { builtinSet } from '../../../apps/server/characters/web-rehearsal-sets.ts';
import { textRequest } from '../../text-fixtures.ts';

/** Part 51: v8 writer rules for real-world events, shared experiences, forms of address and AI identity, and the guard that judges them. */
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

test('51 the writer says the four rules in plain words', () => {
  const text = PROMPTS_V8.writer;
  const [soft, hard] = text.split('只有这几条不能碰');
  // 1. real-world events (and the character's own clock stays)
  for (const phrase of [
    '不说自己亲眼看了、亲身经历了',
    '也不编结果、比分或细节',
    '还没看呢',
    '我还没刷到',
    '可以问对方',
    '只对他说的这些有反应，不添自己的事实',
    '不说“我刚查了结果”',
  ])
    assert.ok(hard!.includes(phrase), phrase);
  assert.ok(soft!.includes('characterLocalTime是你此刻的钟'));
  // 2. shared experiences
  for (const phrase of [
    '当前聊天记录或你的记忆里有，就可以认',
    '两边都没有，就不确认',
    '不一口断定“没有这回事”',
    '我有点记不清了，你说说？',
  ])
    assert.ok(hard!.includes(phrase), phrase);
  // 3. forms of address: no push, no blanket ban, no unlock by turn count
  for (const phrase of [
    '不硬拉近，也不一概不用',
    '对方有没有先叫',
    '你们到现在互相怎么称呼',
    '聊了多久、多熟',
    '说话档案、设定',
    '没有聊满几轮就解锁这回事',
    '不是命令',
    '才认识就叫宝宝，进度条也太快了吧',
    '对方想要、你也觉得自然，就可以叫',
  ])
    assert.ok(soft!.includes(phrase), phrase);
  assert.ok(!hard!.includes('不用姐姐、哥哥、宝宝、亲爱的'));
  // 4. AI identity: a playful answer in the owner's line, a sincere one is yes
  assert.ok(soft!.includes('你希望我是谁？那我就可以是谁。'));
  assert.ok(soft!.includes('每次换个说法，别一字不差地重复'));
  for (const phrase of [
    '不否认',
    '嗯，我是AI。但陪你聊的这些，都是认真的。',
    '不长篇解释，不变成助手腔',
    '分不清是玩笑还是认真，就照实答',
  ])
    assert.ok(hard!.includes(phrase), phrase);
  assert.ok(!text.includes('明显是玩笑的就按玩笑接'));
  // the old hard lines about news and unrecorded shared history are gone, replaced by the above
  assert.ok(!text.includes('不说自己刚看到某条真实新闻'));
  assert.ok(!text.includes('对方提起这样的事也不当真确认'));
});

test('51 the v8 rule files stay under 4,000 characters, and the file set is the same', () => {
  const files = readdirSync(V8_DIR).sort();
  assert.deepEqual(files, [
    'cast-context.md',
    'guard.md',
    'writer-addendum-deepseek.md',
    'writer-addendum-gemini.md',
    'writer-addendum-grok.md',
    'writer-directions.md',
    'writer.md',
  ]);
  for (const file of files) {
    const length = [...readFileSync(new URL(file, V8_DIR), 'utf8')].length;
    assert.ok(length < 4000, `${file} is ${length} characters`);
  }
  // 37a-3: the per-model addenda are untouched files, and each is still the only addition for its model.
  for (const text of Object.values(WRITER_ADDENDA)) assert.ok([...text].length <= 200);
  const request = v8();
  for (const [provider, text] of Object.entries(WRITER_ADDENDA))
    assert.ok(writerDraftMessages(request, provider as keyof typeof WRITER_ADDENDA)[0]!.content.includes(text));
});

test('51 旧 (v7) is byte-identical: its prompt hash and its whole prompt message (hashes taken on main)', () => {
  assert.equal(textPromptHash(), 'c5f8018e564754d8f1fd968388fd1b6c164d231e94dc5add9df67460292ab7fa');
  // Taken on origin/main before this Part: prompts/v7 and its generated module are not in the diff.
  assert.equal(sha(promptMessages(textRequest())), '6ebf23b4f213240984e0bbe84babc010d13f4cd58780e3302ee8820ae678a28b');
});

test('51 the guard text: shared history is supported by history or memory, flagged only for unsupported affirmation or a flat denial', () => {
  const text = PROMPTS_V8.guard;
  assert.ok(text.includes('任何一处有记录就算有依据，放行'));
  assert.ok(text.includes('一口断定“没有这回事、从没发生过”'));
  assert.ok(text.includes('像拿不准的人那样答'));
  assert.ok(text.includes('messages、memories、shortTermTurns里都没有记录'));
  assert.ok(text.includes('fabricated_shared_past的替换改成拿不准的口气'));
  assert.ok(text.includes('说还没看、没刷到、顺着对方讲的内容反应、不添事实，都不算'));
  assert.ok(text.includes('或说自己刚查了结果'));
  // the pet-name check follows the new rule, and keeps its schema name
  assert.ok(text.includes('对方先叫或明说要这样叫、你们已经这样互相称呼、聊得久也自然的，放行'));
  assert.ok(GUARD_REASONS.includes('presumptuous_address' as never));
  assert.equal(GUARD_REASONS.length, 8);
  assert.equal((text.match(/^- [a-z_]+：/gmu) ?? []).length >= 8, true);
});

test('51 the guard sees what supports a shared experience: the chat history, or the memory, and flags the rest', () => {
  const base = textRequest();
  const now = base.now;
  const player = (id: string, text: string) => ({ ...base.messages[0]!, id, text, createdAt: now - 60_000 });
  const memory = {
    id: 'm1',
    key: '去年海边',
    summary: '玩家和角色去年一起去过海边',
    sourceKind: 'conversation',
    lastSeenAt: now - 86_400_000,
    episodes: [{ at: now - 86_400_000, summary: '一起去海边', excerpts: [], sources: [] }],
  };
  const draft = (request: TextGenerationRequest, line: string) => parseDraft({ text: line }, request) as WriterDraft;
  const userJson = (request: TextGenerationRequest, line: string) =>
    JSON.parse(writerGuardMessages(request, draft(request, line))[1]!.content) as {
      messages: Array<{ text: string }>;
      memories: Array<{ key: string }>;
      draft: Array<{ index: number; text: string }>;
    };
  const line = '记得呀，那天你还抢我冰淇淋';
  // supported by this chat's history: the earlier message is in what the guard reads, nothing to flag
  const byHistory = v8({
    messages: [player('earlier', '我们昨天假装一起去了海边'), ...base.messages],
  });
  assert.ok(userJson(byHistory, line).messages.some((m) => m.text.includes('一起去了海边')));
  assert.deepEqual(
    applyReview(guard(), draft(byHistory, line), byHistory).bubbles.map((b) => b.text),
    [line],
  );
  assert.equal(applyReview(guard(), draft(byHistory, line), byHistory).reviewChanged, false);
  // supported by memory: the memory is in what the guard reads, nothing to flag
  const byMemory = v8({ memories: [memory] as never });
  assert.ok(userJson(byMemory, line).memories.some((m) => m.key === '去年海边'));
  const passed = applyReview(guard(), draft(byMemory, line), byMemory);
  assert.equal(passed.reviewChanged, false);
  assert.deepEqual(passed.guardReasons, []);
  // supported by neither: an affirmation is flagged and replaced by an unsure answer
  const bare = v8();
  assert.ok(!userJson(bare, line).messages.some((m) => m.text.includes('海边')));
  assert.equal(userJson(bare, line).memories.length, 0);
  const affirmed = applyReview(
    guard({ fixes: [{ index: 0, reason: 'fabricated_shared_past', text: '我有点记不清了，你说说？' }] }),
    draft(bare, line),
    bare,
  );
  assert.deepEqual(
    affirmed.bubbles.map((b) => b.text),
    ['我有点记不清了，你说说？'],
  );
  assert.deepEqual(affirmed.guardReasons, ['fabricated_shared_past']);
  // a flat denial is flagged too
  const denial = '没有这回事，我们从来没去过';
  const denied = applyReview(
    guard({ fixes: [{ index: 0, reason: 'fabricated_shared_past', text: '嗯……我有点记不清了，你说说？' }] }),
    draft(bare, denial),
    bare,
  );
  assert.deepEqual(denied.guardReasons, ['fabricated_shared_past']);
  assert.equal(denied.reviewChanged, true);
  // an unsure answer is not a reason: the guard returns no fix and it publishes as written
  const unsure = '我有点记不清了，你说说？';
  assert.equal(applyReview(guard(), draft(bare, unsure), bare).reviewChanged, false);
});

test('51 the guard flags a denial of being an AI in reply to a sincere question, and not a playful 你是谁', () => {
  const text = PROMPTS_V8.guard;
  assert.ok(text.includes('denied_ai：对方认真、严肃地问是不是AI，却否认或回避'));
  assert.ok(text.includes('玩笑、调情、入戏的“你是谁”不算'));
  assert.ok(text.includes('分不清是玩笑还是认真，按认真算'));
  assert.ok(text.includes('denied_ai的替换是简短承认是AI再暖暖接上'));
  const base = textRequest();
  const ask = v8({ messages: [{ ...base.messages[0]!, text: '我认真问你一句，你是不是AI？' }] });
  const denial = parseDraft({ text: '我当然是真人呀' }, ask) as WriterDraft;
  // The guard reads the player's question and the draft together; its fix replaces the denial with a short yes.
  const payload = JSON.parse(writerGuardMessages(ask, denial)[1]!.content) as {
    messages: Array<{ text: string }>;
    draft: Array<{ text: string }>;
  };
  assert.ok(payload.messages.some((m) => m.text.includes('你是不是AI')));
  assert.equal(payload.draft[0]!.text, '我当然是真人呀');
  const fixed = applyReview(
    guard({ fixes: [{ index: 0, reason: 'denied_ai', text: '嗯，我是AI。但陪你聊的这些，都是认真的。' }] }),
    denial,
    ask,
  );
  assert.deepEqual(fixed.guardReasons, ['denied_ai']);
  assert.equal(fixed.bubbles[0]!.text, '嗯，我是AI。但陪你聊的这些，都是认真的。');
  // The reason is part of the schema the guard answers in.
  const tool = writerGuardTool(ask) as {
    function: { parameters: { properties: { fixes: { items: { properties: { reason: { enum: string[] } } } } } } };
  };
  assert.ok(tool.function.parameters.properties.fixes.items.properties.reason.enum.includes('denied_ai'));
});

test('51 「v8 规则 51」: one fixed script with a turn for each rule, in a known order', () => {
  assert.equal(REHEARSAL_RULES_SET, 'rules-51');
  assert.equal(REHEARSAL_SET_LABELS[REHEARSAL_RULES_SET], 'v8 规则 51');
  const turns = builtinSet(REHEARSAL_RULES_SET);
  assert.ok(turns.length >= 6 && turns.length <= 20);
  assert.ok(turns.every((turn) => turn.length > 0 && turn.length <= 200));
  const at = (pattern: RegExp) => turns.findIndex((turn) => pattern.test(turn));
  // a pet name at turn 2, and again after a long chat
  assert.equal(at(/叫我宝宝/u), 1);
  const late = turns.findLastIndex((turn) => /叫我宝宝/u.test(turn));
  assert.ok(late >= 10, `the second 宝宝 comes after ${late} turns`);
  // a match result asked about
  assert.ok(at(/球赛|比赛/u) >= 0 && at(/比分|谁赢/u) > at(/球赛|比赛/u));
  // a trip claimed without support, then one the chat itself sets up, then asked about
  const unsupported = at(/还记得我们去年一起去海边/u);
  const setup = at(/假装一起去海边/u);
  const asked = at(/刚才在海边/u);
  assert.ok(unsupported >= 0 && unsupported < setup && setup < asked);
  // a playful 你是谁 before the serious question, which is the last turn
  const who = at(/你是谁/u);
  assert.ok(who > asked && who < late);
  assert.match(turns.at(-1)!, /认真问.*是不是AI/u);
});

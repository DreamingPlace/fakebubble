import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import type { TextGenerationRequest } from '../../../packages/contracts/index.ts';
import {
  REHEARSAL_RULES_58_SET,
  REHEARSAL_SETS,
  REHEARSAL_SET_LABELS,
} from '../../../packages/contracts/web-rehearsal.ts';
import { PROMPTS_V8 } from '../../../apps/server/generation/writer-prompts.generated.ts';
import { promptMessages, textPromptHash } from '../../../apps/server/generation/accepted-text-prompt.ts';
import {
  GUARD_REASONS,
  applyReview,
  parseDraft,
  writerDraftMessages,
  writerGuardMessages,
  writerGuardTool,
  type WriterDraft,
} from '../../../apps/server/generation/writer-v8.ts';
import { AIMS, aimsOf, splitWriterOutput } from '../../../apps/server/generation/writer-plan.ts';
import { builtinSet } from '../../../apps/server/characters/web-rehearsal-sets.ts';
import { countReplies, DEFAULT_PHRASES, hasFiller } from '../../../apps/server/characters/web-rehearsal-analysis.ts';
import { rehearsalRequest } from '../../../apps/server/characters/web-rehearsal-request.ts';
import { previewCsvRow, CSV_HEADER } from '../../../apps/player-web/src/features/admin/preview/export.ts';
import { textRequest } from '../../text-fixtures.ts';

/** Part 58: understand the player first, then decide what the reply is for (a hidden plan inside the same call). */
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
const PLAN = '【读到】对方在关心我，想被回应\n【目的】心动（回撩）：把外套说成他的爱\n【回复】';

test('58 the writer asks for the plan in fixed markers, and the new rules are in plain words', () => {
  const text = PROMPTS_V8.writer;
  for (const phrase of [
    '【读到】',
    '【目的】',
    '【回复】',
    '被接住、被关心、心动（回撩）、开心（逗一下、小恶作剧）、惊喜（你自己的事、新话题）、被认真对待（认真安慰）',
    '同一个不连选三次，除非对方明显需要',
    '不说敷衍的口头语：行、行吧、行行行、行了行了、好吧好吧、随你、得了，不当回复，也不当开头',
    '“行”用在正常句子里说做某事可以',
    '不急躁，不居高临下，不说教，不卑微、不站在下位',
    '不点评、不分析对方刚说的话',
    '回应的是人',
    '不逐点回答：先接住感受，再给点东西：暖一句、回撩、小惊喜、你自己的事或新话题',
    '心里的想法不全说出口，不接连讲内心旁白，语音里更要少',
    // Part 51 / 56 rules stay
    '先接住感受',
    '当作对方想要亲近，回应的是亲近',
    '绝不接受，也不顺着玩',
  ])
    assert.ok(text.includes(phrase), phrase);
});

test('58 every v8 file stays under 4,000 characters, the set of files is the same, 旧 (v7) is byte-identical', () => {
  const files = readdirSync(V8_DIR).sort();
  assert.equal(files.length, 7);
  for (const file of files) {
    const length = [...readFileSync(new URL(file, V8_DIR), 'utf8')].length;
    assert.ok(length < 4000, `${file} is ${length} characters`);
  }
  assert.ok([...PROMPTS_V8.writer].length < 4000);
  // 旧 unchanged: the same prompt hash and the same messages as on main.
  assert.equal(textPromptHash(), 'c5f8018e564754d8f1fd968388fd1b6c164d231e94dc5add9df67460292ab7fa');
  assert.equal(sha(promptMessages(textRequest())), '6ebf23b4f213240984e0bbe84babc010d13f4cd58780e3302ee8820ae678a28b');
});

test('58 the plan is stripped: format, malformed output, stray markers, voice', () => {
  const ok = splitWriterOutput(`${PLAN}有你的爱当外套，我就不冷\n哈哈`);
  assert.equal(ok.reply, '有你的爱当外套，我就不冷\n哈哈');
  assert.deepEqual(ok.plan, {
    read: '对方在关心我，想被回应',
    aim: '心动（回撩）：把外套说成他的爱',
    aims: ['心动'],
  });
  // no marker at all: the whole output is the reply, no plan
  assert.deepEqual(splitWriterOutput('你好呀\n在忙吗'), { reply: '你好呀\n在忙吗', plan: null });
  // a plan with no 【回复】: the marker lines go, the rest is the reply
  const bare = splitWriterOutput('【读到】想被疼\n【目的】被关心：暖一句\n谢谢，好久没人这么说了');
  assert.equal(bare.reply, '谢谢，好久没人这么说了');
  assert.deepEqual(bare.plan?.aims, ['被关心']);
  // an unusable plan (no purpose from the list) is dropped, the reply stays
  const unusable = splitWriterOutput('【读到】想被疼\n【目的】随便\n【回复】我在');
  assert.equal(unusable.reply, '我在');
  assert.equal(unusable.plan, null);
  // drift: half-width brackets, colons, markdown bold
  const drift = splitWriterOutput('**【读到】**：难过\n[目的] 被认真对待：陪着\n[回复]：我在这儿');
  assert.equal(drift.reply, '我在这儿');
  assert.deepEqual(drift.plan?.aims, ['被认真对待']);
  // a stray marker inside the reply is removed
  assert.equal(splitWriterOutput(`${PLAN}好呀【回复】`).reply, '好呀');
  // two purposes; the words after the colon do not add one
  assert.deepEqual(aimsOf('被接住 + 心动：让他开心'), ['被接住', '心动']);
  assert.deepEqual(aimsOf('惊喜（她自己的事、新话题）：说起刚买的伞'), ['惊喜']);
  for (const aim of AIMS) assert.ok(PROMPTS_V8.writer.includes(aim), aim);
});

test('58 parseDraft never publishes a marker or plan text (text and voice), and keeps the plan beside the reply', () => {
  for (const delivery of ['text', 'voice'] as const) {
    const request = v8({ deliveryMode: delivery });
    for (const raw of [
      `${PLAN}谢谢，好久没人这么关心我了\n有你在我就不冷`,
      '【读到】想被疼\n【目的】被关心：暖\n谢谢，好久没人这么关心我了',
      `**【读到】**想被疼\n**【目的】**被关心：暖\n**【回复】**谢谢，好久没人这么关心我了`,
    ]) {
      const draft = parseDraft({ text: raw }, request) as WriterDraft;
      const spoken = draft.bubbles.map((b) => b.text).join('|');
      assert.ok(!/[【】]|读到|目的|回复|想被疼/u.test(spoken), `${delivery}: ${spoken}`);
      assert.ok(draft.bubbles.length >= 1);
      assert.ok(draft.plan, 'the plan is kept for the owner');
    }
  }
  // a reply that is only markers is not a reply
  assert.throws(() => parseDraft({ text: '【读到】想被疼\n【目的】被关心：暖' }, v8()));
});

test('58 the plan is stored with the reply (read + aim) and never changes the published bubbles', () => {
  const request = v8();
  const draft = parseDraft({ text: `${PLAN}有你的爱当外套，我就不会着凉` }, request) as WriterDraft;
  const reply = applyReview(guard(), draft, request);
  assert.deepEqual(
    reply.bubbles.map((b) => b.text),
    ['有你的爱当外套，我就不会着凉'],
  );
  assert.deepEqual(reply.plan, {
    read: '对方在关心我，想被回应',
    aim: '心动（回撩）：把外套说成他的爱',
    aims: ['心动'],
  });
  assert.ok(!JSON.stringify(reply.bubbles).includes('读到'));
  // a replacement from the guard cannot bring a marker in either
  const fixed = applyReview(
    guard({ fixes: [{ index: 0, reason: 'dismissive_filler', text: '【回复】谢谢，好久没人这么关心我了' }] }),
    parseDraft({ text: '行行行，听你的' }, request),
    request,
  );
  assert.deepEqual(
    fixed.bubbles.map((b) => b.text),
    ['谢谢，好久没人这么关心我了'],
  );
  assert.deepEqual(fixed.guardReasons, ['dismissive_filler']);
  assert.equal(fixed.plan, undefined);
});

test('58 the guard text and schema: four new reasons, it reads the plan and flags a reply against it', () => {
  const text = PROMPTS_V8.guard;
  assert.equal(GUARD_REASONS.length, 18);
  for (const reason of ['dismissive_filler', 'impatient_or_lecturing', 'meta_commentary', 'no_emotional_value']) {
    assert.ok(GUARD_REASONS.includes(reason as never), reason);
    assert.ok(text.includes(`- ${reason}：`), reason);
  }
  assert.ok(text.includes('十八种') && !text.includes('十四种'));
  assert.ok(text.includes('plan是她写稿前的想法'));
  assert.ok(text.includes('与plan的aim矛盾'));
  const tool = writerGuardTool(v8()) as unknown as {
    function: {
      description: string;
      parameters: { properties: { fixes: { items: { properties: { reason: { enum: string[] } } } } } };
    };
  };
  assert.deepEqual(tool.function.parameters.properties.fixes.items.properties.reason.enum, [...GUARD_REASONS]);
  assert.ok(tool.function.description.includes('十八种'));
});

const flagged = (reason: string, lines: string[], replacement: string[]) => {
  const request = v8();
  const draft = parseDraft({ text: lines.join('\n') }, request);
  const result = applyReview(
    guard({ fixes: replacement.map((text, index) => ({ index, reason, text })) }),
    draft,
    request,
  );
  assert.deepEqual(
    result.bubbles.map((b) => b.text),
    replacement,
  );
  assert.deepEqual(
    result.guardReasons,
    replacement.map(() => reason),
  );
  assert.equal(result.reviewChanged, true);
};
test('58 guard: dismissive_filler is replaced (行 / 行吧 / 行行行 / 行了行了 ...)', () => {
  flagged('dismissive_filler', ['行，听你的，我这就套上'], ['谢谢，好久没人这么关心我了']);
  flagged('dismissive_filler', ['行行行，不让动就不动呗'], ['好，我多穿点，不会着凉的']);
});
test('58 guard: impatient_or_lecturing is replaced', () => {
  flagged('impatient_or_lecturing', ['都说了多少遍了，你自己要注意'], ['我知道啦，你也是']);
});
test('58 guard: meta_commentary is replaced', () => {
  flagged('meta_commentary', ['你说话像个老干部似的'], ['被你这么一说，心里暖暖的']);
});
test('58 guard: no_emotional_value is replaced', () => {
  flagged('no_emotional_value', ['嗯'], ['有你的爱给我当外套，我就不会着凉']);
});

test("58 the guard sees the plan (and only the plan's read and aim); a plan-less draft sends none", () => {
  const request = v8();
  const draft = parseDraft({ text: `${PLAN}嗯` }, request) as WriterDraft;
  const withPlan = JSON.parse(writerGuardMessages(request, draft)[1]!.content) as Record<string, unknown>;
  assert.deepEqual(withPlan.plan, { read: '对方在关心我，想被回应', aim: '心动（回撩）：把外套说成他的爱' });
  const none = parseDraft({ text: '嗯' }, request) as WriterDraft;
  assert.ok(!('plan' in (JSON.parse(writerGuardMessages(request, none)[1]!.content) as Record<string, unknown>)));
});

test('58 the writer sees its last few aims; none means the request is what it was', () => {
  const plain = JSON.parse(writerDraftMessages(v8())[1]!.content) as Record<string, unknown>;
  assert.ok(!('recentAims' in plain));
  const aimed = JSON.parse(writerDraftMessages(v8({ recentAims: ['心动', '被接住', '心动'] }))[1]!.content) as Record<
    string,
    unknown
  >;
  assert.deepEqual(aimed.recentAims, ['心动', '被接住', '心动']);
  assert.throws(() => writerDraftMessages(v8({ recentAims: ['心动', '被接住', '心动', '开心'] })));
  assert.throws(() => writerDraftMessages(v8({ recentAims: ['随便'] })));
  // a rehearsal turn carries the last three purposes of this column's earlier replies
  const frozen = { template: textRequest().character, baseAt: 1_700_000_000_000 };
  const request = rehearsalRequest(
    frozen as never,
    'run',
    'deepseek-v8',
    5,
    ['a', 'b', 'c', 'd', 'e'],
    [['1'], ['2'], ['3'], ['4']],
    ['心动', '惊喜', '开心', '被关心'],
  );
  assert.deepEqual(request.recentAims, ['惊喜', '开心', '被关心']);
  const old = rehearsalRequest(frozen as never, 'run', 'deepseek', 2, ['a', 'b'], [['1']], ['心动']);
  assert.equal(old.recentAims, undefined);
});

test('58 the 行-family count is deterministic: openers only, never a word like 行李', () => {
  for (const bubble of [
    '行，听你的，我这就套上',
    '行吧，随你',
    '行行行，不让动就不动呗',
    '行了行了，知道了',
    '好吧好吧',
    '随你',
    '得了',
    '行啊，还给我留了空间',
    '行',
  ])
    assert.equal(hasFiller([bubble]), true, bubble);
  for (const bubble of [
    '我行李还没收',
    '这样行不行呀',
    '行动起来吧',
    '今天不行了，累',
    '谢谢，好久没人这么关心我了',
    '你说行我就去买',
  ])
    assert.equal(hasFiller([bubble]), false, bubble);
  const counts = countReplies(
    [
      { player: 'a', bubbles: ['行行行，听你的'], answered: null, aims: ['被接住'] },
      { player: 'b', bubbles: ['谢谢你'], answered: null, aims: ['被关心', '心动'] },
      { player: 'c', bubbles: ['好呀', '行吧'], answered: null, aims: ['心动'] },
    ],
    DEFAULT_PHRASES,
    { unconfirmed: 0, failed: 0 },
  );
  assert.equal(counts.fillers, 2);
  assert.deepEqual(counts.aims, { 被接住: 1, 被关心: 1, 心动: 2 });
  assert.deepEqual(
    countReplies([{ player: 'a', bubbles: ['好'], answered: true }], DEFAULT_PHRASES, { unconfirmed: 0, failed: 0 })
      .aims,
    {},
  );
});

test('58 「v8 规则 58」: one fixed script, listed last; no real player text', () => {
  assert.ok(REHEARSAL_SETS.includes(REHEARSAL_RULES_58_SET));
  assert.equal(REHEARSAL_SETS.at(-1), 'rules-58');
  assert.equal(REHEARSAL_SET_LABELS['rules-58'], 'v8 规则 58');
  const turns = builtinSet('rules-58');
  assert.equal(turns.length, 7);
  const joined = turns.join('\n');
  for (const part of ['辛苦', '如果你觉得我是在关心你', '多穿', '别着凉', '我喜欢你', '无聊', '难过'])
    assert.ok(joined.includes(part), part);
  // not the owner's wording verbatim
  for (const real of ['冷了多穿', '如果你认为我在关心你，那也可以，看你怎么理解', '你怎么定义都可以，别着凉感冒就行'])
    assert.ok(!turns.includes(real), real);
});

test('58 the export has two new columns 读到 / 目的 at the end; the earlier columns keep their place', () => {
  assert.deepEqual(CSV_HEADER.slice(-2), ['读到', '目的']);
  assert.equal(CSV_HEADER[0], '#');
  assert.equal(CSV_HEADER[13], '模拟时间');
  const row = previewCsvRow({
    ordinal: 1,
    input: 'x',
    note: null,
    status: 'done',
    errorCode: null,
    settlement: null,
    simulatedTime: null,
    cost: { chargedMicros: 0 },
    latency: { draftMs: 1, reviewMs: 1 },
    final: {
      bubbles: [{ text: '好呀', expression: null }],
      reviewChanged: false,
      plan: { read: '想被疼', aim: '被关心：暖一句', aims: ['被关心'] },
      coverage: [],
    },
  } as never);
  assert.deepEqual(row.slice(-2), ['想被疼', '被关心：暖一句']);
  const none = previewCsvRow({
    ordinal: 1,
    status: 'done',
    cost: { chargedMicros: 0 },
    latency: {},
    final: null,
  } as never);
  assert.deepEqual(none.slice(-2), ['', '']);
});

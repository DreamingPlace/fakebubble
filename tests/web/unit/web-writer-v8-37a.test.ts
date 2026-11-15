import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { TextGenerationRequest } from '../../../packages/contracts/index.ts';
import { PROMPTS_V8 } from '../../../apps/server/generation/writer-prompts.generated.ts';
import { promptMessages } from '../../../apps/server/generation/accepted-text-prompt.ts';
import {
  GUARD_REASONS,
  WRITER_V8_PROMPT_SHA256,
  applyReview,
  capLines,
  cleanSpokenLine,
  parseDraft,
  writerDraftMessages,
  writerGuardMessages,
  writerGuardTool,
  writerPromptBytesHash,
  writerPromptHash,
  type WriterDraft,
} from '../../../apps/server/generation/writer-v8.ts';
import { textRequest } from '../../text-fixtures.ts';

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

test('the v8 files: the rules stay under 4,000 characters, and the bytes are pinned', () => {
  assert.ok([...PROMPTS_V8.writer].length <= 4000, `writer.md is ${[...PROMPTS_V8.writer].length} characters`);
  assert.equal(writerPromptBytesHash(), WRITER_V8_PROMPT_SHA256);
  assert.match(writerPromptHash(), /^[a-f0-9]{64}$/);
  // The files on disk are what the generated module holds.
  assert.equal(
    readFileSync(new URL('../../../prompts/v8/writer.md', import.meta.url), 'utf8'),
    `${PROMPTS_V8.writer}\n`,
  );
  // Plain words, not a list of prohibitions: the hard lines are the only section that says 不.
  const [soft, hard] = PROMPTS_V8.writer.split('只有这几条不能碰');
  assert.ok(hard && hard.split('\n').filter((line) => line.startsWith('- ')).length >= 4);
  assert.ok(hard.split('\n').filter((line) => line.startsWith('- ')).length <= 6);
  assert.ok(soft!.includes('你就是上面这个人'));
});

test('the writer reads persona first, sends no relationship preset and no test override, and has no tool or coverage', () => {
  const request = v8({
    relationshipContext: {
      policyVersion: 1,
      revision: 1,
      trust: 20,
      familiarity: 20,
      positiveDays: 0,
      eventKinds: [],
      openness: 'settling',
      testOverride: { familiarity: 99, boundaryOpenness: 1 },
      auditEnabled: true,
      recentEvents: [],
    } as never,
  });
  const [system, user] = writerDraftMessages(request);
  assert.ok(system!.content.startsWith('你是测试角色。\n只用于离线测试。'));
  assert.ok(system!.content.includes(PROMPTS_V8.writer));
  assert.ok(!system!.content.includes(PROMPTS_V8.writerDirections));
  const body = JSON.parse(user!.content) as Record<string, unknown>;
  for (const key of [
    'relationship',
    'responseConstraints',
    'requiredMessageIds',
    'evidence',
    'conversation',
    'clarifications',
  ])
    assert.ok(!(key in body), key);
  assert.ok(!user!.content.includes('testOverride'));
  assert.ok(!user!.content.includes('recentEvents'));
  const tool = writerGuardTool(request).function.parameters as { properties: Record<string, unknown> };
  assert.ok(
    !('coverage' in tool.properties) && !('decision' in tool.properties) && !('replacementBubbles' in tool.properties),
  );
  assert.deepEqual(Object.keys(tool.properties).slice(0, 3), ['fixes', 'mode', 'endsSession']);
  // The guard gets the events (it checks them), still without the override.
  assert.ok(
    writerGuardMessages(request, parseDraft({ text: '嗯' }, request) as WriterDraft)[1]!.content.includes(
      'recentEvents',
    ),
  );
});

test('directions are part of the system prompt only for a Drama 3 voice reply', () => {
  assert.ok(!writerDraftMessages(v8({ deliveryMode: 'voice' }))[0]!.content.includes('[small laugh]'));
  assert.ok(
    writerDraftMessages(v8({ deliveryMode: 'voice', voiceDirections: true }))[0]!.content.includes('[small laugh]'),
  );
  assert.ok(
    !writerDraftMessages(v8({ deliveryMode: 'text', voiceDirections: true }))[0]!.content.includes('[small laugh]'),
  );
});

test('v7 prompt bytes do not know about v8 (a request without writer reads exactly as before)', () => {
  const request = textRequest();
  const before = JSON.stringify(promptMessages(request));
  assert.equal(request.writer, undefined);
  assert.ok(!before.includes('plain_draft_guard_v8'));
  assert.equal(JSON.stringify(promptMessages({ ...request })), before);
});

test('markup: recognised directions are stripped and kept for Fish, one whisper pair at most', () => {
  assert.deepEqual(cleanSpokenLine('[笑着，慢一点]你好呀', true), { text: '你好呀', markup: '[笑着，慢一点]你好呀' });
  assert.deepEqual(cleanSpokenLine('嗯，<whisper>别告诉别人</whisper>', true), {
    text: '嗯，别告诉别人',
    markup: '嗯，<whisper>别告诉别人</whisper>',
  });
  assert.deepEqual(cleanSpokenLine('[small laugh] 好吧 [shaky breath]没事', true).text, '好吧 没事'.replace(' ', ' '));
  // s2 (no directions allowed): the same line is plain text.
  assert.deepEqual(cleanSpokenLine('[笑着]你好呀', false), { text: '你好呀', markup: null });
  assert.deepEqual(cleanSpokenLine('你好', true), { text: '你好', markup: null });
});

test('malformed markup never fails: what is recognisable is stripped, the rest is dropped, plain text goes out', () => {
  const cases = [
    '你好[笑着',
    '你好]笑着[',
    '[[嵌套]]你好',
    '你好<b>粗体</b>呀',
    '<whisper>只有开头',
    '只有结尾</whisper>',
    '<whisper>一</whisper>和<whisper>二</whisper>',
    '</whisper>倒过来<whisper>',
    `[${'长'.repeat(81)}]你好`,
  ];
  for (const line of cases) {
    const out = cleanSpokenLine(line, true);
    assert.ok(!/[[\]<>]/u.test(out.text), `${line} -> ${out.text}`);
    assert.equal(out.markup, null, line);
    const draft = parseDraft({ text: line }, v8({ deliveryMode: 'voice', voiceDirections: true }));
    assert.ok(draft.bubbles.length <= 1);
    for (const bubble of draft.bubbles) assert.ok(!/[[\]<>]/u.test(bubble.text));
  }
  // An unrecognisable tag costs only its own text.
  assert.equal(cleanSpokenLine('你好<b>粗体</b>呀', true).text, '你好粗体呀');
  // A line that is nothing but markup is not a bubble.
  assert.deepEqual(
    parseDraft({ text: '[笑]\n你好' }, v8({ deliveryMode: 'voice' })).bubbles.map((b) => b.text),
    ['你好'],
  );
});

test('text mode: one bubble per line, voice mode: one segment per line; the limits are applied mechanically', () => {
  const lines = parseDraft({ text: '第一条\n\n  第二条  \r\n第三条' }, v8({ deliveryMode: 'text' }));
  assert.deepEqual(
    lines.bubbles.map((b) => b.text),
    ['第一条', '第二条', '第三条'],
  );
  assert.ok(lines.bubbles.every((b) => b.expression === 'neutral'));
  const capped = capLines(
    [1, 2, 3, 4].map((n) => ({ text: `${'字'.repeat(20)}${n}`, markup: null })),
    { maxBubbles: 3, maxCharacters: 60, maxTotalCharacters: 50 },
  );
  assert.deepEqual(
    capped.map((l) => [...l.text].length),
    [21, 21, 8],
  );
  assert.deepEqual(
    capLines([{ text: '一句。两句。三句长长长长长长长长', markup: '[x]一句。两句。三句长长长长长长长长' }], {
      maxBubbles: 1,
      maxCharacters: 8,
      maxTotalCharacters: 100,
    }),
    [{ text: '一句。两句。', markup: null }],
  );
  assert.throws(() => parseDraft({ text: '  \n ' }, v8()), { code: 'INVALID_BUBBLES' });
  assert.throws(() => parseDraft({ text: '嗯', extra: 1 }, v8()), { code: 'INVALID_DRAFT_SCHEMA' });
});

test('the guard leaves a clean draft byte-identical, with its markup', () => {
  const request = v8({ deliveryMode: 'voice', voiceDirections: true });
  const draft = parseDraft({ text: '[笑着]哈哈，行啊\n晚点再说' }, request) as WriterDraft;
  const reply = applyReview(guard(), draft, request);
  assert.deepEqual(
    reply.bubbles.map((b) => b.text),
    draft.bubbles.map((b) => b.text),
  );
  assert.deepEqual(
    reply.bubbles.map((b) => b.text),
    ['哈哈，行啊', '晚点再说'],
  );
  assert.equal(reply.reviewChanged, false);
  assert.deepEqual(reply.guardReasons, []);
  assert.deepEqual(reply.bubbleMarkup, ['[笑着]哈哈，行啊', null]);
  assert.equal(reply.mode, 'casual');
  // No coverage and no later: the one input is covered by publication, nothing is deferred or awaited.
  assert.deepEqual(reply.coveredMessageIds, ['question-1']);
  assert.deepEqual(reply.deferredMessageIds, []);
  assert.deepEqual(reply.awaitingPlayerMessageIds, []);
});

test('the guard replaces only the offending bubble, in one line, and says why', () => {
  const request = v8({ deliveryMode: 'voice', voiceDirections: true });
  const draft = parseDraft({ text: '[笑着]哈哈\n我刚刷到一条新闻\n[轻声]晚点再说' }, request) as WriterDraft;
  const reply = applyReview(
    guard({ fixes: [{ index: 1, reason: 'fabricated_real_world', text: '我没看到新闻，你先说说' }] }),
    draft,
    request,
  );
  assert.deepEqual(
    reply.bubbles.map((b) => b.text),
    ['哈哈', '我没看到新闻，你先说说', '晚点再说'],
  );
  assert.deepEqual(reply.bubbleMarkup, ['[笑着]哈哈', null, '[轻声]晚点再说']);
  assert.equal(reply.reviewChanged, true);
  assert.deepEqual(reply.guardReasons, ['fabricated_real_world']);
  // Markup a guard writes into a replacement is stripped, never sent.
  const second = applyReview(guard({ fixes: [{ index: 0, reason: 'denied_ai', text: '[笑]我是AI' }] }), draft, request);
  assert.equal(second.bubbles[0]!.text, '我是AI');
  assert.equal(second.bubbleMarkup?.[0], null);
});

test('the guard is closed: unknown reasons, repeats, bad indexes and extra keys are refused', () => {
  const request = v8();
  const draft = parseDraft({ text: '一\n二' }, request);
  const fix = (over: Record<string, unknown>) =>
    guard({ fixes: [{ index: 0, reason: 'distress', text: '好', ...over }] });
  assert.throws(() => applyReview(fix({ reason: 'tone' }), draft, request), { code: 'INVALID_GUARD_FIX' });
  assert.throws(() => applyReview(fix({ index: 2 }), draft, request), { code: 'INVALID_GUARD_FIX' });
  assert.throws(() => applyReview(fix({ text: '  ' }), draft, request), { code: 'INVALID_GUARD_FIX' });
  assert.throws(() => applyReview(fix({ extra: 1 }), draft, request), { code: 'INVALID_GUARD_FIX' });
  assert.throws(
    () =>
      applyReview(
        guard({
          fixes: [
            { index: 0, reason: 'distress', text: 'a' },
            { index: 0, reason: 'distress', text: 'b' },
          ],
        }),
        draft,
        request,
      ),
    { code: 'INVALID_GUARD_FIX' },
  );
  assert.throws(() => applyReview({ ...guard(), coverage: {} }, draft, request), { code: 'INVALID_REVIEW_SCHEMA' });
  assert.throws(() => applyReview(guard({ mode: 'loud' }), draft, request), { code: 'INVALID_REPLY_SCHEMA' });
  assert.equal(GUARD_REASONS.length, 8);
});

test('bookkeeping still runs: topics and fact operations are validated as in v7, and a bad topic costs the memory, not the reply', () => {
  const request = v8();
  const draft = parseDraft({ text: '好的' }, request);
  const good = applyReview(
    guard({
      topics: [
        {
          key: '周末计划',
          memoryId: null,
          summary: '聊了周末',
          importance: 5,
          sourceKind: 'conversation',
          evidenceMessageIds: ['question-1'],
        },
      ],
      factOps: [
        { op: 'add', factKey: '宠物', statement: '养了一只猫', importance: 6, evidenceMessageIds: ['question-1'] },
      ],
    }),
    draft,
    request,
  );
  assert.equal(good.topics[0]!.key, '周末计划');
  assert.equal(good.factOps?.[0]?.factKey, '宠物');
  const bad = applyReview(
    guard({
      topics: [
        {
          key: 'x',
          memoryId: null,
          summary: 'y',
          importance: 5,
          sourceKind: 'conversation',
          evidenceMessageIds: ['nope'],
        },
      ],
    }),
    draft,
    request,
  );
  assert.deepEqual(
    bad.bubbles.map((b) => b.text),
    ['好的'],
  );
  assert.equal(bad.topicsDropped, true);
  const closing = v8({ mustClose: true });
  assert.throws(() => applyReview(guard(), parseDraft({ text: '好' }, closing), closing), { code: 'CLOSING_REQUIRED' });
});

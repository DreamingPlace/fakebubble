import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DROP_INVALID_METADATA,
  applyTextReview,
  type TextDraft,
} from '../../../apps/server/generation/accepted-text-protocol.ts';
import { auditReply, draftPresentation, textRequest } from '../../text-fixtures.ts';

function fixture(memories: { id: string; key: string }[] = []) {
  const request = textRequest();
  request.memories = memories.map((memory) => ({
    ...memory,
    tier: 'long' as const,
    playerMentions: 2,
    recallWeight: 1,
    lastSeenAt: 1,
    episodes: [],
  }));
  const draft = draftPresentation(request) as TextDraft;
  const { bubbleChecks: _checks, ...review } = auditReply(request, draft);
  const lenient = (patch: Record<string, unknown>) =>
    applyTextReview({ ...review, ...patch }, draft, request, DROP_INVALID_METADATA);
  const strict = (patch: Record<string, unknown>) => applyTextReview({ ...review, ...patch }, draft, request);
  return { request, review, lenient, strict };
}
const topic = (extra: Record<string, unknown> = {}) => ({
  key: '解方程',
  memoryId: null as string | null,
  summary: '玩家问了一道方程题。',
  importance: 3 as unknown,
  sourceKind: 'player_statement',
  evidenceMessageIds: ['question-1'],
  ...extra,
});
const factOp = (extra: Record<string, unknown> = {}) => ({
  op: 'add',
  factKey: '宠物',
  statement: '玩家养了一只猫。',
  importance: 5 as unknown,
  evidenceMessageIds: ['question-1'],
  ...extra,
});
const withoutMemoryId = ({ memoryId: _memoryId, ...rest }: ReturnType<typeof topic>) => rest;

test('normalization: a missing memoryId is null, an integer-string importance is the number, unknown keys are dropped', () => {
  const { lenient, strict } = fixture();
  for (const apply of [lenient, strict]) {
    const result = apply({
      topics: [{ ...withoutMemoryId(topic({ importance: '3' })), reasoning: 'x', confidence: 0.9 }],
      factOps: [{ ...factOp({ importance: '5' }), note: 'x' }],
    });
    assert.deepEqual(
      result.topics.map(({ key, importance, linkedMemoryId, ...rest }) => ({
        key,
        importance,
        linkedMemoryId,
        extra: Object.keys(rest).sort(),
      })),
      [
        {
          key: '解方程',
          importance: 3,
          linkedMemoryId: undefined,
          extra: ['evidenceMessageIds', 'sourceEvidenceIds', 'sourceKind', 'summary'],
        },
      ],
    );
    assert.deepEqual(result.factOps, [
      { op: 'add', factKey: '宠物', statement: '玩家养了一只猫。', importance: 5, evidenceMessageIds: ['question-1'] },
    ]);
    assert.equal(result.topicsDropped, undefined);
    assert.equal(result.factsDropped, undefined);
  }
});

test('normalization does not relax the semantic checks: strict mode still rejects, lenient mode drops', () => {
  const { lenient, strict } = fixture([
    { id: 'mem-1', key: '宠物' },
    { id: 'mem-2', key: '工作' },
  ]);
  const badTopics: [string, Record<string, unknown>][] = [
    ['importance out of range', topic({ importance: 11 })],
    ['importance zero', topic({ importance: '0' })],
    ['importance a non-integer string', topic({ importance: '3.5' })],
    ['importance a word', topic({ importance: 'high' })],
    ['empty summary', topic({ summary: '  ' })],
    ['summary too long', topic({ summary: '长'.repeat(241) })],
    ['unknown sourceKind', topic({ sourceKind: 'guess' })],
    ['key not a valid key', topic({ key: '' })],
    ['evidence of a message that is not in the request', topic({ evidenceMessageIds: ['nope'] })],
    ['memory link to an unrecalled memory', topic({ memoryId: 'mem-9' })],
    ['memory link worded as another recalled memory', topic({ memoryId: 'mem-1', key: '工作' })],
  ];
  for (const [label, bad] of badTopics) {
    assert.throws(() => strict({ topics: [bad] }), /INVALID_(TOPICS|MEMORY_LINK|MEMORY_EVIDENCE)/, label);
    const result = lenient({ topics: [bad] });
    assert.equal(result.topicsDropped, true, label);
    assert.deepEqual(result.topics, [], label);
  }
  const badFacts: [string, Record<string, unknown>][] = [
    ['importance out of range', factOp({ importance: '12' })],
    ['unknown op', factOp({ op: 'delete' })],
    ['empty statement', factOp({ statement: '' })],
    ['multi-line statement', factOp({ statement: '一行\n两行' })],
    ['no evidence', factOp({ evidenceMessageIds: [] })],
    ['evidence not in the request', factOp({ evidenceMessageIds: ['nope'] })],
  ];
  for (const [label, bad] of badFacts) {
    assert.throws(() => strict({ factOps: [bad] }), /INVALID_(FACTS|MEMORY_EVIDENCE)/, label);
    const result = lenient({ factOps: [bad] });
    assert.equal(result.factsDropped, true, label);
    assert.deepEqual(result.factOps, [], label);
  }
});

test('dropped topics: the valid reply is delivered unchanged, only the memory metadata is lost', () => {
  const { lenient, request, review } = fixture();
  const kept = lenient({});
  const dropped = lenient({ topics: [topic({ importance: 99 })], factOps: [factOp()] });
  assert.equal(dropped.topicsDropped, true);
  assert.equal(dropped.factsDropped, undefined, 'the valid factOps are kept');
  assert.deepEqual(dropped.topics, []);
  assert.deepEqual(dropped.factOps, [factOp({ importance: 5 })]);
  assert.deepEqual(dropped.bubbles, kept.bubbles);
  assert.deepEqual(dropped.coveredMessageIds, kept.coveredMessageIds);
  assert.deepEqual(dropped.coveredMessageIds, request.requiredMessageIds);
  assert.equal(dropped.reviewChanged, kept.reviewChanged);
  assert.ok(review.topics.length > 0, 'the fixture review does carry a topic that the clean path keeps');
  assert.equal(kept.topics.length, review.topics.length);
  assert.equal(kept.topicsDropped, undefined);
});

test('both topics and facts invalid: both are dropped and both flagged', () => {
  const { lenient } = fixture();
  const result = lenient({ topics: [topic({ summary: '' })], factOps: [factOp({ evidenceMessageIds: ['nope'] })] });
  assert.equal(result.topicsDropped, true);
  assert.equal(result.factsDropped, true);
  assert.deepEqual([result.topics, result.factOps], [[], []]);
});

test('coverage, bubbles, format and safety still fail the whole reply, with or without invalid metadata', () => {
  const { lenient, request } = fixture();
  const broken: [string, Record<string, unknown>, RegExp][] = [
    ['coverage missing a required id', { coverage: {} }, /INCOMPLETE_COVERAGE/],
    [
      'unsupported coverage quote',
      {
        coverage: {
          [request.requiredMessageIds[0]!]: { status: 'answered', supportQuote: '不在气泡里', missingInformation: '' },
        },
      },
      /INVALID_REVIEW_COVERAGE/,
    ],
    ['reject decision', { decision: 'reject' }, /TEXT_REVIEW_REJECTED/],
    ['unknown review key', { surprise: 1 }, /INVALID_REVIEW_SCHEMA/],
    [
      'too many replacement bubbles',
      { replacementBubbles: Array.from({ length: 9 }, () => ({ text: '好', expression: 'neutral' })) },
      /./,
    ],
  ];
  for (const [label, patch, error] of broken) {
    assert.throws(() => lenient(patch), error, label);
    assert.throws(
      () => lenient({ ...patch, topics: [topic({ importance: 99 })], factOps: [factOp({ importance: 99 })] }),
      error,
      `${label}, with invalid metadata as well`,
    );
  }
});

test('topics that are not an array, or more than three, are metadata failures too (dropped, never the reply)', () => {
  const { lenient, strict } = fixture();
  for (const topics of [
    'none',
    null,
    { a: 1 },
    [topic({ key: 'a' }), topic({ key: 'b' }), topic({ key: 'c' }), topic({ key: 'd' })],
  ]) {
    assert.throws(() => strict({ topics }), /INVALID_TOPICS/);
    assert.equal(lenient({ topics }).topicsDropped, true);
  }
  assert.throws(() => strict({ factOps: 'none' }), /INVALID_FACTS/);
  assert.equal(lenient({ factOps: 'none' }).factsDropped, true);
  assert.equal(lenient({ topics: [topic({ key: 'x' }), topic({ key: 'x' })] }).topicsDropped, true, 'duplicate keys');
});

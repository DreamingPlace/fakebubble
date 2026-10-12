import assert from 'node:assert/strict';
import test from 'node:test';
import { applyTextReview } from '../../../apps/server/generation/accepted-text-protocol.ts';
import type { TextDraft } from '../../../apps/server/generation/accepted-text-protocol.ts';
import { auditReply, draftPresentation, textRequest } from '../../text-fixtures.ts';

// Part 16b: a coverage supportQuote may span consecutive final bubbles; everything else stays strict.
const A = '哎，加班到现在？我这边也是，刚醒，然后睡不着了。';
const B = '你比我累多了，真的。';
const C = '早点睡吧。';

function reviewed(texts: string[], status: string, supportQuote: string, missingInformation = '') {
  const request = textRequest();
  const draft = draftPresentation(request) as TextDraft;
  const { bubbleChecks: _checks, ...audit } = auditReply(request, draft);
  const replacementBubbles = texts.map((text) => ({ text, expression: 'playful' }));
  const coverage = { 'question-1': { status, supportQuote, missingInformation } };
  return () => applyTextReview({ ...audit, replacementBubbles, coverage }, draft, request);
}

test('the real rejected output: a quote across two consecutive bubbles is answered', () => {
  const candidate = reviewed([A, B], 'answered', `${A}${B}`)();
  assert.deepEqual(candidate.coveredMessageIds, ['question-1']);
  assert.deepEqual(
    candidate.bubbles.map((bubble) => bubble.text),
    [A, B],
  );
});

test('a quote may join bubbles with a single space, and span three bubbles', () => {
  assert.deepEqual(reviewed([A, B], 'answered', `${A} ${B}`)().coveredMessageIds, ['question-1']);
  assert.deepEqual(reviewed([A, B, C], 'answered', `睡不着了。${B}${C}`)().coveredMessageIds, ['question-1']);
  assert.deepEqual(reviewed([A, B, C], 'answered', `${B} ${C}`)().coveredMessageIds, ['question-1']);
});

test('needs_player accepts a quote spanning consecutive bubbles too', () => {
  const candidate = reviewed([A, B], 'needs_player', `${A}${B}`, '缺什么')();
  assert.deepEqual(candidate.awaitingPlayerMessageIds, ['question-1']);
});

test('a quote not in the reply, out of order, or across a skipped bubble is still rejected', () => {
  assert.throws(reviewed([A, B], 'answered', '这句话没有出现过'), /INVALID_REVIEW_COVERAGE/);
  assert.throws(reviewed([A, B], 'answered', `${B}${A}`), /INVALID_REVIEW_COVERAGE/);
  assert.throws(reviewed([A, B, C], 'answered', `睡不着了。${C}`), /INVALID_REVIEW_COVERAGE/);
  assert.throws(reviewed([A, B], 'needs_player', '没引用', '缺什么'), /INVALID_REVIEW_COVERAGE/);
});

test('field consistency, emptiness and newlines stay strict', () => {
  assert.throws(reviewed([A, B], 'answered', `${A}${B}`, '缺信息'), /INVALID_REVIEW_COVERAGE/);
  assert.throws(reviewed([A, B], 'answered', ''), /INVALID_REVIEW_COVERAGE/);
  assert.throws(reviewed([A, B], 'answered', `${A}\n${B}`), /INVALID_REVIEW_COVERAGE/);
  assert.throws(reviewed([A, B], 'needs_player', `${A}${B}`, ''), /INVALID_REVIEW_COVERAGE/);
});

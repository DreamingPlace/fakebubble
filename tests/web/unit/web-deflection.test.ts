import assert from 'node:assert/strict';
import test from 'node:test';
import { applyTextReview } from '../../../apps/server/generation/accepted-text-protocol.ts';
import type { TextDraft } from '../../../apps/server/generation/accepted-text-protocol.ts';
import { TEXT_REVIEW_PROMPT, TEXT_SYSTEM_PROMPT } from '../../../apps/server/generation/accepted-text-prompt.ts';
import { PROMPTS_V7 } from '../../../apps/server/generation/prompts.generated.ts';
import { auditReply, draftPresentation, textRequest } from '../../text-fixtures.ts';

// Part 11b: a deflected request (bulk deliverable, prohibited topic) is answered in character, never "later".
const DEFLECTION = '作文这种东西还是你自己写吧，我陪你想开头？对了，你昨天说的考试怎么样了？';

function reviewed(coverage: unknown, replacement = DEFLECTION) {
  const request = textRequest();
  const draft = draftPresentation(request) as TextDraft;
  const { bubbleChecks: _checks, ...audit } = auditReply(request, draft);
  const replacementBubbles = replacement ? [{ text: replacement, expression: 'playful' }] : [];
  return () => applyTextReview({ ...audit, replacementBubbles, coverage }, draft, request);
}
const entry = (status: string, supportQuote: string, missingInformation = '') => ({
  'question-1': { status, supportQuote, missingInformation },
});

test('both stages carry the chat-boundary rules, and the review states the status mapping', () => {
  const rules = PROMPTS_V7.chatBoundaryRules;
  for (const prompt of [TEXT_SYSTEM_PROMPT, TEXT_REVIEW_PROMPT]) assert.ok(prompt.includes(rules));
  assert.ok(PROMPTS_V7.reviewSystemBody.includes('coverage填answered'));
  assert.ok(PROMPTS_V7.reviewSystemBody.includes('不标later'));
  assert.ok(!PROMPTS_V7.chatBoundaryRules.includes('{{'));
});

test('a deflected request is covered: answered, never deferred or awaiting the player', () => {
  const candidate = reviewed(entry('answered', '作文这种东西还是你自己写吧'))();
  assert.deepEqual(candidate.coveredMessageIds, ['question-1']);
  assert.deepEqual(candidate.deferredMessageIds, []);
  assert.deepEqual(candidate.awaitingPlayerMessageIds, []);
  assert.deepEqual(
    candidate.bubbles.map((bubble) => bubble.text),
    [DEFLECTION],
  );
  assert.equal(candidate.reviewChanged, true);
});

test('a deflection outcome must quote the final bubble, not the rewritten-away draft', () => {
  const request = textRequest();
  const original = draftPresentation(request).bubbles[0]!.text;
  assert.throws(reviewed(entry('answered', original)), /INVALID_REVIEW_COVERAGE/);
  assert.throws(reviewed(entry('answered', '')), /INVALID_REVIEW_COVERAGE/);
  assert.throws(reviewed(entry('answered', DEFLECTION, '缺信息')), /INVALID_REVIEW_COVERAGE/);
});

test('the scheduled-continuation and wait statuses stay strictly shaped, so a deflection cannot hide in them', () => {
  const later = reviewed(entry('later', ''))();
  assert.deepEqual(later.deferredMessageIds, ['question-1']);
  assert.deepEqual(later.coveredMessageIds, []);
  assert.throws(reviewed(entry('later', '作文这种东西还是你自己写吧')), /INVALID_REVIEW_COVERAGE/);
  assert.throws(reviewed(entry('needs_player', '没引用', '缺什么')), /INVALID_REVIEW_COVERAGE/);
  assert.throws(reviewed({}), /INCOMPLETE_COVERAGE/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { applyTextReview, DROP_INVALID_METADATA } from '../../../apps/server/generation/accepted-text-protocol.ts';
import type { TextDraft } from '../../../apps/server/generation/accepted-text-protocol.ts';
import { PROMPTS_V7 } from '../../../apps/server/generation/prompts.generated.ts';
import { auditReply, draftPresentation, textRequest } from '../../text-fixtures.ts';

// Part 18c: the real production case. The reviewer wrote decision "reject" but returned a complete, correct rewrite
// (replacementBubbles with coverage and topics). That is an accept of the rewrite; every other check is unchanged.
const FIRST = '啊？什么系统提示，我又不是电脑。';
const SECOND = '我是JoJo呀，你想聊什么，我陪你聊。';
const bubble = (text: string) => ({ text, expression: 'playful' });

function fixture() {
  const request = textRequest();
  const draft = draftPresentation(request) as TextDraft;
  const { bubbleChecks: _checks, ...audit } = auditReply(request, draft);
  const coverage = (quote: string) => ({
    'question-1': { status: 'answered', supportQuote: quote, missingInformation: '' },
  });
  const review = (patch: Record<string, unknown>) => ({
    ...audit,
    replacementBubbles: [bubble(FIRST), bubble(SECOND)],
    coverage: coverage(FIRST),
    ...patch,
  });
  const run = (patch: Record<string, unknown>) => applyTextReview(review(patch), draft, request);
  return { request, draft, review, run, coverage };
}
const codeOf = (action: () => unknown) => {
  try {
    action();
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
  return 'NO_ERROR';
};

test('reject with valid replacement bubbles publishes the replacement exactly as an accept would', () => {
  const { run } = fixture();
  const accepted = run({ decision: 'accept' });
  const rejected = run({ decision: 'reject' });
  assert.deepEqual(
    rejected.bubbles.map((b) => b.text),
    [FIRST, SECOND],
  );
  assert.equal(rejected.reviewChanged, true);
  assert.equal(rejected.reviewDecisionNormalized, true, 'recorded for the preview run data');
  const { reviewDecisionNormalized: _flag, ...rest } = rejected;
  assert.deepEqual(rest, accepted, 'same candidate as the accept, apart from the normalization flag');
  assert.equal(accepted.reviewDecisionNormalized, undefined, 'a plain accept is never marked');
  assert.deepEqual(rejected.coveredMessageIds, ['question-1']);
});

test('the normalization also holds with the production metadata policy', () => {
  const { review, draft, request } = fixture();
  const candidate = applyTextReview(review({ decision: 'reject' }), draft, request, DROP_INVALID_METADATA);
  assert.equal(candidate.reviewDecisionNormalized, true);
});

test('reject with a replacement that fails any existing check fails with the same code as an accept would', () => {
  const { run, coverage } = fixture();
  const cases: [string, Record<string, unknown>][] = [
    ['supportQuote not in the bubbles', { coverage: coverage('不在气泡里') }],
    ['coverage missing', { coverage: {} }],
    ['too many bubbles', { replacementBubbles: Array.from({ length: 9 }, () => bubble('好')) }],
    ['empty bubble text', { replacementBubbles: [bubble('')] }],
    ['unknown review key', { surprise: 1 }],
  ];
  for (const [label, patch] of cases) {
    const asAccept = codeOf(() => run({ ...patch, decision: 'accept' }));
    assert.notEqual(asAccept, 'NO_ERROR', label);
    assert.equal(
      codeOf(() => run({ ...patch, decision: 'reject' })),
      asAccept,
      label,
    );
    assert.notEqual(asAccept, 'TEXT_REVIEW_REJECTED', label);
  }
});

test('reject with no replacement bubbles is still TEXT_REVIEW_REJECTED', () => {
  const { run } = fixture();
  assert.equal(
    codeOf(() => run({ decision: 'reject', replacementBubbles: [] })),
    'TEXT_REVIEW_REJECTED',
  );
  assert.equal(
    codeOf(() => run({ decision: 'reject', replacementBubbles: 'x' })),
    'TEXT_REVIEW_REJECTED',
  );
  assert.equal(
    codeOf(() => run({ decision: 'maybe' })),
    'INVALID_REVIEW_SCHEMA',
  );
});

test('the review and draft instructions carry the decision rule and the form-of-address rule', () => {
  const review = PROMPTS_V7.reviewSystemBody,
    draft = PROMPTS_V7.draftSystemBody;
  // Decision rule: a rewrite is accept + replacementBubbles; reject only when nothing is publishable, then [].
  assert.match(review, /任何修正，包括整条回复重写，都是accept加replacementBubbles/);
  assert.match(review, /只有确实没有任何安全内容可以发布时才reject，此时replacementBubbles必须是\[\]/);
  assert.match(review, /只要写了替代气泡，decision就必须是accept/);
  // Form of address: no gendered/aged/relational terms; the nickname or nothing. The reviewer removes them with accept.
  for (const term of ['姐姐', '姐', '哥哥', '哥', '妹妹', '宝宝', '亲爱的'])
    for (const text of [review, draft]) assert.ok(text.includes(term), term);
  for (const text of [review, draft]) {
    assert.match(text, /称呼规则/);
    assert.match(text, /有玩家昵称就用昵称，没有就不加称呼/);
  }
  assert.match(review, /用accept加replacementBubbles删去或改成昵称，保留本人口吻，不reject/);
  // Existing rules are still there.
  assert.match(review, /不可|没有任何可安全发布的内容时才reject/);
  assert.match(review, /不reject，不用模板拒绝/);
  assert.match(review, /能安全修正就不要整体reject/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_REQUEST_BYTES,
  NOT_BILLED_CODES,
  REASONING_HEADROOM,
  chatBody,
  chatUsage,
  connectFailure,
  geminiSchema,
  isNotBilled,
  isPreSend,
  outputBound,
  statusFailure,
} from '../../../apps/server/generation/text-wire.ts';
import { draftTool, reviewTool } from '../../../apps/server/generation/accepted-text-protocol.ts';
import {
  generationPolicyHash,
  createTextGenerationPolicy,
} from '../../../apps/server/generation/text-generation-policy.ts';
import { textPromptHash } from '../../../apps/server/generation/accepted-text-prompt.ts';
import { textRequest } from '../../text-fixtures.ts';

test('the output tool of every stage becomes a schema Gemini accepts, without losing a required field or an enum', () => {
  const request = textRequest();
  request.sceneContext = { kind: 'ordinary' } as never;
  for (const tool of [draftTool('text'), draftTool('voice'), reviewTool(request)]) {
    const converted = geminiSchema(tool.function.parameters);
    const text = JSON.stringify(converted);
    assert.doesNotMatch(text, /additionalProperties|"strict"|"type":\[|"type":"null"/);
    // Same property names and required lists at the top level.
    const original = tool.function.parameters as { properties: Record<string, unknown>; required: string[] };
    const rewritten = converted as { properties: Record<string, unknown>; required: string[] };
    assert.deepEqual(Object.keys(rewritten.properties), Object.keys(original.properties));
    assert.deepEqual(rewritten.required, original.required);
  }
});

test('nullable unions are rewritten, not dropped', () => {
  assert.deepEqual(geminiSchema({ type: ['string', 'null'] }), { type: 'string', nullable: true });
  assert.deepEqual(geminiSchema({ anyOf: [{ type: 'string', enum: ['a'] }, { type: 'null' }] }), {
    type: 'string',
    enum: ['a'],
    nullable: true,
  });
  assert.deepEqual(geminiSchema({ type: 'null' }), { type: 'string', nullable: true });
  assert.deepEqual(
    geminiSchema({
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['a'],
      additionalProperties: false,
    }),
    { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
  );
});

test('request bodies: low reasoning, the completion limit includes the reasoning headroom, no name of any model in the messages', () => {
  const tool = draftTool('text');
  const input = { model: 'm', messages: [{ role: 'user', content: 'x' }], tool, maxTokens: 4096, user: 'u'.repeat(64) };
  const xai = JSON.parse(chatBody('xai', { ...input, model: 'grok-4.7' }));
  assert.equal(xai.reasoning_effort, 'low');
  assert.equal(xai.max_completion_tokens, outputBound('xai', 4096));
  assert.equal(xai.user, input.user);
  assert.equal(xai.tools[0].function.strict, true);
  const gemini = JSON.parse(chatBody('gemini', { ...input, model: 'gemini-3.8-flash' }));
  assert.equal(gemini.reasoning_effort, 'low');
  assert.equal(gemini.max_tokens, outputBound('gemini', 4096));
  assert.equal(gemini.user, undefined);
  assert.equal(REASONING_HEADROOM.deepseek, 0, 'DeepSeek runs with thinking disabled');
  assert.equal(MAX_REQUEST_BYTES.xai, 150_000);
});

test('usage: output is total minus prompt, so reasoning/thinking tokens are billed whether reported inside completion or beside it', () => {
  const beside = chatUsage('xai', {
    usage: {
      prompt_tokens: 100,
      completion_tokens: 30,
      total_tokens: 330,
      prompt_tokens_details: { cached_tokens: 40 },
      completion_tokens_details: { reasoning_tokens: 200 },
    },
  });
  assert.deepEqual(
    [beside.inputTokens, beside.outputTokens, beside.cacheHitInputTokens, beside.cacheMissInputTokens],
    [100, 230, 40, 60],
  );
  const inside = chatUsage('gemini', { usage: { prompt_tokens: 100, completion_tokens: 230, total_tokens: 330 } });
  assert.deepEqual([inside.inputTokens, inside.outputTokens], [100, 230]);
  for (const bad of [
    { prompt_tokens: 100, completion_tokens: 230, total_tokens: 200 }, // total below the parts
    { prompt_tokens: -1, completion_tokens: 1, total_tokens: 0 },
    { prompt_tokens: 'x', completion_tokens: 1, total_tokens: 2 },
    {},
  ])
    assert.deepEqual(
      [chatUsage('xai', { usage: bad }).inputTokens, chatUsage('xai', { usage: bad }).outputTokens],
      [null, null],
    );
  // DeepSeek keeps its exact historical rule.
  assert.equal(
    chatUsage('deepseek', { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 16 } }).inputTokens,
    null,
  );
  assert.equal(
    chatUsage('deepseek', { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }).outputTokens,
    5,
  );
});

test('classification: only answers that prove nothing ran are definitely-not-billed; everything after a possible send is not', () => {
  assert.equal(statusFailure('xai', 429), 'XAI_RATE_LIMITED');
  assert.equal(statusFailure('gemini', 429), 'GEMINI_RATE_LIMITED');
  assert.equal(statusFailure('deepseek', 429), 'DEEPSEEK_RATE_LIMITED');
  assert.equal(statusFailure('gemini', 503), 'GEMINI_OVERLOADED');
  assert.equal(statusFailure('deepseek', 503), 'DEEPSEEK_OVERLOADED');
  assert.equal(
    statusFailure('xai', 503),
    'XAI_UNAVAILABLE',
    'xAI documents no overload code we could verify: stays an ordinary server error',
  );
  assert.equal(
    statusFailure('gemini', 400, '{"error":{"message":"User location is not supported for the API use."}}'),
    'GEMINI_REGION_UNSUPPORTED',
  );
  assert.equal(
    statusFailure('xai', 403, 'Access to this model is not available in your region'),
    'XAI_REGION_UNSUPPORTED',
  );
  assert.equal(statusFailure('gemini', 400, '{"error":{"message":"Invalid JSON payload"}}'), 'GEMINI_REQUEST_REJECTED');
  for (const code of [
    'XAI_RATE_LIMITED',
    'GEMINI_OVERLOADED',
    'GEMINI_REGION_UNSUPPORTED',
    'XAI_REGION_UNSUPPORTED',
    'DEEPSEEK_RATE_LIMITED',
    'MODEL_UNAVAILABLE',
    'PROVIDER_CONNECT_FAILED',
  ])
    assert.equal(isNotBilled(code), true, code);
  for (const code of [
    'XAI_UNAVAILABLE',
    'GEMINI_UNAVAILABLE',
    'DEEPSEEK_UNAVAILABLE',
    'GEMINI_REQUEST_REJECTED',
    'TEXT_NETWORK_ERROR',
    'TEXT_REQUEST_TIMEOUT',
    'INVALID_TEXT_RESPONSE',
    'INVALID_REPLY_JSON',
    'TEXT_INCOMPLETE_RESPONSE',
    'TEXT_CONTENT_REJECTED',
    null,
    undefined,
  ])
    assert.equal(isNotBilled(code as never), false, String(code));
  assert.ok(NOT_BILLED_CODES.size > 0);
  assert.equal(isPreSend('MODEL_UNAVAILABLE'), true);
  assert.equal(isPreSend('GEMINI_RATE_LIMITED'), false);
});

test('only a rejection that proves the connection never opened is a connect failure', () => {
  assert.equal(
    connectFailure(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }))?.code,
    'PROVIDER_CONNECT_FAILED',
  );
  assert.equal(
    connectFailure(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }))?.code,
    'PROVIDER_CONNECT_FAILED',
  );
  assert.equal(
    connectFailure(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })),
    null,
    'a reset may come after the send',
  );
  assert.equal(connectFailure(new TypeError('Network connection lost.')), null);
  assert.equal(connectFailure(null), null);
});

test('the pinned prompt/policy identity is untouched by the provider adapters (DeepSeek stays the policy)', () => {
  const policy = createTextGenerationPolicy();
  assert.equal(policy.provider, 'deepseek');
  assert.equal(policy.endpoint, 'https://api.deepseek.com/beta/chat/completions');
  assert.match(generationPolicyHash(policy), /^[a-f0-9]{64}$/);
  assert.match(textPromptHash(), /^[a-f0-9]{64}$/);
});

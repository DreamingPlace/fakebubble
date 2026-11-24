import test from 'node:test';
import assert from 'node:assert/strict';
import { DeepSeekTextGenerator } from '../../../apps/server/generation/deepseek.ts';
import { headRoute, textStageLimits } from '../../../apps/server/generation/text-stage-limits.ts';
import { textPolicyHash } from '../../../apps/server/generation/text-generation-policy.ts';
import { acceptedAuditEnvelope, draftEnvelope, textRequest } from '../../text-fixtures.ts';
import type { ProviderCallSpec, ProviderMeter } from '../../../packages/contracts/provider-calls.ts';
import type { TextRoute } from '../../../packages/contracts/text-route.ts';

/** Part 54: what the business object reserves BEFORE the call must be exactly what the generator would reserve itself. */
async function reserved(route?: TextRoute) {
  const specs: ProviderCallSpec[] = [];
  const meter: ProviderMeter = {
    reserve: (calls) => {
      specs.push(...calls);
      return { start: () => ({ finish() {} }), close() {} };
    },
  };
  const request = textRequest();
  const generator = new DeepSeekTextGenerator({
    apiKey: 'offline-only',
    keys: { xai: 'offline-only', gemini: 'offline-only' },
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init!.body));
      return Response.json(body.tools[0].function.name === 'submit_dialogue_draft' ? draftEnvelope(request) : acceptedAuditEnvelope(request));
    },
  });
  await generator.generateAcceptedStages(request, AbortSignal.timeout(5000), async () => {}, meter, route);
  return { specs, request };
}

test('the stage limits reserved by the business object equal what the generator reserves (DeepSeek, no route)', async () => {
  const { specs, request } = await reserved();
  const limits = textStageLimits(request, undefined, true);
  for (const stage of ['draft', 'review'] as const) {
    const spec = specs.find((s) => s.stage === stage)!;
    assert.equal(spec.bounds.unit, 'tokens');
    if (spec.bounds.unit !== 'tokens') return;
    assert.deepEqual(
      { provider: spec.provider, model: spec.model, inputTokens: spec.bounds.inputTokens, outputTokens: spec.bounds.outputTokens },
      limits[stage],
    );
  }
});

test('the stage limits for a route head on another provider carry the reasoning headroom', () => {
  const route: TextRoute = {
    draft: [{ provider: 'gemini', model: 'gemini-3.5-flash' }],
    review: [{ provider: 'deepseek', model: 'deepseek-v4-flash' }],
  };
  const limits = textStageLimits(textRequest(), route, true);
  assert.equal(limits.draft!.provider, 'gemini');
  // Gemini bills reasoning as output: the hold has the headroom on top of the visible reply.
  assert.ok(limits.draft!.outputTokens > limits.review.outputTokens);
});

test('with a known draft only the review is reserved; a route is cut to the head of each chain', () => {
  const limits = textStageLimits(textRequest(), undefined, false);
  assert.equal(limits.draft, null);
  assert.ok(limits.review.inputTokens > 0);
  const route: TextRoute = {
    draft: [
      { provider: 'xai', model: 'a' },
      { provider: 'deepseek', model: 'b' },
    ],
    review: [{ provider: 'deepseek', model: 'c' }],
  };
  assert.deepEqual(headRoute(route), { draft: [{ provider: 'xai', model: 'a' }], review: [{ provider: 'deepseek', model: 'c' }] });
  assert.equal(headRoute(undefined), undefined);
});

test('the per-call timeout is not part of the policy: every policy hash is unchanged', () => {
  const plain = new DeepSeekTextGenerator({ apiKey: 'offline-only' });
  const limited = new DeepSeekTextGenerator({ apiKey: 'offline-only', callTimeoutMs: 1234 });
  assert.equal(limited.policyHash, plain.policyHash);
  assert.equal(limited.writerPolicyHash, plain.writerPolicyHash);
  assert.equal(limited.writerProfilePolicyHash, plain.writerProfilePolicyHash);
  assert.equal(limited.writerMemesPolicyHash, plain.writerMemesPolicyHash);
  assert.equal(plain.policyHash, textPolicyHash());
  assert.equal(limited.timeoutMs, 90_000);
});

test('a provider call that never answers is interrupted at the per-call limit and reported as a timeout', async () => {
  const observed: { outcome: string; errorCode: string | null }[] = [];
  const meter: ProviderMeter = {
    reserve: () => ({
      start: () => ({
        finish(value) {
          observed.push({ outcome: value.outcome, errorCode: value.errorCode });
        },
      }),
      close() {},
    }),
  };
  const generator = new DeepSeekTextGenerator({
    apiKey: 'offline-only',
    callTimeoutMs: 50,
    fetch: (_url, init) =>
      new Promise((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      }),
  });
  const started = Date.now();
  await assert.rejects(generator.generateAcceptedStages(textRequest(), new AbortController().signal, async () => {}, meter), /TEXT_REQUEST_TIMEOUT/);
  assert.ok(Date.now() - started < 2000);
  assert.deepEqual(observed, [{ outcome: 'interrupted', errorCode: 'TEXT_REQUEST_TIMEOUT' }]);
});

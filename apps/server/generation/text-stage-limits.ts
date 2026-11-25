import type { TextGenerationRequest } from '../../../packages/contracts/index.ts';
import type { TextRoute } from '../../../packages/contracts/text-route.ts';
import type { WebStageLimit } from '../../../packages/contracts/web-generation-rpc.ts';
import { DEEPSEEK_INPUT_RESERVATION } from './deepseek-usage.ts';
import { createTextGenerationPolicy } from './text-generation-policy.ts';
import { outputBound } from './text-wire.ts';
import { WRITER_V8_MAX_TOKENS } from './writer-v8.ts';

/**
 * Part 54: what the business object reserves for the text stages of one reply, BEFORE it calls generation. These are the same
 * bounds DeepSeekTextGenerator.run reserves for the first model of each stage (a test pins the two together), so a reservation
 * made here is an upper bound of anything the generator may send. The input bound comes from the size of the frozen request (see inputBound);
 * the call is settled at its real usage.
 */
/**
 * The prompt is built from the frozen request plus fixed templates, and a token never costs more than one byte, so the request
 * size bounds the input: 4 x the request JSON + 100 kB of templates and tools (the review adds the draft: + 60 kB). Generation
 * REFUSES a call whose body is larger than its limit before sending (WEB_PROVIDER_STAGE_INVALID), so the hold is always an upper bound.
 */
const inputBound = (request: unknown, stage: 'draft' | 'review') =>
  Math.min(
    DEEPSEEK_INPUT_RESERVATION,
    4 * Buffer.byteLength(JSON.stringify(request), 'utf8') + 100_000 + (stage === 'review' ? 60_000 : 0),
  );
export function textStageLimits(
  request: TextGenerationRequest,
  route: TextRoute | undefined,
  withDraft: boolean,
): { draft: WebStageLimit | null; review: WebStageLimit } {
  const policy = createTextGenerationPolicy();
  const limit = (stage: 'draft' | 'review'): WebStageLimit => {
    const head = route?.[stage][0] ?? { provider: 'deepseek' as const, model: policy.stages[stage].model };
    const visible =
      stage === 'draft'
        ? request.writer === 'v8'
          ? WRITER_V8_MAX_TOKENS
          : policy.stages.draft.max_tokens
        : policy.stages.review.max_tokens;
    return {
      provider: head.provider,
      model: head.model,
      inputTokens: inputBound(request, stage),
      outputTokens: outputBound(head.provider, visible),
    };
  };
  return { draft: withDraft ? limit('draft') : null, review: limit('review') };
}

/** One model per stage: the head of each chain. The rest of a chain is a NEW call with a new reservation. */
export function headRoute(route: TextRoute | undefined): TextRoute | undefined {
  return route && { draft: route.draft.slice(0, 1), review: route.review.slice(0, 1) };
}

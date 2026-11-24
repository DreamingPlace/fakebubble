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
 * made here is an upper bound of anything the generator may send. The input bound is not tightened by the request size (the
 * request does not exist yet: the review's prompt contains the draft); the call is settled at its real usage.
 */
export function textStageLimits(
  request: Pick<TextGenerationRequest, 'writer'>,
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
      inputTokens: DEEPSEEK_INPUT_RESERVATION,
      outputTokens: outputBound(head.provider, visible),
    };
  };
  return { draft: withDraft ? limit('draft') : null, review: limit('review') };
}

/** One model per stage: the head of each chain. The rest of a chain is a NEW call with a new reservation. */
export function headRoute(route: TextRoute | undefined): TextRoute | undefined {
  return route && { draft: route.draft.slice(0, 1), review: route.review.slice(0, 1) };
}

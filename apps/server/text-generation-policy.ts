import { createHash } from 'node:crypto';
import { ensure } from '../../packages/domain/errors.ts';
import { DEFAULT_TEXT_MODELS, DEFAULT_TEXT_LIMITS, SUPPORTED_TEXT_MODELS } from './config.ts';
import { textPromptHash } from './text-prompt.ts';
import { textPromptHash as acceptedPromptHash } from './accepted-text-prompt.ts';
import { TEXT_PROTOCOL_VERSION } from './text-protocol.ts';
import { TEXT_PROTOCOL_VERSION as ACCEPTED_PROTOCOL_VERSION } from './accepted-text-protocol.ts';

export interface TextGenerationPolicyOptions {
  model?: string; reviewModel?: string; timeoutMs?: number; maxTokens?: number; reviewMaxTokens?: number;
  textProtocol?: 'accepted-v7' | 'experimental-v10';
}
type StagePolicy = Readonly<{
  model: string; thinking: Readonly<{ type: 'enabled' | 'disabled' }>; reasoning_effort?: 'high';
  // Bind the forced choice to the actual output schema, never a second copy of its function name.
  tool_choice: 'required-output-tool' | 'auto'; stream: false; max_tokens: number;
}>;
export interface TextGenerationPolicy {
  readonly provider: 'deepseek'; readonly endpoint: string;
  readonly textProtocol: 'accepted-v7' | 'experimental-v10'; readonly protocolVersion: string;
  readonly promptHash: string; readonly timeoutMs: number;
  readonly stages: Readonly<{ draft: StagePolicy; review: StagePolicy }>;
}

/** Resolve once: transport, capacity reservations and approval hashing share this immutable policy. */
export function createTextGenerationPolicy(options: TextGenerationPolicyOptions = {}): TextGenerationPolicy {
  const textProtocol = options.textProtocol ?? 'experimental-v10', accepted = textProtocol === 'accepted-v7';
  ensure(accepted || textProtocol === 'experimental-v10', 'INVALID_TEXT_PROTOCOL');
  const model = options.model ?? DEFAULT_TEXT_MODELS.draft, reviewModel = options.reviewModel ?? DEFAULT_TEXT_MODELS.review;
  ensure([model, reviewModel].every(model => SUPPORTED_TEXT_MODELS.some(id => id === model)), 'UNSUPPORTED_DEEPSEEK_MODEL');
  const timeoutMs = options.timeoutMs ?? (accepted ? 90_000 : DEFAULT_TEXT_LIMITS.timeoutMs);
  const maxTokens = options.maxTokens ?? (accepted ? 4096 : DEFAULT_TEXT_LIMITS.draft);
  ensure(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120_000, 'INVALID_TEXT_TIMEOUT');
  ensure(Number.isSafeInteger(maxTokens) && maxTokens > 0 && maxTokens <= 4096, 'INVALID_TEXT_TOKEN_LIMIT');
  ensure(!accepted || options.reviewMaxTokens === undefined || options.reviewMaxTokens === maxTokens, 'INVALID_TEXT_TOKEN_LIMIT');
  const reviewLimit = accepted ? maxTokens : options.reviewMaxTokens ?? DEFAULT_TEXT_LIMITS.review;
  ensure(Number.isSafeInteger(reviewLimit) && reviewLimit > 0 && reviewLimit <= 16384, 'INVALID_TEXT_TOKEN_LIMIT');
  // The original explicit QA ceiling constrains both calls, including experimental review.
  const reviewMaxTokens = Math.min(reviewLimit, options.maxTokens ?? reviewLimit);
  const stage = (model: string, max_tokens: number, thinking: boolean): StagePolicy => Object.freeze({ model,
    thinking: Object.freeze({ type: thinking ? 'enabled' : 'disabled' }),
    ...(thinking ? { reasoning_effort: 'high' as const } : {}),
    tool_choice: thinking ? 'auto' : 'required-output-tool', stream: false, max_tokens });
  return Object.freeze({ provider: 'deepseek', endpoint: 'https://api.deepseek.com/beta/chat/completions', textProtocol,
    protocolVersion: accepted ? ACCEPTED_PROTOCOL_VERSION : TEXT_PROTOCOL_VERSION,
    promptHash: (accepted ? acceptedPromptHash : textPromptHash)(), timeoutMs,
    stages: Object.freeze({ draft: stage(model, maxTokens, false), review: stage(reviewModel, reviewMaxTokens, !accepted) }) });
}

// Hash the complete resolved policy, not a manually selected subset of its request fields.
export const generationPolicyHash = (policy: TextGenerationPolicy) => createHash('sha256').update(JSON.stringify(policy)).digest('hex');
export const textPolicyHash = (options: TextGenerationPolicyOptions = {}) => generationPolicyHash(createTextGenerationPolicy(options));

export function textRequestParameters(policy: TextGenerationPolicy, stage: 'draft' | 'review', outputToolName: string) {
  const { tool_choice, ...parameters } = policy.stages[stage];
  return { ...parameters, tool_choice: tool_choice === 'required-output-tool'
    ? { type: 'function' as const, function: { name: outputToolName } } : tool_choice };
}

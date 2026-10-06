import { createHash } from 'node:crypto';
import { ensure } from '../../packages/domain/errors.ts';
import { DEFAULT_TEXT_MODELS, SUPPORTED_TEXT_MODELS } from './config.ts';
import { textPromptHash } from './accepted-text-prompt.ts';
import { TEXT_PROTOCOL_VERSION } from './accepted-text-protocol.ts';

export interface TextGenerationPolicyOptions {
  model?: string;
  reviewModel?: string;
  timeoutMs?: number;
  maxTokens?: number;
  reviewMaxTokens?: number;
}
type StagePolicy = Readonly<{
  model: string;
  thinking: Readonly<{ type: 'disabled' }>;
  // Bind the forced choice to the actual output schema, never a second copy of its function name.
  tool_choice: 'required-output-tool';
  stream: false;
  max_tokens: number;
}>;
export interface TextGenerationPolicy {
  readonly provider: 'deepseek';
  readonly endpoint: string;
  readonly textProtocol: 'accepted-v7';
  readonly protocolVersion: string;
  readonly promptHash: string;
  readonly timeoutMs: number;
  readonly stages: Readonly<{ draft: StagePolicy; review: StagePolicy }>;
}

/** Resolve once: transport, capacity reservations and approval hashing share this immutable policy. */
export function createTextGenerationPolicy(options: TextGenerationPolicyOptions = {}): TextGenerationPolicy {
  const model = options.model ?? DEFAULT_TEXT_MODELS.draft,
    reviewModel = options.reviewModel ?? DEFAULT_TEXT_MODELS.review;
  ensure(
    [model, reviewModel].every((model) => SUPPORTED_TEXT_MODELS.some((id) => id === model)),
    'UNSUPPORTED_DEEPSEEK_MODEL',
  );
  const timeoutMs = options.timeoutMs ?? 90_000;
  const maxTokens = options.maxTokens ?? 4096;
  ensure(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120_000, 'INVALID_TEXT_TIMEOUT');
  ensure(Number.isSafeInteger(maxTokens) && maxTokens > 0 && maxTokens <= 4096, 'INVALID_TEXT_TOKEN_LIMIT');
  ensure(options.reviewMaxTokens === undefined || options.reviewMaxTokens === maxTokens, 'INVALID_TEXT_TOKEN_LIMIT');
  const stage = (model: string): StagePolicy =>
    Object.freeze({
      model,
      thinking: Object.freeze({ type: 'disabled' }),
      tool_choice: 'required-output-tool',
      stream: false,
      max_tokens: maxTokens,
    });
  return Object.freeze({
    provider: 'deepseek',
    endpoint: 'https://api.deepseek.com/beta/chat/completions',
    textProtocol: 'accepted-v7',
    protocolVersion: TEXT_PROTOCOL_VERSION,
    promptHash: textPromptHash(),
    timeoutMs,
    stages: Object.freeze({
      draft: stage(model),
      review: stage(reviewModel),
    }),
  });
}

// Hash the complete resolved policy, not a manually selected subset of its request fields.
export const generationPolicyHash = (policy: TextGenerationPolicy) =>
  createHash('sha256').update(JSON.stringify(policy)).digest('hex');
export const textPolicyHash = (options: TextGenerationPolicyOptions = {}) =>
  generationPolicyHash(createTextGenerationPolicy(options));

export function textRequestParameters(policy: TextGenerationPolicy, stage: 'draft' | 'review', outputToolName: string) {
  const { tool_choice: _toolChoice, ...parameters } = policy.stages[stage];
  return { ...parameters, tool_choice: { type: 'function' as const, function: { name: outputToolName } } };
}

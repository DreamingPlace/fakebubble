import type { ProviderObservation, ProviderUsage } from '../../packages/contracts/provider-calls.ts';

// The currently supported V4 models advertise 1M context. Reserve the conservative 2^20 ceiling,
// not a guessed text/token ratio. Recheck this bound before adding another model family.
export const DEEPSEEK_INPUT_RESERVATION = 1_048_576;
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000_000;
const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
export function deepSeekUsage(value: unknown): ProviderUsage & { unit: 'tokens' } {
  const usage = record(record(value).usage), input = usage.prompt_tokens, output = usage.completion_tokens, total = usage.total_tokens;
  const consistent = count(input) && count(output) && count(total) && input + output === total;
  const inputTokens = consistent ? input : null, outputTokens = consistent ? output : null;
  const hit = usage.prompt_cache_hit_tokens, miss = usage.prompt_cache_miss_tokens;
  const validSplit = inputTokens !== null && (hit == null || count(hit) && hit <= inputTokens) && (miss == null || count(miss) && miss <= inputTokens) &&
    (hit == null || miss == null || Number(hit) + Number(miss) === inputTokens);
  return { unit: 'tokens', inputTokens, outputTokens, cacheHitInputTokens: validSplit && count(hit) ? hit : null, cacheMissInputTokens: validSplit && count(miss) ? miss : null };
}
export function deepSeekObservation(value: unknown, outcome: ProviderObservation['outcome'], errorCode: string | null): ProviderObservation {
  const v = record(value);
  return { outcome, errorCode, usage: deepSeekUsage(v),
    providerRequestId: typeof v.id === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(v.id) ? v.id : null,
    reportedModel: typeof v.model === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(v.model) ? v.model : null };
}

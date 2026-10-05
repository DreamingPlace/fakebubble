import { ensure } from '../../packages/domain/errors.ts';

// deepseek-flash was returned by the official /models endpoint on 2026-09-10.
// Retain the older alias for existing explicit configurations; no temporary expiry IDs.
export const SUPPORTED_TEXT_MODELS = ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-pro'] as const;
export const DEFAULT_TEXT_MODELS = Object.freeze({ draft: 'deepseek-flash', review: 'deepseek-v4-pro' });
export interface TextGenerationLimits {
  draft: number;
  review: number;
  timeoutMs: number;
}
export const DEFAULT_TEXT_LIMITS: Readonly<TextGenerationLimits> = Object.freeze({
  draft: 4096,
  review: 16384,
  timeoutMs: 90_000,
});

/** Safe diagnostics only: never return the API key or auto-load an env file. */
export function textConfiguration(env: NodeJS.ProcessEnv = process.env) {
  const provider = env.TEXT_PROVIDER || 'deepseek';
  ensure(provider === 'deepseek', 'UNSUPPORTED_TEXT_PROVIDER');
  let baseUrl: URL;
  try {
    baseUrl = new URL(env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com');
  } catch {
    ensure(false, 'INVALID_TEXT_BASE_URL');
  }
  ensure(
    baseUrl.protocol === 'https:' && !baseUrl.username && !baseUrl.password && !baseUrl.search && !baseUrl.hash,
    'INVALID_TEXT_BASE_URL',
  );
  const model = env.DEEPSEEK_MODEL || DEFAULT_TEXT_MODELS.draft;
  const reviewModel = env.DEEPSEEK_REVIEW_MODEL || DEFAULT_TEXT_MODELS.review;
  ensure(
    [model, reviewModel].every((value) => SUPPORTED_TEXT_MODELS.some((id) => id === value)),
    'INVALID_TEXT_MODEL',
  );
  return {
    provider,
    baseUrl: baseUrl.toString().replace(/\/$/, ''),
    model,
    reviewModel,
    credentialConfigured: Boolean(env.DEEPSEEK_API_KEY?.trim()),
    liveVerified: false as const,
  };
}

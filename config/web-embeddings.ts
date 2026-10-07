import { DomainError } from '../packages/domain/errors.ts';

/**
 * Embedding calls are a separate stage from text and audio: they have their own concurrency limit and a short
 * reply-time budget. Values come from Worker vars or the local instance config, never from code.
 */
export interface WebEmbedConfig {
  /** Embedding calls in flight at once (memory indexing and reply-time query embedding together). */
  readonly maxEmbedRunning: number;
  /** A reply waits at most this long for its query embedding, then continues with lexical recall only. */
  readonly queryTimeoutMs: number;
}

export const WEB_EMBED_BOUNDS = Object.freeze({
  maxEmbedRunning: { min: 1, max: 16 },
  queryTimeoutMs: { min: 200, max: 10_000 },
});
export const WEB_EMBED_DEFAULT: WebEmbedConfig = Object.freeze({ maxEmbedRunning: 2, queryTimeoutMs: 3_000 });

type Raw = Partial<Record<keyof WebEmbedConfig, unknown>>;

function integer(name: string, value: unknown, bounds: { min: number; max: number }, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = typeof value === 'string' && /^[0-9]{1,6}$/.test(value) ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < bounds.min || parsed > bounds.max)
    throw new DomainError(`WEB_EMBED_CONFIG_INVALID_${name}`);
  return parsed;
}

/** Anything present but invalid refuses to start; missing values take the default. */
export function parseWebEmbedConfig(raw: Raw | undefined): WebEmbedConfig {
  if (raw === undefined) return WEB_EMBED_DEFAULT;
  return Object.freeze({
    maxEmbedRunning: integer('RUNNING', raw.maxEmbedRunning, WEB_EMBED_BOUNDS.maxEmbedRunning, 2),
    queryTimeoutMs: integer('QUERY_TIMEOUT', raw.queryTimeoutMs, WEB_EMBED_BOUNDS.queryTimeoutMs, 3_000),
  });
}

/** Worker vars are strings: MAX_EMBED_RUNNING and EMBED_QUERY_TIMEOUT_MS. */
export function webEmbedConfigFromEnv(env: Record<string, unknown>): WebEmbedConfig {
  return parseWebEmbedConfig({ maxEmbedRunning: env.MAX_EMBED_RUNNING, queryTimeoutMs: env.EMBED_QUERY_TIMEOUT_MS });
}

/** Embeddings stay off unless the deployment says 'true' (the generation Worker repeats the check). */
export const embeddingsEnabled = (env: Record<string, unknown>) => env.EMBEDDINGS_ENABLED === 'true';

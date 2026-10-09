import { DomainError } from '../packages/domain/errors.ts';

/** Deployment-tunable concurrency. Values come from Worker vars or the local instance config, never from code. */
export interface WebConcurrency {
  readonly maxTextRunning: number;
  readonly maxAudioRunning: number;
  /** Operations that may wait behind the running ones. */
  readonly maxWaitingOperations: number;
  /**
   * One ticket per nonterminal operation, including running stages:
   * maxGlobalReservedOperations = maxTextRunning + maxAudioRunning + maxWaitingOperations.
   */
  readonly maxGlobalReservedOperations: number;
  /** A voice request that cannot get an audio slot within this wait is published as text. */
  readonly audioFallbackWaitMs: number;
}

export const WEB_CONCURRENCY_BOUNDS = Object.freeze({
  text: { min: 1, max: 64 },
  audio: { min: 1, max: 48 },
  waiting: { min: 1, max: 4096 },
  audioFallbackWaitMs: { min: 1_000, max: 60_000 },
});

function build(text: number, audio: number, waiting: number, fallbackMs: number): WebConcurrency {
  return Object.freeze({
    maxTextRunning: text,
    maxAudioRunning: audio,
    maxWaitingOperations: waiting,
    maxGlobalReservedOperations: text + audio + waiting,
    audioFallbackWaitMs: fallbackMs,
  });
}

/** What a deployment gets when it sets nothing: Fish starter allows 5 concurrent requests, DeepSeek hundreds. */
export const WEB_CONCURRENCY_DEPLOYMENT_DEFAULT = build(20, 4, 104, 8_000);
/**
 * Fallback for a store constructed without any configuration (offline fixtures, library use). It keeps the
 * limits the stage-queue tests were written against: 4 + 4 running and 120 waiting = 128 tickets.
 */
export const WEB_CONCURRENCY_LIBRARY_DEFAULT = build(4, 4, 120, 8_000);

type Raw = Partial<
  Record<'maxTextRunning' | 'maxAudioRunning' | 'maxWaitingOperations' | 'audioFallbackWaitMs', unknown>
>;

function integer(name: string, value: unknown, bounds: { min: number; max: number }, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = typeof value === 'string' && /^[0-9]{1,6}$/.test(value) ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < bounds.min || parsed > bounds.max)
    throw new DomainError(`WEB_CONCURRENCY_INVALID_${name}`);
  return parsed;
}

/** Validate configured values; anything present but invalid refuses to start. Missing values take the deployment default. */
export function parseWebConcurrency(raw: Raw | undefined): WebConcurrency {
  const d = WEB_CONCURRENCY_DEPLOYMENT_DEFAULT;
  if (raw === undefined) return d;
  return build(
    integer('TEXT', raw.maxTextRunning, WEB_CONCURRENCY_BOUNDS.text, d.maxTextRunning),
    integer('AUDIO', raw.maxAudioRunning, WEB_CONCURRENCY_BOUNDS.audio, d.maxAudioRunning),
    integer('WAITING', raw.maxWaitingOperations, WEB_CONCURRENCY_BOUNDS.waiting, d.maxWaitingOperations),
    integer(
      'FALLBACK_WAIT',
      raw.audioFallbackWaitMs,
      WEB_CONCURRENCY_BOUNDS.audioFallbackWaitMs,
      d.audioFallbackWaitMs,
    ),
  );
}

/** Worker vars are strings: MAX_TEXT_RUNNING, MAX_AUDIO_RUNNING, MAX_WAITING_OPERATIONS, AUDIO_FALLBACK_WAIT_MS. */
export function webConcurrencyFromEnv(env: Record<string, unknown>): WebConcurrency {
  return parseWebConcurrency({
    maxTextRunning: env.MAX_TEXT_RUNNING,
    maxAudioRunning: env.MAX_AUDIO_RUNNING,
    maxWaitingOperations: env.MAX_WAITING_OPERATIONS,
    audioFallbackWaitMs: env.AUDIO_FALLBACK_WAIT_MS,
  });
}

/** The one reader every stage scheduler uses. A store without configuration keeps the library default. */
export function webConcurrency(store: object): WebConcurrency {
  return (store as { concurrency?: WebConcurrency }).concurrency ?? WEB_CONCURRENCY_LIBRARY_DEFAULT;
}

/**
 * Player-initiated replies one invited player may have accepted per rolling 24 hours (Worker var DAILY_REPLY_LIMIT,
 * local-config.json `dailyReplyLimit`). Kept apart from WebConcurrency: it is an admission quota, not a stage slot.
 */
export const WEB_DAILY_REPLY_LIMIT = Object.freeze({ min: 1, max: 10_000, default: 100 });

/** Absent takes the default; anything present but not an integer in range refuses to start. */
export function parseWebDailyReplyLimit(raw: unknown): number {
  return integer('DAILY_REPLY_LIMIT', raw, WEB_DAILY_REPLY_LIMIT, WEB_DAILY_REPLY_LIMIT.default);
}
export function webDailyReplyLimitFromEnv(env: Record<string, unknown>): number {
  return parseWebDailyReplyLimit(env.DAILY_REPLY_LIMIT);
}
/** The one reader admission uses. A store without configuration keeps the default. */
export function webDailyReplyLimit(store: object): number {
  return (store as { dailyReplyLimit?: number }).dailyReplyLimit ?? WEB_DAILY_REPLY_LIMIT.default;
}

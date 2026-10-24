import { createHash } from 'node:crypto';
import { PROMPTS_CAST } from './cast-prompts.generated.ts';

/**
 * Part 24a: the two prompt files a request carrying `cast` is read with. They are NOT part of PROMPTS_V7 / textPromptHash(), so
 * every request without `cast` keeps its prompt bytes, its prompt hash and the protocol fingerprint. A request WITH `cast` records
 * castPromptHash() inside request.cast, so its request digest covers these two files.
 */
export const CAST_CONTEXT_PROMPT = PROMPTS_CAST.castContext;
export const CAST_REVIEW_PROMPT = PROMPTS_CAST.castReview;

export const castPromptHash = () =>
  createHash('sha256')
    .update(JSON.stringify(Object.entries(PROMPTS_CAST).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))))
    .digest('hex');

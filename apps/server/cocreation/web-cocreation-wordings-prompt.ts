import { createHash } from 'node:crypto';
import { PROMPTS_TIDY } from '../generation/tidy-prompts.generated.ts';

/**
 * Part 39b: the ONE system prompt of 生成 (the wording pool's text call) and its pin. The business object sends exactly this text and the
 * generation Worker accepts it (text AND hash) on its plain-completion route next to the clip-direction and the 整理 prompts. Changing
 * prompts/v7/tidy-cocreation-wordings.md changes the hash on purpose, in tests/web/unit/web-cocreation-39b.test.ts. Documented in
 * docs/STATUS.md (Part 39b).
 */
export const COCREATION_WORDINGS_PROMPT = PROMPTS_TIDY.tidyCocreationWordings;
/** sha256 of prompts/v7/tidy-cocreation-wordings.md (the file, with its newline). */
export const COCREATION_WORDINGS_PROMPT_SHA256 = 'f6495434176292d51259a0ae1d56ee942f4358b4850fd2d49c56d25c41fbf8a8';
export const cocreationWordingsHash = (prompt: string = COCREATION_WORDINGS_PROMPT) =>
  createHash('sha256').update(`${prompt}\n`).digest('hex');

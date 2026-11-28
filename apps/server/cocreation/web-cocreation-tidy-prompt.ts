import { createHash } from 'node:crypto';
import { PROMPTS_TIDY } from '../generation/tidy-prompts.generated.ts';

/**
 * Part 39: the ONE system prompt of 整理 and its pin. The business object sends exactly this text and the generation Worker accepts
 * it (text AND hash) on its plain-completion route next to the clip-direction prompt. Changing prompts/v7/tidy-cocreation-task.md
 * changes the hash on purpose, in tests/web/unit/web-cocreation-39.test.ts. Documented in docs/STATUS.md (Part 39).
 */
export const COCREATION_TIDY_PROMPT = PROMPTS_TIDY.tidyCocreationTask;
/** sha256 of prompts/v7/tidy-cocreation-task.md (the file, with its newline). */
export const COCREATION_TIDY_PROMPT_SHA256 = '2d7e393e61889db142f80b33968f2890e9fcab017659e807c6c545f0b387bc64';
export const cocreationTidyHash = (prompt: string = COCREATION_TIDY_PROMPT) =>
  createHash('sha256').update(`${prompt}\n`).digest('hex');

import { createHash } from 'node:crypto';
import { PROMPTS_CLIP } from '../generation/clip-prompts.generated.ts';

/**
 * Part 30: the ONE system prompt of 按反馈重录 and its pin. The business object sends exactly this text and the generation Worker
 * accepts nothing else on its plain-completion route (it checks the text AND the hash). Changing prompts/v7/clip-direction-task.md
 * changes the hash on purpose, in tests/web/unit/web-clip-takes-30.test.ts.
 */
export const CLIP_DIRECTION_PROMPT = PROMPTS_CLIP.clipDirectionTask;
/** sha256 of prompts/v7/clip-direction-task.md (the file, with its newline). */
export const CLIP_DIRECTION_PROMPT_SHA256 = 'c8b0ce6a1107d754adac4b15054666fbab8f4ad44a3d6fdc4f77cb94403d9a4f';
export const clipPromptHash = (prompt: string = CLIP_DIRECTION_PROMPT) =>
  createHash('sha256').update(`${prompt}\n`).digest('hex');

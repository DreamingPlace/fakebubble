import { PROMPTS_SEED } from './seed-prompts.generated.ts';

/**
 * Part 24c: the two prompt files a seed character ("成长中", template.seed === true) is read with. They are NOT part of PROMPTS_V7 /
 * textPromptHash() and are appended only when the frozen template carries the flag, so every request for any other character keeps
 * its prompt bytes and its hash. Both files are pinned by their sha256 in tests/web/unit/web-seed-character.test.ts.
 */
export const SEED_CHARACTER_PROMPT = PROMPTS_SEED.seedCharacter;
export const SEED_REVIEW_PROMPT = PROMPTS_SEED.seedReview;

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { GENERATED_PROMPTS, renderPromptsModule } from '../../../scripts/build-prompts.ts';

test('prompts.generated.ts is up to date with prompts/v7/*.md (run pnpm prompts:build)', () => {
  assert.equal(readFileSync(GENERATED_PROMPTS, 'utf8'), renderPromptsModule());
});

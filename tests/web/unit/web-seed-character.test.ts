import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  promptMessages,
  reviewPromptMessages,
  textPromptHash,
} from '../../../apps/server/generation/accepted-text-prompt.ts';
import { PROMPTS_SEED } from '../../../apps/server/generation/seed-prompts.generated.ts';
import { SEED_CHARACTER_PROMPT, SEED_REVIEW_PROMPT } from '../../../apps/server/generation/seed-prompt.ts';
import { renderPromptsModule, renderSeedPromptsModule } from '../../../scripts/build-prompts.ts';
import { validatedTemplate } from '../../../apps/server/characters/template-validation.ts';
import { characterProfileHash } from '../../../apps/server/characters/web-character-catalog.ts';
import { emptyCharacter, editedCharacter } from '../../../apps/player-web/src/features/admin/character-form.ts';
import { promptSnapshotCases } from '../fixtures/prompt-snapshot-cases.ts';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const [first] = promptSnapshotCases();
const seeded = (request = first!.request) => ({ ...request, character: { ...request.character, seed: true as const } });

test('seed prompts: generated from prompts/v7/seed-*.md, separate from PROMPTS_V7, and pinned', () => {
  assert.equal(
    readFileSync(new URL('../../../apps/server/generation/seed-prompts.generated.ts', import.meta.url), 'utf8'),
    renderSeedPromptsModule(),
  );
  assert.deepEqual(Object.keys(PROMPTS_SEED), ['seedCharacter', 'seedReview']);
  // The chat prompt module does not carry them, so textPromptHash() and every pinned chat hash are what they were.
  assert.equal(renderPromptsModule().includes('seedCharacter'), false);
  assert.equal(textPromptHash().includes('seed'), false);
  // Part 24c: pinned on purpose - the only pinned hashes that change in this Part are these two new files.
  assert.equal(sha(SEED_CHARACTER_PROMPT), 'b528d62786266935aca0755ae1bead0019dddfd70b6d72e2e16587f1f9f59b6d');
  assert.equal(sha(SEED_REVIEW_PROMPT), '8c5d7594bb16ff8bed93d6f6861336944d11fcfa25a3feb756114f8fef7fd063');
  // The three rules: no invented facts, light/vague or ask the player, never contradict what IS set - and the word 共创 is never said.
  for (const marker of ['不当成事实编出', '说得轻、说得模糊', '你觉得呢', '绝不违背'])
    assert.ok(SEED_CHARACTER_PROMPT.includes(marker), marker);
  assert.equal(SEED_CHARACTER_PROMPT.includes('共创'), false);
  // The reviewer addendum is ONE line (after the leading newline every prompt block starts with).
  assert.equal(SEED_REVIEW_PROMPT.trim().split('\n').length, 1);
  assert.ok(SEED_REVIEW_PROMPT.includes('当成确定的事实'));
});

test('seed character: the prompt is appended only when the frozen template says seed', () => {
  const off = promptMessages(first!.request);
  const on = promptMessages(seeded());
  assert.equal(off[0]!.content.includes(SEED_CHARACTER_PROMPT), false);
  assert.equal(on[0]!.content, off[0]!.content + SEED_CHARACTER_PROMPT);
  // The user message differs by nothing but nothing: the flag is not in the JSON the model reads.
  assert.equal(on[1]!.content, off[1]!.content);
  // Appended last, after the draft system prompt (and after the cast block when there is one).
  assert.ok(on[0]!.content.endsWith(SEED_CHARACTER_PROMPT));
});

test('seed character: without the flag every request is byte-identical to main (all pinned snapshot requests)', () => {
  for (const item of promptSnapshotCases()) {
    for (const messages of [promptMessages(item.request), reviewPromptMessages(item.request, item.draft)]) {
      assert.equal(messages[0]!.content.includes(SEED_CHARACTER_PROMPT), false, item.name);
      assert.equal(messages[0]!.content.includes(SEED_REVIEW_PROMPT), false, item.name);
    }
    // seed:false / absent are the same request; only `true` changes anything.
    const explicit = { ...item.request, character: { ...item.request.character } };
    assert.deepEqual(promptMessages(explicit), promptMessages(item.request), item.name);
  }
});

test('seed character: the reviewer gets the one-line addendum, only for a seed character', () => {
  const draft = first!.draft;
  const off = reviewPromptMessages(first!.request, draft);
  const on = reviewPromptMessages(seeded(), draft);
  assert.equal(off[0]!.content.includes(SEED_REVIEW_PROMPT), false);
  assert.equal(on[0]!.content, off[0]!.content + SEED_REVIEW_PROMPT);
  assert.ok(on[0]!.content.includes('把character里没写明的事'));
});

test('seed character: the flag is part of the template (versioned with the profile), validated, and only ever `true`', () => {
  const plain = { ...emptyCharacter().template, id: 'x', name: 'n', persona: 'p' };
  const template = (extra: Record<string, unknown>) => ({ ...plain, ...extra });
  assert.equal(validatedTemplate(template({ seed: true })).seed, true);
  assert.equal('seed' in validatedTemplate(template({})), false);
  for (const bad of [false, 'yes', 1, null])
    assert.throws(() => validatedTemplate(template({ seed: bad })), /INVALID_TEMPLATE/);
  // The profile hash (what a draft, a preview and a publication are bound to) moves with the flag, so the flag is versioned and
  // published like the welcome; a profile without it hashes exactly as before.
  const base = emptyCharacter();
  base.template.id = 'x';
  const withSeed = structuredClone(base);
  withSeed.template.seed = true;
  assert.notEqual(characterProfileHash(withSeed), characterProfileHash(base));
  assert.equal(characterProfileHash(base), characterProfileHash(structuredClone(base)));
});

test('seed character: the editor sets and clears the flag and leaves other profiles untouched', () => {
  const values = (over: Record<string, unknown> = {}) => ({
    id: 'x',
    name: 'n',
    birthDate: '',
    persona: 'p',
    displayName: 'd',
    publicDescription: '',
    welcomeText: 'w',
    welcomeVersion: 'welcome-v1',
    canon: '{}',
    voice: null,
    ...over,
  });
  const base = emptyCharacter();
  assert.equal('seed' in editedCharacter(base, values()), false);
  assert.equal('seed' in editedCharacter(base, values({ seed: false })).template, false);
  const on = editedCharacter(base, values({ seed: true }));
  assert.equal(on.template.seed, true);
  assert.equal(editedCharacter(on, values()).template.seed, true, 'no opinion keeps what the base says');
  assert.equal('seed' in editedCharacter(on, values({ seed: false })).template, false);
});

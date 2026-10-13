import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { protocolFingerprint } from '../../../apps/server/generation/accepted-text-protocol.ts';
import { PROMPTS_V7 } from '../../../apps/server/generation/prompts.generated.ts';
import { textPromptHash } from '../../../apps/server/generation/accepted-text-prompt.ts';
import { createTextGenerationPolicy, textPolicyHash } from '../../../apps/server/generation/text-generation-policy.ts';

// Stored preview and publication approvals embed these hashes. Captured on main (66e2c6b) before the
// experimental-v10 protocol was removed: policy 58ba3f99…, prompt 8a49da0d…. Part 6a step 4 added the text-only
// player-channel rule on purpose, which changed both (policy ddbd9315…, prompt 687b0960…). Part 7a step A made the
// prompt hash cover every prompts/v7 file (policy ea400177…, prompt c0eaa2ff…); the protocol fingerprint was unchanged (6fa11440…).
// Part 7a step D added importance and memoryId to the review topics and their prompt text: policy 40d4c60d…, prompt
// dba98588…, fingerprint 4811a5ed…. Step E added factOps to the review output and its prompt text: policy 481388d9…,
// prompt dc5db072…, fingerprint b42431c9…. Step G added playerFacts to the prompt JSON and a content rule
// (prompt only; the fingerprint is unchanged): policy 9342e2c9…, prompt 619d6011…. Part 11b added the chat-boundary rules
// (help vs. tool abuse, in-character deflection, distress carve-out, slang) to both prompts plus the review's coverage
// mapping (prompt only; fingerprint unchanged): policy 2202ad5e…, prompt 7d0b0795…. Part 11e: persona voice, time restraint,
// reviewer keeps voice, AI-honesty line (prompt only; fingerprint unchanged): policy c1b35adf…, prompt 3e75a258….
// Part 16: characterLocalTime is the character's own clock (never the player's), no UTC currentTime in the model JSON, no invented
// shared history or live-game claims (prompt only; fingerprint unchanged): policy 2bd7b236…, prompt 00448e45….
// Part 18c (named exception, the only change to this file): the review's accept/reject rule is stated unambiguously
// (a rewrite is accept + replacementBubbles; reject only with no replacement) and both prompts carry the form-of-address
// rule (prompt only; fingerprint unchanged): policy e31c3518…, prompt 6519b6a0….
const POLICY_HASH = 'e31c3518fcf47ac3cb18a37b9cf42423b126977ccfd9258e2939c8b3d67652fb';
const PROMPT_HASH = '6519b6a05e5369b5f223d26d6215cfd6c656386890a685c5276945eb860fcd6f';
const FINGERPRINT_DIGEST = 'b42431c97a4cc92b10d8c7c215ead160884d9248397736216b5fc9273883ef99';

test('accepted-v7 policy hash, prompt hash and protocol fingerprint are pinned', () => {
  const policy = createTextGenerationPolicy();
  assert.equal(textPolicyHash(), POLICY_HASH);
  assert.equal(policy.textProtocol, 'accepted-v7');
  assert.equal(policy.protocolVersion, 'strict_draft_audit_v7_spoken_turn');
  assert.equal(policy.promptHash, PROMPT_HASH);
  assert.equal(createHash('sha256').update(JSON.stringify(protocolFingerprint())).digest('hex'), FINGERPRINT_DIGEST);
});

test('accepted-v7 resolved policy keeps its exact serialized shape and key order', () => {
  assert.equal(
    JSON.stringify(createTextGenerationPolicy()),
    `{"provider":"deepseek","endpoint":"https://api.deepseek.com/beta/chat/completions","textProtocol":"accepted-v7","protocolVersion":"strict_draft_audit_v7_spoken_turn","promptHash":"${PROMPT_HASH}","timeoutMs":90000,"stages":{"draft":{"model":"deepseek-flash","thinking":{"type":"disabled"},"tool_choice":"required-output-tool","stream":false,"max_tokens":4096},"review":{"model":"deepseek-v4-pro","thinking":{"type":"disabled"},"tool_choice":"required-output-tool","stream":false,"max_tokens":4096}}}`,
  );
});

test('the removed textProtocol option cannot select another protocol', () => {
  const policy = createTextGenerationPolicy({ textProtocol: 'experimental-v10' } as never);
  assert.equal(policy.textProtocol, 'accepted-v7');
  assert.equal(textPolicyHash({ textProtocol: 'experimental-v10' } as never), POLICY_HASH);
});

test('the prompt hash covers every prompts/v7 block, including the voice tasks', () => {
  const base = textPromptHash();
  for (const name of Object.keys(PROMPTS_V7)) {
    assert.notEqual(
      textPromptHash({ ...PROMPTS_V7, [name]: `${PROMPTS_V7[name as keyof typeof PROMPTS_V7]}x` }),
      base,
      name,
    );
  }
});

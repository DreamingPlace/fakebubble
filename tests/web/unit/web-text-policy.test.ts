import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { protocolFingerprint } from '../../../apps/server/accepted-text-protocol.ts';
import { createTextGenerationPolicy, textPolicyHash } from '../../../apps/server/text-generation-policy.ts';

// Values captured on main (66e2c6b) before the experimental-v10 protocol was removed. Stored preview and
// publication approvals embed this hash, so it must stay byte-identical.
const POLICY_HASH = '58ba3f9912037b6b3d6e3c2c8555ff4e951ada2df840ca6490ee54fac850b7b8';
const PROMPT_HASH = '8a49da0d49aa53b16d42ed216005569412a31761003fb26c5c35df2e42c9ce9e';
const FINGERPRINT_DIGEST = '6fa114401ba3d72474893e83cf449c8edb9f5ea84d8ffda9fd223e2b18067418';

test('accepted-v7 policy hash, prompt hash and protocol fingerprint are unchanged by removing v10', () => {
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

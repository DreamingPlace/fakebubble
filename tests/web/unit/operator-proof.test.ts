import assert from 'node:assert/strict';
import test from 'node:test';
import { operatorProof, requireOperatorProof } from '../../../apps/server/cloudflare/operator-proof.ts';

const key = Buffer.alloc(32, 2).toString('base64url');

test('the proof is accepted; missing, empty, wrong, truncated, padded and non-string proofs are not', () => {
  const proof = operatorProof(key);
  assert.match(proof, /^[a-f0-9]{64}$/);
  requireOperatorProof(key, proof);
  for (const bad of [
    undefined,
    null,
    '',
    'x',
    proof.slice(1),
    proof + '0',
    proof.toUpperCase(),
    5,
    {},
    operatorProof(Buffer.alloc(32, 3).toString('base64url')),
  ])
    assert.throws(() => requireOperatorProof(key, bad), /WEB_CLOUD_OPERATOR_PROOF_INVALID/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { InviteLocalApiError } from '../../../apps/player-web/src/services/invite-local-api.ts';
import { inviteFormPort } from '../../../apps/player-web/src/session/invite-form-adapter.ts';

test('E form adapter returns accepted only after controller completes trusted install', async () => {
  let resolve!: (value: { principalId: string; grantId: string }) => void;
  const pending = new Promise<{ principalId: string; grantId: string }>(done => { resolve = done; });
  const calls: string[] = [];
  const port = inviteFormPort({
    redeem: async (code, requestId) => { calls.push(`${code}:${requestId}`); return pending; },
    recover: async () => { throw new Error('unexpected recovery'); },
  });
  const result = port.redeem({ code: 'synthetic-code', requestId: 'fixed-request' });
  assert.deepEqual(calls, ['synthetic-code:fixed-request']);
  resolve({ principalId: 'principal', grantId: 'grant' });
  assert.deepEqual(await result, { kind: 'accepted', principalId: 'principal', grantId: 'grant' });
});

test('E form adapter preserves uncertain outcome and never retries redemption', async () => {
  let redeemCount = 0;
  const port = inviteFormPort({
    redeem: async () => { redeemCount++; throw new Error('network dropped'); },
    recover: async (code, requestId) => {
      assert.equal(code, 'synthetic-code'); assert.equal(requestId, 'fixed-request');
      return { principalId: 'principal', grantId: 'grant' };
    },
  });
  const input = { code: 'synthetic-code', requestId: 'fixed-request' };
  assert.deepEqual(await port.redeem(input), { kind: 'uncertain' });
  assert.deepEqual(await port.recover(input), { kind: 'accepted', principalId: 'principal', grantId: 'grant' });
  assert.equal(redeemCount, 1);
});

test('E form adapter exposes only known definitive denial as terminal or safe generic rejection', async () => {
  for (const [error, expected] of [
    [new InviteLocalApiError(401, 'SESSION_EXPIRED'), 'lost-session'],
    [new InviteLocalApiError(410, 'TRIAL_EXPIRED'), 'lost-session'],
    [new InviteLocalApiError(404, 'RECEIPT_UNAVAILABLE'), 'recovery-unavailable'],
    [new InviteLocalApiError(409, 'WEB_INVITE_RECOVERY_UNAVAILABLE'), 'recovery-unavailable'],
    [new InviteLocalApiError(403, 'WEB_INVITE_UNAVAILABLE'), 'invalid-code'],
    [new Error('WEB_INVITE_SCOPE_MISMATCH'), 'recovery-unavailable'],
  ] as const) {
    const port = inviteFormPort({ redeem: async () => { throw error; },
      recover: async () => { throw error; } });
    assert.deepEqual(await port.redeem({ code: 'synthetic', requestId: 'fixed' }),
      { kind: 'rejected', code: expected });
  }
  const unknown = inviteFormPort({ redeem: async () => {
    throw new InviteLocalApiError(503, 'INTERNAL_ERROR');
  }, recover: async () => { throw new Error('network dropped'); } });
  assert.deepEqual(await unknown.redeem({ code: 'synthetic', requestId: 'fixed' }),
    { kind: 'uncertain' });
});

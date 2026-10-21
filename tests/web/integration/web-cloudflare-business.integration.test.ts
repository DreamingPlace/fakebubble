import test from 'node:test';
import assert from 'node:assert/strict';
import { localRuntime } from '../../cloudflare/runtime.ts';
import { createHash } from 'node:crypto';
import { syntheticTone } from '../../../apps/server/platform/web-local-fake.ts';

const origin = 'https://fixture.invalid',
  ipHash = 'a'.repeat(64);
type Guest = { principalId: string; csrf: string; issuedToken: string };
type Admin = { cookie: string; csrf: string };
type Scope = { principalId: string; world_id: string; player_id: string; kind: string };
const write = (guest: Guest) => ({ token: guest.issuedToken, csrf: guest.csrf, origin, ipHash });

// Named exception (Part 22x): this test covered the legacy invite identity (sealed rotation on redeem, redemption recovery,
// recovery code, revoke ending the session). Those are gone; the assertions that still apply (CSRF and Origin on the redeeming
// request, scope, idempotent replay across a restart, revocation) are carried over onto the entitlement redemption.
test('workerd entitlement redemption: CSRF/Origin, scope, replay across restart and revocation', async (t) => {
  const f = localRuntime(t, 'tests/web/fixtures/cloudflare-business-worker.ts', { STATE: 'WebBusinessFixture' });
  const guest = await f.call<Guest>('/bootstrap', {}),
    other = await f.call<Guest>('/bootstrap', {});
  const scope = await f.call<Scope>('/authenticate', { token: guest.issuedToken });
  const admin = await f.call<Admin>('/admin');
  const batch = await f.call<{ batchId: string; codes: string[] }>('/batch', {
    ...admin,
    origin,
    input: {
      requestId: 'batch-1',
      name: 'offline',
      count: 1,
      tier: { kind: 'unlimited' },
      durationDays: null,
      redeemBy: null,
    },
  });
  const redemption = { ...write(guest), input: { code: batch.codes[0], requestId: 'redeem-1' } };
  // A guest with no email login is refused before the code is looked at; nothing is consumed.
  assert.deepEqual(await f.call('/redeem', redemption, 409), { error: 'PLAYER_LOGIN_REQUIRED' });
  await f.call('/login', { token: guest.issuedToken });
  assert.deepEqual(await f.call('/redeem', { ...redemption, csrf: 'x'.repeat(43) }, 409), { error: 'CSRF_INVALID' });
  assert.deepEqual(await f.call('/redeem', { ...redemption, origin: 'https://other.invalid' }, 409), {
    error: 'ORIGIN_INVALID',
  });
  const redeemed = await f.call<{ entitlement: { kind: string }; duplicate: boolean }>('/redeem', redemption);
  assert.deepEqual([redeemed.entitlement.kind, redeemed.duplicate], ['unlimited', false]);
  // Same session: no rotation, the same principal and world.
  assert.deepEqual(await f.call('/authenticate', { token: guest.issuedToken }), scope);
  assert.deepEqual(await f.call('/redeem', { ...write(other), input: redemption.input }, 409), {
    error: 'PLAYER_LOGIN_REQUIRED',
  });
  assert.deepEqual(await f.call('/content', { token: other.issuedToken, worldId: scope.world_id }, 409), {
    error: 'WEB_RETENTION_SCOPE_INVALID',
  });
  await f.restart();
  const replay = await f.call<{ entitlement: unknown; duplicate: boolean }>('/redeem', redemption);
  assert.equal(replay.duplicate, true);
  assert.deepEqual(replay.entitlement, redeemed.entitlement);
  const [inviteId] = await f.call<string[]>('/code-ids', { batchId: batch.batchId });
  await f.call('/revoke', { ...admin, origin, inviteId });
  assert.deepEqual(await f.call('/authenticate', { token: guest.issuedToken }), scope);
});

test('workerd admission is durable and immutable; unavailable password KDF never falls back', async (t) => {
  const f = localRuntime(t, 'tests/web/fixtures/cloudflare-business-worker.ts', { STATE: 'WebBusinessFixture' });
  const guest = await f.call<Guest>('/bootstrap', {});
  const request = { ...write(guest), input: { requestId: 'round-1', characterId: 'wei-guagua', text: '离线测试' } };
  const admitted = await f.call<{ duplicate: boolean }>('/admit', request);
  assert.equal(admitted.duplicate, false);
  assert.deepEqual(await f.call('/admit', { ...request, input: { ...request.input, text: '不同的内容' } }, 409), {
    error: 'IDEMPOTENCY_CONFLICT',
  });
  await f.restart();
  assert.deepEqual(await f.call('/admit', request), { ...admitted, duplicate: true });
  const second = await f.call<Guest>('/bootstrap', {});
  assert.deepEqual(
    await f.call(
      '/register',
      {
        ...write(second),
        input: {
          requestId: 'registration-1',
          username: 'offline',
          password: 'offline-password',
        },
      },
      409,
    ),
    { error: 'WEB_ARGON2_UNAVAILABLE' },
  );
  const counts = await f.call<{
    accounts: { n: number };
    operations: { n: number };
    quota: { used_total: number; reserved_total: number }[];
    budgets: { spent_micros: number; held_micros: number }[];
  }>('/counts');
  assert.equal(counts.accounts.n, 0);
  assert.equal(counts.operations.n, 1);
  assert.deepEqual(counts.quota, [{ used_total: 0, reserved_total: 1 }]);
  assert.ok(counts.budgets.every((row) => row.spent_micros === 0 && row.held_micros === 0));
});

test('workerd shared business runner: three guest rounds, private voice, footer and no replay spend', async (t) => {
  const f = localRuntime(t, 'tests/web/fixtures/cloudflare-business-worker.ts', { STATE: 'WebBusinessFixture' });
  const guest = await f.call<Guest>('/bootstrap', {}),
    other = await f.call<Guest>('/bootstrap', {});
  const input = { requestId: '', characterId: 'wei-guagua', text: '离线合成回复测试' };
  let conversationId = '';
  for (let i = 1; i <= 3; i++) {
    const request = { ...write(guest), input: { ...input, requestId: `round-${i}` } };
    const admitted = await f.call<{ operationId: string; conversationId: string }>('/admit', request);
    conversationId = admitted.conversationId;
    const receipt = await f.call<{ footerMessageId: string | null }>('/run', { operationId: admitted.operationId });
    assert.equal(receipt.footerMessageId !== null, i === 3);
    const before = await f.call('/state', { token: guest.issuedToken });
    await f.restart();
    assert.deepEqual(await f.call('/run', { operationId: admitted.operationId }), receipt);
    assert.deepEqual(await f.call('/state', { token: guest.issuedToken }), before);
    assert.deepEqual(await f.call('/admit', request), { ...admitted, status: 'published', duplicate: true });
  }
  assert.deepEqual(await f.call('/admit', { ...write(guest), input: { ...input, requestId: 'round-4' } }, 409), {
    error: 'TRIAL_EXHAUSTED',
  });
  const state = await f.call<{
    principal: { trial_used: number; trial_reserved: number };
    messages: { media_id: string | null }[];
    calls: { provider: string; n: number }[];
  }>('/state', { token: guest.issuedToken });
  assert.deepEqual(state.principal, { trial_used: 3, trial_reserved: 0 });
  assert.equal(state.calls.find((row) => row.provider === 'text')?.n, 6);
  assert.ok(state.calls.find((row) => row.provider === 'speech')!.n >= 3);
  for (const message of state.messages.filter((row) => row.media_id)) {
    const query = {
      token: guest.issuedToken,
      conversationId,
      characterId: input.characterId,
      mediaId: message.media_id,
    };
    assert.deepEqual(await f.call('/audio', query), {
      byteLength: syntheticTone().length,
      sha256: createHash('sha256').update(syntheticTone()).digest('hex'),
    });
    assert.deepEqual(await f.call('/audio', { ...query, token: other.issuedToken }, 409), {
      error: 'WEB_PUBLISHED_AUDIO_NOT_FOUND',
    });
  }
});

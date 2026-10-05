import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { localRuntime } from '../../cloudflare/runtime.ts';
import { syntheticTone } from '../../../apps/server/web-local-fake.ts';
import { SYNTHETIC_TRIAL_FOOTER } from '../../../apps/server/web-vertical-publisher.ts';

type Guest = { principalId: string; csrf: string; issuedToken: string };
type State = {
  principal: { trial_used: number; trial_reserved: number };
  messages: { id: string; body: string; media_id: string | null }[];
  calls: { provider: string; n: number }[];
};
type Storage = {
  tables: { name: string; n: number; refs: number; blobBytes: number }[];
  attempts: { phase: string; state: string; outcome: string; charged_micros: number }[];
  operations: { id: string; status: string; quota_state: string }[];
};
const setup = (t: test.TestContext) =>
  localRuntime(t, 'tests/web/fixtures/cloudflare-business-worker.ts', { STATE: 'WebBusinessFixture' }, ['MEDIA']);
const request = (guest: Guest, index = 1) => ({
  token: guest.issuedToken,
  csrf: guest.csrf,
  origin: 'https://fixture.invalid',
  ipHash: 'a'.repeat(64),
  input: { requestId: `r2-round-${index}`, characterId: 'wei-guagua', text: '离线 R2 验证' },
});
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

test('workerd R2: 60-second WAV avoids SQL blob limits, three rounds/footer survive restart and remain private', async (t) => {
  const f = setup(t);
  const fixed = await f.call<string[]>('/assets');
  assert.equal(fixed.length, 6);
  assert.deepEqual(await f.call('/assets'), fixed);
  for (const index of [0, 2, 4])
    assert.deepEqual(await f.call('/welcome', { mediaId: fixed[index] }), {
      byteLength: syntheticTone().length,
      sha256: hash(syntheticTone()),
    });
  assert.deepEqual(await f.call('/welcome', { mediaId: fixed[1] }, 409), { error: 'WEB_PROVIDER_WELCOME_UNAVAILABLE' });
  const guest = await f.call<Guest>('/bootstrap', {}),
    other = await f.call<Guest>('/bootstrap', {});
  let conversationId = '';
  for (let i = 1; i <= 3; i++) {
    const operation = await f.call<{ operationId: string; conversationId: string }>('/admit', request(guest, i));
    conversationId = operation.conversationId;
    const receipt = await f.call<{ footerMessageId: string | null }>('/run', {
      operationId: operation.operationId,
      largeAudio: true,
    });
    assert.equal(receipt.footerMessageId !== null, i === 3);
    const state = await f.call('/state', { token: guest.issuedToken });
    await f.restart();
    assert.deepEqual(await f.call('/run', { operationId: operation.operationId }), receipt);
    assert.deepEqual(await f.call('/state', { token: guest.issuedToken }), state);
  }
  const state = await f.call<State>('/state', { token: guest.issuedToken });
  assert.deepEqual(state.principal, { trial_used: 3, trial_reserved: 0 });
  for (const message of state.messages.filter((row) => row.media_id)) {
    const query = { token: guest.issuedToken, conversationId, characterId: 'wei-guagua', mediaId: message.media_id };
    const expected = syntheticTone(message.body === SYNTHETIC_TRIAL_FOOTER ? 250 : 60_000);
    assert.deepEqual(await f.call('/audio', query), { byteLength: expected.length, sha256: hash(expected) });
    assert.deepEqual(await f.call('/audio', { ...query, token: other.issuedToken }, 409), {
      error: 'WEB_PUBLISHED_AUDIO_NOT_FOUND',
    });
  }
  const storage = await f.call<Storage>('/storage');
  assert.ok(storage.tables.every((row) => row.blobBytes === 0));
  assert.equal(storage.tables.find((row) => row.name === 'footer_assets')?.refs, 3);
  assert.equal(storage.tables.find((row) => row.name === 'welcome_assets')?.refs, 3);
  assert.equal(
    storage.tables.find((row) => row.name === 'media_assets')?.refs,
    state.calls.find((row) => row.provider === 'speech')?.n,
  );
  assert.ok(storage.attempts.every((row) => row.state === 'known' && row.outcome === 'succeeded'));
});

test('R2 result after stale lease remains known and recovers without regenerating that segment', async (t) => {
  const f = setup(t);
  await f.call('/assets');
  const guest = await f.call<Guest>('/bootstrap', {});
  const operation = await f.call<{ operationId: string }>('/admit', request(guest));
  await f.call('/fault', { mode: 'stale-on-put' });
  assert.deepEqual(await f.call('/run', { operationId: operation.operationId, largeAudio: true }, 409), {
    error: 'WEB_PROVIDER_CLAIM_STALE',
  });
  const before = await f.call<Storage>('/storage');
  assert.equal(before.attempts.filter((row) => row.phase === 'speech' && row.state === 'known').length, 1);
  assert.equal(before.tables.find((row) => row.name === 'media_assets')?.n, 0);
  await f.restart();
  await f.call('/run', { operationId: operation.operationId });
  const after = await f.call<Storage>('/storage'),
    state = await f.call<State>('/state', { token: guest.issuedToken });
  assert.equal(after.operations[0]!.status, 'published');
  assert.equal(
    state.calls.find((row) => row.provider === 'speech')?.n,
    after.tables.find((row) => row.name === 'media_assets')?.n,
  );
});

test('failed R2 write preserves the known bill, publishes nothing and never auto-resends', async (t) => {
  const f = setup(t);
  await f.call('/assets');
  const guest = await f.call<Guest>('/bootstrap', {});
  const operation = await f.call<{ operationId: string }>('/admit', request(guest));
  await f.call('/fault', { mode: 'put-fail' });
  assert.deepEqual(await f.call('/run', { operationId: operation.operationId }, 409), { error: 'OFFLINE_R2_FAILED' });
  const before = await f.call<Storage>('/storage');
  const speech = before.attempts.find((row) => row.phase === 'speech')!;
  assert.equal(speech.state, 'known');
  assert.equal(speech.outcome, 'failed');
  assert.ok(speech.charged_micros > 0);
  assert.equal(before.tables.find((row) => row.name === 'media_assets')?.n, 0);
  await f.restart();
  await f.call('/run', { operationId: operation.operationId }, 409);
  const state = await f.call<State>('/state', { token: guest.issuedToken });
  assert.equal(state.calls.find((row) => row.provider === 'speech')?.n, 1);
  assert.equal(state.messages.filter((row) => row.media_id).length, 0);
});

test('publication lease expiring during R2 verification cannot publish or debit; restart uses staged bytes', async (t) => {
  const f = setup(t);
  await f.call('/assets');
  const guest = await f.call<Guest>('/bootstrap', {});
  const operation = await f.call<{ operationId: string }>('/admit', request(guest));
  await f.call('/fault', { mode: 'publish-stale-on-get' });
  assert.deepEqual(await f.call('/run', { operationId: operation.operationId }, 409), { error: 'WEB_STAGE_STALE' });
  const state = await f.call<State>('/state', { token: guest.issuedToken });
  assert.deepEqual(state.principal, { trial_used: 0, trial_reserved: 1 });
  assert.equal(state.messages.filter((row) => row.media_id).length, 0);
  await f.restart();
  await f.call('/run', { operationId: operation.operationId });
  const restored = await f.call<State>('/state', { token: guest.issuedToken });
  assert.deepEqual(restored.calls, state.calls);
  assert.deepEqual(restored.principal, { trial_used: 1, trial_reserved: 0 });
});

test('R2 reads reject object corruption and entitlement loss during the asynchronous read', async (t) => {
  for (const mode of ['tamper', 'expire-on-get'])
    await t.test(mode, async (t) => {
      const f = setup(t);
      await f.call('/assets');
      const guest = await f.call<Guest>('/bootstrap', {});
      const operation = await f.call<{ operationId: string; conversationId: string }>('/admit', request(guest));
      await f.call('/run', { operationId: operation.operationId });
      const state = await f.call<State>('/state', { token: guest.issuedToken });
      const mediaId = state.messages.find((row) => row.media_id)!.media_id;
      if (mode === 'tamper') await f.call('/tamper', { mediaId });
      else await f.call('/fault', { mode, principalId: guest.principalId });
      assert.deepEqual(
        await f.call(
          '/audio',
          { token: guest.issuedToken, conversationId: operation.conversationId, characterId: 'wei-guagua', mediaId },
          409,
        ),
        { error: mode === 'tamper' ? 'MEDIA_INTEGRITY_ERROR' : 'TRIAL_EXPIRED' },
      );
    });
});

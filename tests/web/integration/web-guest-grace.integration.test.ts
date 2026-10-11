import test from 'node:test';
import assert from 'node:assert/strict';
import { localRuntime } from '../../cloudflare/runtime.ts';

type Guest = { principalId: string; csrf: string; issuedToken: string };
type Kept = { retention: { state: string }; messages: number; due: number | null };
const origin = 'https://fixture.invalid';
const DAY = 24 * 60 * 60_000;
const GRACE = 7 * DAY;

/**
 * Part 17 A against the real Cloudflare retention object: with GUEST_GRACE_ENABLED a guest without a login is purged at
 * expires_at + 7 days (not at expires_at), a guest with a login is never purged at that point, the flag off keeps the
 * old timing, and admission never changes (no new reply once the trial ended, grace or not).
 */
test('guest purge time is expires_at + 7 days with the grace flag, and expires_at without it', async (t) => {
  const f = localRuntime(t, 'tests/web/fixtures/cloudflare-retention-worker.ts', { STATE: 'WebRetentionFixture' }, [
    'MEDIA',
  ]);
  await f.call('/assets');
  const ipHash = 'a'.repeat(64);
  const chat = async (requestId: string) => {
    const actor = await f.call<Guest>('/bootstrap', {});
    await f.call('/run', {
      ...(await f.call<{ operationId: string }>('/admit', {
        token: actor.issuedToken,
        csrf: actor.csrf,
        origin,
        ipHash,
        input: { requestId, characterId: 'wei-guagua', text: '宽限期' },
      })),
    });
    return actor;
  };
  const plain = await chat('grace-plain'),
    kept = await chat('grace-kept'),
    control = await chat('grace-control');
  await f.call('/retention/seed-logins', { ...kept, lastSeenAgoMs: 0 });

  // Flag off: every guest past its trial is purged at once, the signed-up one excepted (11f keep rule).
  await f.call('/retention/grace', { principalId: '', graceMs: 0 });
  await f.call('/retention/expire', control);
  assert.deepEqual(await f.call('/retention/sweep'), { processed: 1, failed: 0, error: null });
  assert.equal((await f.call<Kept>('/retention/state', control)).retention.state, 'purged');

  // Flag on, trial ended 3 days ago: inside the grace period nothing is purged, nothing can be read or sent.
  await f.call('/retention/grace', { principalId: '', graceMs: GRACE });
  await f.call('/retention/expire', { ...plain, agoMs: 3 * DAY });
  await f.call('/retention/expire', { ...kept, agoMs: 3 * DAY });
  assert.deepEqual(await f.call('/retention/sweep'), { processed: 0, failed: 0, error: null });
  const during = await f.call<Kept>('/retention/state', plain);
  assert.equal(during.retention.state, 'active');
  assert.ok(during.messages > 0, 'the history is still stored during grace');
  assert.ok(during.due! > Date.now() + 3 * DAY, 'the next purge is at the end of the grace period');
  assert.deepEqual(await f.call('/retention/read', plain, 409), { error: 'TRIAL_EXPIRED' }, 'no history during grace');
  for (const actor of [plain, kept])
    assert.deepEqual(
      await f.call(
        '/admit',
        {
          token: actor.issuedToken,
          csrf: actor.csrf,
          origin,
          ipHash,
          input: { requestId: 'late', characterId: 'wei-guagua', text: '还能聊吗' },
        },
        409,
      ),
      { error: 'TRIAL_EXPIRED' },
      'admission is unchanged: no new reply without an invite',
    );

  // 7 days after expires_at the guest without a login is purged; the signed-up guest keeps everything.
  await f.call('/retention/expire', { ...plain, agoMs: GRACE + 1 });
  await f.call('/retention/expire', { ...kept, agoMs: GRACE + 1 });
  assert.deepEqual(await f.call('/retention/sweep'), { processed: 1, failed: 0, error: null });
  assert.equal((await f.call<Kept>('/retention/state', plain)).retention.state, 'purged');
  const after = await f.call<Kept>('/retention/state', kept);
  assert.equal(after.retention.state, 'active');
  assert.ok(after.messages > 0, 'the kept account still has its history');
  await f.call('/retention/read', kept);
});

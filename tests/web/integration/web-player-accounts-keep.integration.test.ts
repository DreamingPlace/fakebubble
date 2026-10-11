import test from 'node:test';
import assert from 'node:assert/strict';
import { localRuntime } from '../../cloudflare/runtime.ts';

type Guest = { principalId: string; csrf: string; issuedToken: string };
type State = { logins: number; challenges: number; cards: number };
type Kept = { retention: { state: string }; messages: number; due: number | null };
const origin = 'https://fixture.invalid';
const DAY = 24 * 60 * 60_000;

/**
 * Fix-up 11f: a guest who signed up keeps the account after the trial. Against the real Cloudflare retention object:
 * trial end with a login keeps everything readable and refuses new replies, trial end without a login purges as before,
 * 180 idle days purge through the audited path, and an invite can still be redeemed after the trial.
 */
test('a signed-up guest keeps its data after the trial, is purged after 180 idle days, and a guest without a login purges as before', async (t) => {
  const f = localRuntime(t, 'tests/web/fixtures/cloudflare-retention-worker.ts', { STATE: 'WebRetentionFixture' }, [
    'MEDIA',
  ]);
  await f.call('/assets');
  const ipHash = 'a'.repeat(64);
  const chat = async () => {
    const actor = await f.call<Guest>('/bootstrap', {});
    await f.call('/run', {
      ...(await f.call<{ operationId: string }>('/admit', {
        token: actor.issuedToken,
        csrf: actor.csrf,
        origin,
        ipHash,
        input: { requestId: 'keep-round', characterId: 'wei-guagua', text: '登录保留' },
      })),
    });
    return actor;
  };
  const kept = await chat(),
    plain = await chat();
  await f.call('/retention/seed-logins', { ...kept, lastSeenAgoMs: 0 });
  assert.deepEqual(await f.call<State>('/retention/login-state', kept), { logins: 1, challenges: 2, cards: 1 });
  await f.call('/retention/expire', kept);
  await f.call('/retention/expire', plain);

  // Trial end: only the guest WITHOUT a login is purged.
  assert.deepEqual(await f.call('/retention/sweep'), { processed: 1, failed: 0, error: null });
  assert.equal((await f.call<Kept>('/retention/state', plain)).retention.state, 'purged');
  const state = await f.call<Kept>('/retention/state', kept);
  assert.equal(state.retention.state, 'active', 'the retention row is untouched: still active and expired');
  assert.ok(state.messages > 0, 'the history is kept');
  assert.deepEqual(await f.call<State>('/retention/login-state', kept), { logins: 1, challenges: 2, cards: 1 });
  assert.ok(state.due! > Date.now() + 179 * DAY, 'the next purge is the 180-day inactivity one, not the trial end');

  // Readable, but no new reply: every 'live' gate and admission answer the normal trial-ended code.
  await f.call('/retention/read', kept);
  assert.deepEqual(await f.call('/content', { token: kept.issuedToken }, 409), { error: 'TRIAL_EXPIRED' });
  assert.deepEqual(
    await f.call(
      '/admit',
      {
        token: kept.issuedToken,
        csrf: kept.csrf,
        origin,
        ipHash,
        input: { requestId: 'after-trial', characterId: 'wei-guagua', text: '还能聊吗' },
      },
      409,
    ),
    { error: 'TRIAL_EXPIRED' },
  );
  assert.deepEqual(
    await f.call('/retention/read', plain, 409),
    { error: 'TRIAL_EXPIRED' },
    'a purged guest reads nothing',
  );

  // 179 idle days: still kept. 181: purged through the audited path, nothing of the player remains.
  await f.call('/retention/last-seen', { ...kept, lastSeenAgoMs: 179 * DAY });
  assert.deepEqual(await f.call('/retention/sweep'), { processed: 0, failed: 0, error: null });
  await f.call('/retention/last-seen', { ...kept, lastSeenAgoMs: 181 * DAY });
  assert.deepEqual(await f.call('/retention/sweep'), { processed: 1, failed: 0, error: null });
  const gone = await f.call<Kept>('/retention/state', kept);
  assert.equal(gone.retention.state, 'purged');
  assert.equal(gone.messages, 0);
  assert.deepEqual(await f.call<State>('/retention/login-state', kept), { logins: 0, challenges: 0, cards: 0 });
  assert.deepEqual(await f.call('/retention/read', kept, 409), { error: 'TRIAL_EXPIRED' });
});

test('a guest who signed up but never chatted is purged after 180 idle days and not before', async (t) => {
  const f = localRuntime(t, 'tests/web/fixtures/cloudflare-retention-worker.ts', { STATE: 'WebRetentionFixture' }, [
    'MEDIA',
  ]);
  const idle = await f.call<Guest>('/bootstrap', {});
  await f.call('/retention/seed-logins', { ...idle, lastSeenAgoMs: 100 * DAY });
  assert.deepEqual(await f.call('/retention/sweep'), { processed: 0, failed: 0, error: null });
  await f.call('/retention/last-seen', { ...idle, lastSeenAgoMs: 181 * DAY });
  assert.deepEqual(await f.call('/retention/sweep'), { processed: 1, failed: 0, error: null });
  assert.equal((await f.call<Kept>('/retention/state', idle)).retention.state, 'purged');
  assert.deepEqual(await f.call<State>('/retention/login-state', idle), { logins: 0, challenges: 0, cards: 0 });
});

test('a signed-up guest can redeem an invite after the trial ended, and the normal invited rules apply from then on', async (t) => {
  const f = localRuntime(t, 'tests/web/fixtures/cloudflare-retention-worker.ts', { STATE: 'WebRetentionFixture' }, [
    'MEDIA',
  ]);
  await f.call('/assets');
  const ipHash = 'a'.repeat(64);
  const guest = await f.call<Guest>('/bootstrap', {});
  await f.call('/run', {
    ...(await f.call<{ operationId: string }>('/admit', {
      token: guest.issuedToken,
      csrf: guest.csrf,
      origin,
      ipHash,
      input: { requestId: 'redeem-round', characterId: 'wei-guagua', text: '先试聊' },
    })),
  });
  await f.call('/retention/seed-logins', { ...guest, lastSeenAgoMs: 0 });
  await f.call('/retention/expire', guest);
  assert.deepEqual(await f.call('/content', { token: guest.issuedToken }, 409), { error: 'TRIAL_EXPIRED' });

  const admin = await f.call<{ cookie: string; csrf: string }>('/admin');
  const issued = await f.call<{ code: string }>('/issue', {
    ...admin,
    origin,
    input: { requestId: 'after-trial-invite', redeemBy: null, accessDurationMs: null, batch: 'keep', note: null },
  });
  const redeemed = await f.call<{ identity?: { issuedToken: string } }>('/redeem', {
    token: guest.issuedToken,
    csrf: guest.csrf,
    origin,
    ipHash,
    input: { code: issued.code, requestId: 'after-trial-redeem' },
  });
  const state = await f.call<Kept>('/retention/state', guest);
  assert.equal(state.retention.state, 'protected', 'redemption moves the player to the invited (protected) rules');
  assert.ok(state.messages > 0, 'the history survived the redemption');
  await f.call('/retention/read', guest);
  // Invited now: the live gate opens too (the redemption's new session), and the guest cleaner never touches it
  // however idle the login is.
  await f.call('/content', { token: redeemed.identity!.issuedToken });
  await f.call('/retention/last-seen', { ...guest, lastSeenAgoMs: 400 * DAY });
  assert.deepEqual(await f.call('/retention/sweep'), { processed: 0, failed: 0, error: null });
  assert.equal((await f.call<Kept>('/retention/state', guest)).retention.state, 'protected');
});

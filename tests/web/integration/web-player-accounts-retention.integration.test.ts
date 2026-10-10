import test from 'node:test';
import assert from 'node:assert/strict';
import { localRuntime } from '../../cloudflare/runtime.ts';

type Guest = { principalId: string; csrf: string; issuedToken: string };
type State = { logins: number; challenges: number; cards: number };
const origin = 'https://fixture.invalid';

test('player-data retention removes a purged player’s login, challenges and nickname 名片 and leaves a protected invite’s untouched', async (t) => {
  const f = localRuntime(t, 'tests/web/fixtures/cloudflare-retention-worker.ts', { STATE: 'WebRetentionFixture' }, [
    'MEDIA',
  ]);
  await f.call('/assets');
  const guest = await f.call<Guest>('/bootstrap', {}),
    invited = await f.call<Guest>('/bootstrap', {});
  for (const actor of [guest, invited])
    await f.call('/run', {
      ...(await f.call<{ operationId: string }>('/admit', {
        token: actor.issuedToken,
        csrf: actor.csrf,
        origin,
        ipHash: 'a'.repeat(64),
        input: { requestId: 'retention-round', characterId: 'wei-guagua', text: '登录保留期清理' },
      })),
    });
  const admin = await f.call<{ cookie: string; csrf: string }>('/admin');
  const issued = await f.call<{ code: string }>('/issue', {
    ...admin,
    origin,
    input: { requestId: 'retain-invite', redeemBy: null, accessDurationMs: null, batch: 'offline', note: null },
  });
  await f.call('/redeem', {
    token: invited.issuedToken,
    csrf: invited.csrf,
    origin,
    ipHash: 'a'.repeat(64),
    input: { code: issued.code, requestId: 'retain-redeem' },
  });
  for (const actor of [guest, invited]) await f.call('/retention/seed-logins', actor);
  assert.deepEqual(await f.call<State>('/retention/login-state', guest), { logins: 1, challenges: 2, cards: 1 });

  await f.call('/retention/expire', guest);
  assert.deepEqual(await f.call('/retention/sweep'), { processed: 1, failed: 0, error: null });

  // Login, both challenges (one by principal, one by the login's address) and the nickname 名片 went with the guest.
  assert.deepEqual(await f.call<State>('/retention/login-state', guest), { logins: 0, challenges: 0, cards: 0 });
  assert.deepEqual(
    await f.call<State>('/retention/login-state', invited),
    { logins: 1, challenges: 2, cards: 1 },
    'the protected invite keeps its login, challenges and nickname',
  );
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { localRuntime } from '../../cloudflare/runtime.ts';

type Guest = { principalId: string; csrf: string; issuedToken: string };
type State = { logins: number; challenges: number; cards: number };
const origin = 'https://fixture.invalid';

test('player-data retention removes a purged player’s login, challenges and nickname 名片 and leaves an entitled player’s untouched', async (t) => {
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
  // Named exception (Part 22x): the legacy invite redemption is gone; the kept player holds an unlimited entitlement instead.
  await f.call('/retention/entitle', { principalId: invited.principalId });
  // Named exception (Part 22x): an entitled player is kept like any registered player (180 idle days), not 'protected' for ever,
  // so it is seeded as recently seen; the guest keeps the default 181 idle days.
  await f.call('/retention/seed-logins', guest);
  await f.call('/retention/seed-logins', { ...invited, lastSeenAgoMs: 0 });
  assert.deepEqual(await f.call<State>('/retention/login-state', guest), { logins: 1, challenges: 2, cards: 1 });

  await f.call('/retention/expire', guest);
  assert.deepEqual(await f.call('/retention/sweep'), { processed: 1, failed: 0, error: null });

  // Login, both challenges (one by principal, one by the login's address) and the nickname 名片 went with the guest.
  assert.deepEqual(await f.call<State>('/retention/login-state', guest), { logins: 0, challenges: 0, cards: 0 });
  assert.deepEqual(
    await f.call<State>('/retention/login-state', invited),
    { logins: 1, challenges: 2, cards: 1 },
    'the entitled player keeps its login, challenges and nickname',
  );
});

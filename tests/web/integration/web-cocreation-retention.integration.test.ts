import test from 'node:test';
import assert from 'node:assert/strict';
import { localRuntime } from '../../cloudflare/runtime.ts';

type Guest = { principalId: string; csrf: string; issuedToken: string };
type Inbox = { submissions: string[]; answers: number };
const origin = 'https://fixture.invalid';

test('player-data retention removes a purged player’s co-creation ideas and leaves a registered entitled player’s untouched', async (t) => {
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
        input: { requestId: 'retention-round', characterId: 'wei-guagua', text: '共创保留期清理' },
      })),
    });
  // Named exception (Part 22x): the protected player is a signed-up one holding an entitlement (the legacy invite is gone).
  const admin = await f.call<{ cookie: string; csrf: string }>('/admin');
  const batch = await f.call<{ codes: string[] }>('/batch', {
    ...admin,
    origin,
    input: {
      requestId: 'retain-batch',
      name: 'offline',
      count: 1,
      tier: { kind: 'unlimited' },
      durationDays: null,
      redeemBy: null,
    },
  });
  await f.call('/login', { token: invited.issuedToken });
  await f.call('/redeem', {
    token: invited.issuedToken,
    csrf: invited.csrf,
    origin,
    ipHash: 'a'.repeat(64),
    input: { code: batch.codes[0], requestId: 'retain-redeem' },
  });
  for (const actor of [guest, invited]) await f.call('/retention/seed-cocreation', actor);
  assert.equal((await f.call<Inbox>('/retention/cocreation-state', guest)).submissions.length, 2);

  await f.call('/retention/expire', guest);
  assert.deepEqual(await f.call('/retention/sweep'), { processed: 1, failed: 0, error: null });

  assert.deepEqual(await f.call<Inbox>('/retention/cocreation-state', guest), { submissions: [], answers: 2 });
  assert.equal(
    (await f.call<Inbox>('/retention/cocreation-state', invited)).submissions.length,
    2,
    'the registered player keeps its ideas',
  );
});

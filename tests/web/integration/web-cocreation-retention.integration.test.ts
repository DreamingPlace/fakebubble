import test from 'node:test';
import assert from 'node:assert/strict';
import { localRuntime } from '../../cloudflare/runtime.ts';

type Guest = { principalId: string; csrf: string; issuedToken: string };
type Inbox = { submissions: string[]; answers: number };
const origin = 'https://fixture.invalid';

test('player-data retention removes a purged player’s co-creation ideas and leaves a protected invite’s untouched', async (t) => {
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
  for (const actor of [guest, invited]) await f.call('/retention/seed-cocreation', actor);
  assert.equal((await f.call<Inbox>('/retention/cocreation-state', guest)).submissions.length, 2);

  await f.call('/retention/expire', guest);
  assert.deepEqual(await f.call('/retention/sweep'), { processed: 1, failed: 0, error: null });

  assert.deepEqual(await f.call<Inbox>('/retention/cocreation-state', guest), { submissions: [], answers: 2 });
  assert.equal(
    (await f.call<Inbox>('/retention/cocreation-state', invited)).submissions.length,
    2,
    'the protected invite keeps its ideas',
  );
});

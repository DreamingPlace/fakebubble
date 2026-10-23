import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { localRuntime } from '../../cloudflare/runtime.ts';

type Guest = { principalId: string; csrf: string; issuedToken: string };
type Counter = { day: string; metric: string; characterId: string; model: string; value: number };

/** Part 22c: deleting a character fails the replies still in flight in its chats; each is counted once, by its admission day. */
test('22c character deletion: a reply in flight in a deleted character fails once (CHARACTER_DELETED); a finished one is not touched', async (t) => {
  const f = localRuntime(
    t,
    'tests/web/fixtures/cloudflare-stats-deletion-worker.ts',
    { STATE: 'WebStatsDeletionFixture' },
    ['MEDIA'],
  );
  await f.call('/assets');
  const admit = (guest: Guest) =>
    f.call<{ operationId: string }>('/admit', {
      token: guest.issuedToken,
      csrf: guest.csrf,
      origin: 'https://fixture.invalid',
      ipHash: 'a'.repeat(64),
      input: { requestId: randomUUID(), characterId: 'wei-guagua', text: '角色删除时这条还没有回复' },
    });
  const finished = await f.call<Guest>('/bootstrap', {});
  await f.call('/run', await admit(finished));
  const waiting = await f.call<Guest>('/bootstrap', {});
  await admit(waiting);
  const counters = () => f.call<Counter[]>('/stats/counters', {});
  assert.deepEqual(
    (await counters()).map((r) => [r.metric, r.characterId, r.value]),
    [
      ['reply_published', 'wei-guagua', 1],
      ['reply_voice', 'wei-guagua', 1],
    ],
  );
  const preview = await f.call<{ previewHash: string }>('/deletion/preview');
  const input = { requestId: randomUUID(), previewHash: preview.previewHash, acknowledgeDeleteAllChats: true };
  assert.equal((await f.call<{ state: string }>('/deletion/start', { input })).state, 'purging');
  assert.equal((await f.call<{ state: string }>('/deletion/sweep')).state, 'deleted');
  const after = await counters();
  assert.deepEqual(
    after.map((r) => [r.metric, r.characterId, r.value]),
    [
      ['reply_failed', 'wei-guagua', 1],
      ['reply_published', 'wei-guagua', 1],
      ['reply_voice', 'wei-guagua', 1],
    ],
  );
  // Sweeping again, and a restart, count nothing more.
  assert.equal((await f.call<{ state: string }>('/deletion/sweep')).state, 'deleted');
  await f.restart();
  assert.equal((await f.call<{ state: string }>('/deletion/sweep')).state, 'deleted');
  assert.deepEqual(await counters(), after);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { localRuntime } from '../../cloudflare/runtime.ts';

type Guest = { principalId: string; csrf: string; issuedToken: string };
type Inbox = { submissions: string[]; answers: number };
const setup = (t: test.TestContext) =>
  localRuntime(
    t,
    'tests/web/fixtures/cloudflare-character-deletion-worker.ts',
    { STATE: 'WebCharacterDeletionFixture' },
    ['MEDIA'],
  );

test('character deletion purges that character’s co-creation submissions and answers, and only that character’s', async (t) => {
  const f = setup(t);
  const guests = [await f.call<Guest>('/bootstrap', {}), await f.call<Guest>('/bootstrap', {})];
  for (const guest of guests)
    await f.call('/run', {
      ...(await f.call<{ operationId: string }>('/admit', {
        token: guest.issuedToken,
        csrf: guest.csrf,
        origin: 'https://fixture.invalid',
        ipHash: 'a'.repeat(64),
        input: { requestId: randomUUID(), characterId: 'wei-guagua', text: '共创收件箱清理' },
      })),
    });
  for (const guest of guests) await f.call('/retention/seed-cocreation', guest);
  const before = await f.call<Inbox>('/retention/cocreation-state', {});
  assert.equal(before.submissions.length, 4, 'one for the deleted character and one for another, per player');
  assert.equal(before.answers, 4);

  const preview = await f.call<{ previewHash: string }>('/deletion/preview');
  await f.call('/deletion/start', {
    input: { requestId: randomUUID(), previewHash: preview.previewHash, acknowledgeDeleteAllChats: true },
  });
  // The purge starts with the deletion itself: the ideas are gone before any chat scope is swept.
  const started = await f.call<Inbox>('/retention/cocreation-state', {});
  assert.ok(started.submissions.every((id) => id.startsWith('co-other-')));
  const done = await f.call<{ state: string }>('/deletion/sweep');
  assert.equal(done.state, 'deleted');

  const after = await f.call<Inbox>('/retention/cocreation-state', {});
  assert.deepEqual(
    after.submissions,
    before.submissions.filter((id) => id.startsWith('co-other-')),
    'the other character’s ideas are untouched',
  );
  assert.equal(after.answers, 2, 'answers go with their submissions');
});

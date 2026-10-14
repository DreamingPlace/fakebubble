import test from 'node:test';
import assert from 'node:assert/strict';
import { localRuntime } from '../../cloudflare/runtime.ts';

type Guest = { principalId: string; csrf: string; issuedToken: string };
type ReviewState = {
  codes: { principal_id: string; code: string }[];
  notices: number;
  archive: Record<string, unknown>[];
};
const origin = 'https://fixture.invalid';
const DAY = 24 * 60 * 60_000;

const setup = (t: test.TestContext, on: boolean) =>
  localRuntime(
    t,
    on
      ? 'tests/web/fixtures/cloudflare-retention-review-worker.ts'
      : 'tests/web/fixtures/cloudflare-retention-worker.ts',
    { STATE: on ? 'WebRetentionReviewFixture' : 'WebRetentionFixture' },
    ['MEDIA'],
  );
type Runtime = ReturnType<typeof setup>;

/** A guest with one finished round whose text names the nickname, plus the player's review code, banner mark and 名片. */
async function player(f: Runtime, text = '我是阿泡，本条私人内容应在到期后清理') {
  const guest = await f.call<Guest>('/bootstrap', {});
  const op = await f.call<{ operationId: string }>('/admit', {
    token: guest.issuedToken,
    csrf: guest.csrf,
    origin,
    ipHash: 'a'.repeat(64),
    input: { requestId: 'review-round', characterId: 'wei-guagua', text },
  });
  await f.call('/run', op);
  await f.call('/retention/review-seed', { principalId: guest.principalId, name: '阿泡' });
  return guest;
}
const state = (f: Runtime) => f.call<ReviewState>('/retention/review-state', {});

test('the guest purge after the trial window archives the transcript once; the resumed purge does not archive again', async (t) => {
  const f = setup(t, true);
  await f.call('/assets');
  const guest = await player(f);
  const other = await player(f, '另一位玩家的话');
  assert.equal((await state(f)).codes.length, 2);
  await f.call('/retention/expire', guest);
  // T1 alone (the process "dies" after the transaction that starts the purge).
  await f.call('/retention/begin-only', guest);
  const started = await state(f);
  assert.ok(started.archive.length >= 2, 'the transcript was copied in the transaction that started the purge');
  assert.deepEqual(
    started.codes.map((c) => c.principal_id),
    [other.principalId],
    'the live code left with the purge start; the other player keeps theirs',
  );
  assert.equal(started.notices, 1);
  const lines = started.archive.map((r) => [r.speaker, r.text]);
  assert.ok(
    lines.some(([speaker, text]) => speaker === 'player' && text === '我是〔昵称〕，本条私人内容应在到期后清理'),
  );
  assert.ok(!JSON.stringify(started.archive).includes('阿泡'));
  // After the restart the alarm resumes the purge: it clears the world and archives nothing more.
  await f.call('/retention/restart', {});
  assert.deepEqual(await f.call('/retention/sweep'), { processed: 1, failed: 0, error: null });
  const done = await state(f);
  assert.deepEqual(done.archive, started.archive, 'not archived twice');
  assert.equal(done.codes.length, 1);
  assert.equal((await f.call<{ retention: { state: string } }>('/retention/state', guest)).retention.state, 'purged');
  // The lifecycle audit still passes for the cleared world (the sweep ran it fail-closed) and a second sweep is idle.
  assert.deepEqual(await f.call('/retention/sweep'), { processed: 0, failed: 0, error: null });
  assert.deepEqual((await state(f)).archive, started.archive);
  // The other player's chats were never touched.
  assert.equal((await state(f)).archive.filter((r) => String(r.text).includes('另一位')).length, 0);
});

test('the 180-day inactivity purge archives the transcript too, and an active login is not purged or archived', async (t) => {
  const f = setup(t, true);
  await f.call('/assets');
  const idle = await player(f),
    active = await player(f, '常来的玩家');
  await f.call('/retention/seed-logins', { ...idle, lastSeenAgoMs: 181 * DAY });
  await f.call('/retention/seed-logins', { ...active, lastSeenAgoMs: 2 * DAY });
  assert.deepEqual(await f.call('/retention/sweep'), { processed: 1, failed: 0, error: null });
  const after = await state(f);
  assert.ok(after.archive.length >= 2);
  assert.ok(
    after.archive.every((r) => !String(r.text).includes('常来的玩家')),
    'the active player is untouched',
  );
  assert.deepEqual(
    after.codes.map((c) => c.principal_id),
    [active.principalId],
  );
  // The names seeded by seed-logins ('昵称') and by the review seed ('阿泡') are both hidden.
  assert.ok(!JSON.stringify(after.archive).includes('阿泡'));
});

test('flag off: the same purge archives nothing and still removes the live rows', async (t) => {
  const f = setup(t, false);
  await f.call('/assets');
  const guest = await player(f);
  assert.equal((await state(f)).codes.length, 1);
  await f.call('/retention/expire', guest);
  assert.deepEqual(await f.call('/retention/sweep'), { processed: 1, failed: 0, error: null });
  assert.deepEqual(await state(f), { codes: [], notices: 0, archive: [] });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { localRuntime } from '../../cloudflare/runtime.ts';

type Guest = { principalId: string; csrf: string; issuedToken: string };
type State = {
  messages: number;
  outputs: number;
  attempts: { phase: string; state: string; charged_micros: number }[];
  operations: { status: string; quota_state: string }[];
  objects: { erased: boolean; size: number; type: string }[];
};
const setup = (t: test.TestContext) =>
  localRuntime(
    t,
    'tests/web/fixtures/cloudflare-character-deletion-worker.ts',
    { STATE: 'WebCharacterDeletionFixture' },
    ['MEDIA'],
  );
async function admit(f: ReturnType<typeof setup>, guest: Guest, characterId = 'wei-guagua') {
  return f.call<{ operationId: string }>('/admit', {
    token: guest.issuedToken,
    csrf: guest.csrf,
    origin: 'https://fixture.invalid',
    ipHash: 'a'.repeat(64),
    input: { requestId: randomUUID(), characterId, text: '角色删除后这条私人消息必须清理' },
  });
}
async function remove(f: ReturnType<typeof setup>) {
  const preview = await f.call<{ previewHash: string }>('/deletion/preview');
  return f.call('/deletion/start', {
    input: { requestId: randomUUID(), previewHash: preview.previewHash, acknowledgeDeleteAllChats: true },
  });
}
async function waitHeld(f: ReturnType<typeof setup>) {
  for (const deadline = Date.now() + 10_000; Date.now() < deadline; ) {
    if (await f.call<boolean>('/retention/waiting')) return;
    await sleep(20);
  }
  assert.fail('fault gate was not reached');
}
const cleared = (state: State) => {
  assert.equal(state.messages, 0);
  assert.equal(state.outputs, 0);
  assert.ok(state.objects.every((r) => r.erased && r.size === 0 && r.type === 'application/x-web-erased'));
};

test('character deletion guards immutable SQL, clears two scoped guests and preserves bills, quotas and approved clips across restart', async (t) => {
  const f = setup(t),
    fixed = await f.call<string[]>('/assets');
  const guests = [await f.call<Guest>('/bootstrap', {}), await f.call<Guest>('/bootstrap', {})];
  for (const guest of guests) await f.call('/run', await admit(f, guest));
  const before = await Promise.all(guests.map((g) => f.call<State>('/retention/state', g)));
  const counts = await f.call('/counts');
  await f.call('/retention/capture-replay', guests[0]);
  assert.match(
    (await f.call<{ error: string }>('/retention/unsafe-delete', guests[0], 409)).error,
    /WEB_PROVIDER_OUTPUT_IMMUTABLE/,
  );
  const preview = await f.call<any>('/deletion/preview');
  assert.equal(preview.conversations, 2);
  assert.ok(preview.messages >= 4);
  const input = { requestId: randomUUID(), previewHash: preview.previewHash, acknowledgeDeleteAllChats: true };
  const job = await f.call<any>('/deletion/start', { input });
  assert.equal(job.state, 'purging');
  assert.deepEqual(await f.call('/deletion/start', { input }), job);
  assert.equal(
    (await f.call<any>('/deletion/start', { input: { ...input, previewHash: '0'.repeat(64) } }, 409)).error,
    'IDEMPOTENCY_CONFLICT',
  );
  const done = await f.call<any>('/deletion/sweep');
  assert.equal(done.state, 'deleted', JSON.stringify(done));
  for (const [i, guest] of guests.entries()) {
    const after = await f.call<State>('/retention/state', guest);
    cleared(after);
    assert.deepEqual(after.attempts, before[i]!.attempts);
    const metadata = await f.call<any>('/deletion/state', guest);
    assert.deepEqual(metadata.gates, []);
    assert.deepEqual(metadata.fk, []);
    assert.ok(
      metadata.external.every((a: any) => a.receipt_json === null && a.usage_json === null && a.receipt_digest),
    );
  }
  const replay = await f.call<any>('/retention/replay');
  assert.equal(replay.same.duplicate, true);
  assert.equal(replay.conflict, 'WEB_PROVIDER_RECEIPT_CONFLICT');
  assert.deepEqual(await f.call('/counts'), counts);
  for (const index of [0, 4]) await f.call('/welcome', { mediaId: fixed[index] });
  assert.equal((await f.call<any>('/welcome', { mediaId: fixed[2] }, 409)).error, 'NOT_FOUND');
  await f.restart();
  assert.equal((await f.call<any>('/deletion/sweep')).state, 'deleted');
  for (const g of guests) cleared(await f.call<State>('/retention/state', g));
  assert.deepEqual(await f.call('/counts'), counts);
  assert.equal(
    (
      await f.call<any>(
        '/admit',
        {
          token: guests[0]!.issuedToken,
          csrf: guests[0]!.csrf,
          origin: 'https://fixture.invalid',
          ipHash: 'a'.repeat(64),
          input: { requestId: randomUUID(), characterId: 'wei-guagua', text: 'must reject' },
        },
        409,
      )
    ).error,
    'WEB_CHARACTER_UNAVAILABLE',
  );
});

test('impact hash rejects changed chats; unknown private tables block without mutation; failed R2 erasure resumes after restart', async (t) => {
  const f = setup(t);
  await f.call('/assets');
  const guest = await f.call<Guest>('/bootstrap', {});
  const old = await f.call<any>('/deletion/preview');
  await f.call('/run', await admit(f, guest));
  assert.equal(
    (
      await f.call<any>(
        '/deletion/start',
        { input: { requestId: randomUUID(), previewHash: old.previewHash, acknowledgeDeleteAllChats: true } },
        409,
      )
    ).error,
    'DELETION_PREVIEW_CHANGED',
  );
  await remove(f);
  await f.call('/deletion/unknown', guest);
  const blocked = await f.call<any>('/deletion/sweep');
  assert.equal(blocked.errorCode, 'CHARACTER_DELETION_UNHANDLED_CONTENT');
  assert.equal(blocked.databaseCleared, 0);
  assert.ok((await f.call<State>('/retention/state', guest)).outputs > 0);
  await f.call('/deletion/unknown', { clear: true });
  await f.call('/retention/mode', { mode: 'erase-fail' });
  const pending = await f.call<any>('/deletion/sweep');
  assert.equal(pending.errorCode, 'OFFLINE_ERASE_FAILED');
  assert.equal(pending.databaseCleared, 1);
  assert.equal(pending.audioCleared, 0);
  const interim = await f.call<State>('/retention/state', guest);
  assert.equal(interim.messages, 0);
  assert.equal(interim.outputs, 0);
  assert.ok(interim.objects.some((r) => r.size > 0));
  const counts = await f.call('/counts');
  await f.restart();
  const done = await f.call<any>('/deletion/sweep');
  assert.equal(done.state, 'deleted');
  assert.equal(done.errorCode, null);
  cleared(await f.call<State>('/retention/state', guest));
  assert.deepEqual(await f.call('/counts'), counts);
});

for (const mode of ['put-before', 'put-after', 'text-late'])
  test(`character deletion fences late ${mode}; known usage still settles without resurrecting content`, async (t) => {
    const f = setup(t);
    await f.call('/assets');
    const guest = await f.call<Guest>('/bootstrap', {});
    const op = await admit(f, guest);
    await f.call('/retention/mode', { mode });
    const pending = f.call('/run', op, 409);
    await waitHeld(f);
    await remove(f);
    const done = await f.call<any>('/deletion/sweep');
    assert.equal(done.state, 'deleted', JSON.stringify(done));
    cleared(await f.call<State>('/retention/state', guest));
    await f.call('/retention/release');
    await pending;
    const after = await f.call<State>('/retention/state', guest);
    cleared(after);
    assert.deepEqual(after.operations, [{ status: 'failed', quota_state: 'released' }]);
    assert.ok(after.attempts.every((a) => a.state === 'known' && a.charged_micros > 0));
    const counts = await f.call('/counts');
    await f.restart();
    cleared(await f.call<State>('/retention/state', guest));
    assert.deepEqual(await f.call('/counts'), counts);
  });

test('deleting a role with unknown supplier usage neither releases the hold nor retries after restart', async (t) => {
  const f = setup(t);
  await f.call('/assets');
  const guest = await f.call<Guest>('/bootstrap', {});
  const op = await admit(f, guest);
  await f.call('/retention/mode', { mode: 'unknown' });
  await f.call('/run', op, 409);
  const before = await f.call<any>('/counts');
  assert.ok(before.budgets.some((r: any) => r.held_micros > 0));
  await remove(f);
  assert.equal((await f.call<any>('/deletion/sweep')).state, 'deleted');
  await f.restart();
  const after = await f.call<State>('/retention/state', guest);
  cleared(after);
  assert.ok(after.attempts.some((a) => a.state === 'unknown'));
  assert.deepEqual((await f.call<any>('/counts')).budgets, before.budgets);
  await f.call('/run', op, 409);
  assert.deepEqual((await f.call<any>('/counts')).budgets, before.budgets);
});

for (const first of ['deletion', 'retention'])
  test(`character deletion and guest retention compose with ${first} first`, async (t) => {
    const f = setup(t);
    await f.call('/assets');
    const guest = await f.call<Guest>('/bootstrap', {});
    await f.call('/run', await admit(f, guest));
    await f.call('/retention/capture-replay', guest);
    const counts = await f.call('/counts');
    const expire = async () => {
      await f.call('/retention/expire', guest);
      assert.deepEqual(await f.call('/retention/sweep'), { processed: 1, failed: 0, error: null });
    };
    if (first === 'retention') await expire();
    await remove(f);
    const done = await f.call<any>('/deletion/sweep');
    assert.equal(done.state, 'deleted', JSON.stringify(done));
    if (first === 'deletion') await expire();
    const replay = await f.call<any>('/retention/replay');
    assert.equal(replay.same.duplicate, true);
    assert.equal(replay.conflict, 'WEB_PROVIDER_RECEIPT_CONFLICT');
    cleared(await f.call<State>('/retention/state', guest));
    assert.deepEqual(await f.call('/counts'), counts);
    await f.restart();
    cleared(await f.call<State>('/retention/state', guest));
  });

import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { localRuntime } from '../../cloudflare/runtime.ts';

type Guest = { principalId: string; csrf: string; issuedToken: string };
type State = {
  retention: { state: string; db_cleared_at: number | null };
  messages: number;
  outputs: number;
  attempts: { phase: string; state: string; outcome: string; charged_micros: number }[];
  operations: { status: string; quota_state: string }[];
  objects: { erased: boolean; size: number; type: string }[];
  due: number | null;
};
const setup = (t: test.TestContext) =>
  localRuntime(t, 'tests/web/fixtures/cloudflare-retention-worker.ts', { STATE: 'WebRetentionFixture' }, ['MEDIA']);
const origin = 'https://fixture.invalid';
async function admit(f: ReturnType<typeof setup>, guest: Guest) {
  return f.call<{ operationId: string }>('/admit', {
    token: guest.issuedToken,
    csrf: guest.csrf,
    origin,
    ipHash: 'a'.repeat(64),
    input: { requestId: 'retention-round', characterId: 'wei-guagua', text: '本条私人内容应在到期后清理' },
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
  assert.equal(state.retention.state, 'purged');
  assert.ok(state.retention.db_cleared_at);
  assert.equal(state.messages, 0);
  assert.equal(state.outputs, 0);
  assert.ok(state.objects.every((row) => row.erased && row.size === 0 && row.type === 'application/x-web-erased'));
};

test('cloud retention erases guest SQL/R2 content, preserves bills/IP quota, fixed clips and protected invite history', async (t) => {
  const f = setup(t),
    fixed = await f.call<string[]>('/assets');
  const guest = await f.call<Guest>('/bootstrap', {}),
    invited = await f.call<Guest>('/bootstrap', {});
  for (const actor of [guest, invited]) {
    const op = await admit(f, actor);
    await f.call('/run', op);
  }
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
  const protectedState = await f.call<State>('/retention/state', invited);
  const counts = await f.call('/counts'),
    before = await f.call<State>('/retention/state', guest);
  await f.call('/retention/capture-replay', guest);
  const denied = await f.call<{ error: string }>('/retention/unsafe-delete', guest, 409);
  assert.match(denied.error, /WEB_PROVIDER_OUTPUT_IMMUTABLE/);
  await f.call('/retention/expire', guest);
  assert.deepEqual(await f.call('/retention/sweep'), { processed: 1, failed: 0, error: null });
  cleared(await f.call<State>('/retention/state', guest));
  const replay = await f.call<{ same: { duplicate: boolean }; conflict: string }>('/retention/replay');
  assert.equal(replay.same.duplicate, true);
  assert.equal(replay.conflict, 'WEB_PROVIDER_RECEIPT_CONFLICT');
  assert.deepEqual((await f.call<State>('/retention/state', guest)).attempts, before.attempts);
  assert.deepEqual(await f.call('/counts'), counts);
  assert.deepEqual(await f.call('/retention/state', invited), { ...protectedState, due: null });
  for (const index of [0, 2, 4]) await f.call('/welcome', { mediaId: fixed[index] });
  await f.restart();
  assert.deepEqual(await f.call('/retention/sweep'), { processed: 0, failed: 0, error: null });
  cleared(await f.call<State>('/retention/state', guest));
  assert.deepEqual(await f.call('/counts'), counts);
});

test('retention fails closed on unknown private tables; failed R2 erasure resumes after restart', async (t) => {
  const f = setup(t);
  await f.call('/assets');
  const guest = await f.call<Guest>('/bootstrap', {});
  const op = await admit(f, guest);
  await f.call('/run', op);
  await f.call('/retention/unknown-table', guest);
  await f.call('/retention/expire', guest);
  assert.deepEqual(await f.call('/retention/sweep'), {
    processed: 1,
    failed: 1,
    error: 'WEB_RETENTION_UNEXPECTED_WORLD_DATA',
  });
  const blocked = await f.call<State>('/retention/state', guest);
  assert.equal(blocked.retention.db_cleared_at, null);
  assert.ok(blocked.outputs > 0);
  await f.call('/retention/unknown-table', { ...guest, mode: 'clear' });
  await f.call('/retention/mode', { mode: 'erase-fail' });
  assert.deepEqual(await f.call('/retention/sweep'), { processed: 1, failed: 1, error: 'OFFLINE_ERASE_FAILED' });
  const pending = await f.call<State>('/retention/state', guest);
  assert.equal(pending.outputs, 0);
  assert.equal(pending.retention.state, 'purging');
  assert.ok(pending.retention.db_cleared_at);
  assert.ok(pending.objects.some((row) => !row.erased && row.size > 0));
  const counts = await f.call('/counts');
  await f.restart();
  assert.deepEqual(await f.call('/retention/sweep'), { processed: 1, failed: 0, error: null });
  cleared(await f.call<State>('/retention/state', guest));
  assert.deepEqual(await f.call('/counts'), counts);
});

for (const mode of ['put-before', 'put-after', 'text-late'])
  test(`retention prevents late ${mode} from restoring erased content while settling observed usage`, async (t) => {
    const f = setup(t);
    await f.call('/assets');
    const guest = await f.call<Guest>('/bootstrap', {});
    const op = await admit(f, guest);
    await f.call('/retention/mode', { mode });
    const pending = f.call<{ error: string }>('/run', op, 409);
    await waitHeld(f);
    await f.call('/retention/expire', guest);
    assert.deepEqual(await f.call('/retention/sweep'), { processed: 1, failed: 0, error: null });
    cleared(await f.call<State>('/retention/state', guest));
    await f.call('/retention/release');
    await pending;
    const after = await f.call<State>('/retention/state', guest);
    cleared(after);
    assert.deepEqual(after.operations, [{ status: 'failed', quota_state: 'released' }]);
    assert.ok(after.attempts.every((row) => row.state === 'known' && row.charged_micros > 0));
    const counts = await f.call('/counts');
    await f.restart();
    cleared(await f.call<State>('/retention/state', guest));
    assert.deepEqual(await f.call('/counts'), counts);
  });

test('retention does not release unknown provider spend or regenerate after restart', async (t) => {
  const f = setup(t);
  await f.call('/assets');
  const guest = await f.call<Guest>('/bootstrap', {});
  const op = await admit(f, guest);
  await f.call('/retention/mode', { mode: 'unknown' });
  await f.call('/run', op, 409);
  const before = await f.call<any>('/counts');
  assert.ok(before.budgets.some((row: any) => row.held_micros > 0));
  await f.call('/retention/expire', guest);
  assert.deepEqual(await f.call('/retention/sweep'), { processed: 1, failed: 0, error: null });
  await f.restart();
  const state = await f.call<State>('/retention/state', guest);
  cleared(state);
  assert.ok(state.attempts.some((row) => row.state === 'unknown'));
  assert.deepEqual((await f.call<any>('/counts')).budgets, before.budgets);
  await f.call('/run', op, 409);
  assert.deepEqual((await f.call<any>('/counts')).budgets, before.budgets);
});

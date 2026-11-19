import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { localRuntime } from '../../cloudflare/runtime.ts';

type Guest = { principalId: string; issuedToken: string; csrf: string };
type State = {
  alarm: number | null;
  coordinator: { epoch: number };
  operations: { id: string; status: string; quota_state: string }[];
  attempts: { phase: string; state: string; outcome: string | null; held_micros: number }[];
  external: { phase: string; dispatch_state: string; outcome: string | null }[];
  capacity: { provider: string; stage: string; phase: string; reserved: number }[];
  stageAttempts: { stage: string; attempt: number; provider_request_id: string }[];
  publications: number;
  shared: { settled: number }[];
  reserveLog: number;
  calls: { provider: string; n: number }[];
  spending: { provider: string; spent_micros: number; held_micros: number }[];
};
const setup = (t: test.TestContext) =>
  localRuntime(t, 'tests/web/fixtures/cloudflare-requeue-43-worker.ts', { STATE: 'WebRequeueFixture' }, ['MEDIA']);
async function until(f: ReturnType<typeof setup>, predicate: (value: State) => boolean, milliseconds = 60_000) {
  const end = Date.now() + milliseconds;
  do {
    const value = await f.call<State>('/requeue-status');
    if (predicate(value)) return value;
    assert.ok(Date.now() < end, JSON.stringify(value));
    await sleep(100);
  } while (true);
}

// A real workerd restart between the committed intent and the send gate of the first draft: the reply is delayed, not lost.
for (const mode of ['before-reserve', 'after-reserve'] as const)
  test(`Part 43 workerd: restart between intent and send (${mode}) re-queues the draft; reply published once, nothing resent`, async (t) => {
    const f = setup(t);
    await f.call('/assets');
    const guest = await f.call<Guest>('/bootstrap', {});
    await f.call('/hold', { mode });
    await f.call('/admit', {
      token: guest.issuedToken,
      csrf: guest.csrf,
      origin: 'https://fixture.invalid',
      ipHash: 'a'.repeat(64),
      input: { characterId: 'wei-guagua', requestId: 'requeue-1', text: '重启之前' },
    });
    // The intent is durable (local hold + ticket); the send gate was never crossed.
    const held = await until(f, (s) => s.attempts.some((row) => row.phase === 'draft' && row.state === 'not_sent'));
    assert.ok(held.attempts[0]!.held_micros > 0);
    assert.equal(held.calls.find((row) => row.provider === 'text')?.n ?? 0, 0);
    assert.equal(held.reserveLog, mode === 'after-reserve' ? 1 : 0);
    const epoch = held.coordinator.epoch;
    await f.restart();
    const done = await until(f, (s) => s.operations[0]?.status === 'published' && s.alarm === null, 90_000);
    assert.ok(done.coordinator.epoch > epoch, 'the old coordinator was taken over');
    assert.equal(done.operations[0]!.quota_state, 'used');
    assert.equal(done.publications, 1, 'published exactly once');
    // Re-queued exactly once; the draft and the review were each sent exactly once afterwards.
    assert.deepEqual(
      done.stageAttempts.map((row) => [row.stage, row.attempt, row.provider_request_id]),
      [['text', 1, 'requeue:draft:-1']],
    );
    assert.equal(done.calls.find((row) => row.provider === 'text')!.n, 2);
    // Budget was reserved again before the call, never duplicated: one shared reservation per local attempt, all settled.
    assert.equal(done.reserveLog, done.attempts.length);
    assert.ok(done.shared.length === done.attempts.length && done.shared.every((row) => row.settled === 1));
    assert.ok(done.attempts.every((row) => row.state === 'known' && row.outcome === 'succeeded'));
    // Ledger positions: every capacity ticket and every provider hold is back to zero.
    assert.ok(
      done.capacity.every((row) => row.reserved === 0),
      JSON.stringify(done.capacity),
    );
    assert.ok(
      done.spending.every((row) => row.held_micros === 0),
      JSON.stringify(done.spending),
    );
  });

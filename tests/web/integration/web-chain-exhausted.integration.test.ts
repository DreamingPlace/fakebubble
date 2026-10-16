import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptedAuditEnvelope } from '../../text-fixtures.ts';
import { ensureBalance, reconcilePoints } from '../../../apps/server/admission/web-points.ts';
import { draftArgs, modelFixture, wire, type FetchCall } from '../fixtures/model-choice.ts';

/**
 * Part 21d: when every model of a stage's chain failed definitely-not-billed the operation ends as failed AT ONCE (quota
 * released, points refunded by reconcile) instead of at its 5 minute deadline; a 429 on the LAST model gets the same 2/4/8 s
 * backoff as DeepSeek before that. UNKNOWN is untouched (see web-model-routing).
 */
const DRAFT = 'submit_dialogue_draft';
const providers = (calls: FetchCall[]) =>
  calls.map((call) => `${call.provider}:${call.tool === DRAFT ? 'draft' : 'review'}`);
const operation = (f: ReturnType<typeof modelFixture>) => ({
  ...f.get<{ status: string; quota_state: string }>(
    "SELECT status,quota_state FROM web_operations WHERE id='operation'",
  )!,
});

test('the next model cannot even be started (no key): the operation fails at once, quota released, points refunded', async (t) => {
  const f = modelFixture(t, {
    chosen: 'deepseek',
    keys: { xai: 'offline-xai' }, // no Gemini key: the last model of the chain is unavailable
    fetch: (call, _n, request) =>
      call.provider === 'deepseek' && call.tool === DRAFT
        ? new Response('{}', { status: 429 })
        : Response.json(acceptedAuditEnvelope(request)),
  });
  // Charged at admission like production does; reconcile gives it back once the operation has ended without a reply.
  ensureBalance(f.store as never, f.clock.now(), 'principal');
  f.store.run("UPDATE web_operation_models SET points_charged=12 WHERE operation_id='operation'");
  f.store.run("UPDATE web_points_balance SET balance=balance-12 WHERE principal_id='principal'");
  const before = f.get<{ balance: number }>(
    "SELECT balance FROM web_points_balance WHERE principal_id='principal'",
  )!.balance;

  await assert.rejects(f.runText(), /MODEL_UNAVAILABLE/);
  assert.deepEqual(providers(f.calls), ['deepseek:draft'], 'DeepSeek was tried; Gemini never started');
  assert.deepEqual(operation(f), { status: 'failed', quota_state: 'released' }, 'ended now, not at the deadline');
  assert.ok(f.clock.now() < 1_700_000_300_000, 'the 5 minute deadline has not been reached');
  assert.equal(
    [...f.budget.entries.values()].every((entry) => entry.settled),
    true,
    'every shared reservation settled, none released',
  );
  assert.equal(f.spending('deepseek').held_micros, 0);

  reconcilePoints(f.store as never, f.clock.now(), 'principal');
  assert.equal(
    f.get<{ balance: number }>("SELECT balance FROM web_points_balance WHERE principal_id='principal'")!.balance,
    before + 12,
    'full refund',
  );
  assert.equal(
    f.get<{ settled: number }>("SELECT settled FROM web_operation_models WHERE operation_id='operation'")!.settled,
    1,
  );
});

test('429 on the LAST model: the same 2/4/8 s backoff as DeepSeek, then the reply is written by that model', async (t) => {
  let geminiDrafts = 0;
  const f = modelFixture(t, {
    chosen: 'deepseek',
    fetch: (call, _n, request) => {
      if (call.tool === DRAFT && call.provider === 'deepseek') return new Response('{}', { status: 429 });
      if (call.provider === 'gemini') {
        if (++geminiDrafts <= 2) return wire.error.geminiRateLimit();
        return Response.json(wire.gemini(call.tool, draftArgs(request)));
      }
      return Response.json(acceptedAuditEnvelope(request));
    },
  });
  assert.equal(await f.runText(), null, 'returned for a retry, not failed');
  assert.deepEqual(providers(f.calls), ['deepseek:draft', 'gemini:draft']);
  assert.equal(operation(f).status, 'queued');
  assert.equal(f.queue.claimText(f.lease, 'text-worker'), null, 'not before the backoff');
  f.advance(2000);
  assert.equal(await f.runner.runText(f.queue.claimText(f.lease, 'text-worker')!, f.signal()), null, 'second 429: 4 s');
  assert.equal(operation(f).status, 'queued');
  f.advance(3999);
  assert.equal(f.queue.claimText(f.lease, 'text-worker'), null);
  f.advance(1);
  const reply = await f.runner.runText(f.queue.claimText(f.lease, 'text-worker')!, f.signal());
  assert.ok(reply, 'third try succeeds');
  assert.deepEqual(providers(f.calls), [
    'deepseek:draft',
    'gemini:draft',
    'gemini:draft',
    'gemini:draft',
    'deepseek:review',
  ]);
  assert.equal(f.models()!.draft_provider, 'gemini');
  assert.equal(
    [...f.budget.entries.values()].every((entry) => entry.settled),
    true,
  );
});

test('429 on the last model for good: after the backoffs the operation fails and is refunded, nothing is left held', async (t) => {
  const f = modelFixture(t, {
    chosen: 'deepseek',
    fetch: (call, _n, request) =>
      call.tool === DRAFT && call.provider === 'deepseek'
        ? new Response('{}', { status: 429 })
        : call.provider === 'gemini'
          ? wire.error.geminiRateLimit()
          : Response.json(acceptedAuditEnvelope(request)),
  });
  assert.equal(await f.runText(), null);
  for (const backoff of [2000, 4000, 8000]) {
    f.advance(backoff);
    const claim = f.queue.claimText(f.lease, 'text-worker')!;
    assert.ok(claim, `claimable after ${backoff} ms`);
    if (backoff === 8000) await assert.rejects(f.runner.runText(claim, f.signal()), /GEMINI_RATE_LIMITED/);
    else assert.equal(await f.runner.runText(claim, f.signal()), null);
  }
  assert.equal(providers(f.calls).filter((call) => call === 'gemini:draft').length, 4, 'first call plus three retries');
  assert.deepEqual(operation(f), { status: 'failed', quota_state: 'released' });
  assert.equal(f.spending('gemini').held_micros + f.spending('deepseek').held_micros, 0);
  assert.equal(f.spending('gemini').spent_micros, 0, 'a 429 is never billed');
  assert.equal(
    [...f.budget.entries.values()].every((entry) => entry.settled),
    true,
  );
});

test('a possibly-sent last model (UNKNOWN) is untouched: no fail-fast, the reservation stays held', async (t) => {
  const f = modelFixture(t, {
    chosen: 'deepseek',
    fetch: (call, _n, request) =>
      call.tool === DRAFT && call.provider === 'deepseek'
        ? new Response('{}', { status: 429 })
        : call.provider === 'gemini'
          ? new Response('{"error":"boom"}', { status: 500 })
          : Response.json(acceptedAuditEnvelope(request)),
  });
  await assert.rejects(f.runText());
  assert.equal(f.attempts()[0]!.state, 'unknown');
  assert.equal(operation(f).status, 'text_running', 'waits for its deadline / reconciliation as before');
  assert.ok(f.spending('gemini').held_micros > 0);
});

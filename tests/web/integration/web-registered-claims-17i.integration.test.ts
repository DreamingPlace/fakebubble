import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptedAuditEnvelope, draftEnvelope } from '../../text-fixtures.ts';
import { draftArgs, modelFixture, reviewArgs, wire, type FetchCall } from '../fixtures/model-choice.ts';
import { WebProviderExecutor } from '../../../apps/server/generation/web-provider-executor.ts';
import { WEB_LIMITS } from '../../../config/web-v1.ts';
import { DomainError } from '../../../packages/domain/errors.ts';
import type { WebRuntimeStore as WebStore } from '../../../apps/server/platform/web-store-contract.ts';

/**
 * Part 17i. A registered player (17h: a login and/or a signup bonus row) whose invite grant lapsed or whose trial window
 * is over was ADMITTED, but the stage queue never claimed the operation, so it died at its deadline with no draft. These
 * tests run the REAL stage queue claim and the REAL executor over a real schema-123 store: nothing is replayed.
 */
const DRAFT = 'submit_dialogue_draft';
const DAY = 86_400_000;
const answer =
  (chosen: 'deepseek' | 'xai' | 'gemini') =>
  (call: FetchCall, _n: number, request: Parameters<typeof draftArgs>[0]) => {
    if (call.provider === 'xai') return Response.json(wire.xai(call.tool, draftArgs(request)));
    if (call.provider === 'gemini')
      return Response.json(wire.gemini(call.tool, call.tool === DRAFT ? draftArgs(request) : reviewArgs(request)));
    void chosen;
    return Response.json(call.tool === DRAFT ? draftEnvelope(request) : acceptedAuditEnvelope(request));
  };

export type Shape = 'login-only-old' | 'guest-bonus-past-window' | 'plain-guest-past-window';

/** Rewrites the fixture's principal (a guest with a bonus inside its window) into the production shape under test. */
export function applyShape(store: ReturnType<typeof modelFixture>['store'], shape: Shape, now: number) {
  const login = () =>
    store.run(
      'INSERT INTO web_player_logins(principal_id,email_norm,password_hash,created_at,password_changed_at,last_seen_at) VALUES (?,?,?,?,?,?)',
      'principal',
      'player@example.com',
      'x',
      now - DAY,
      now - DAY,
      now - 1_000,
    );
  const dropBonus = () => store.run("DELETE FROM web_signup_bonus WHERE principal_id='principal'");
  const pastWindow = () =>
    store.run(
      "UPDATE web_guest_retention SET state='active',started_at=?,expires_at=? WHERE principal_id='principal'",
      now - 30 * DAY,
      now - 23 * DAY,
    );
  switch (shape) {
    case 'login-only-old':
      dropBonus();
      login();
      return pastWindow();
    case 'guest-bonus-past-window':
      return pastWindow();
    case 'plain-guest-past-window':
      dropBonus();
      return pastWindow();
  }
}

async function captured(run: () => Promise<void>) {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  try {
    await run();
  } finally {
    console.log = original;
  }
  return lines;
}

/** Managed executor passes (the production loop) until the operation is final or `capMs` of real time passed. */
async function drive(f: ReturnType<typeof modelFixture>, options: { step?: number; capMs?: number } = {}) {
  f.advance(WEB_LIMITS.coordinatorLeaseMs + 1);
  const executor = new WebProviderExecutor(f.store as unknown as WebStore, f.clock, f.runner, {
    hold: () => {},
    settled: async () => {},
  });
  try {
    const started = Date.now();
    while (
      !['published', 'failed', 'unknown'].includes(f.status()) &&
      Date.now() - started < (options.capMs ?? 10_000)
    ) {
      executor.managedPass('claims');
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (options.step) f.advance(options.step);
    }
    executor.managedPass('claims');
    await new Promise((resolve) => setTimeout(resolve, 10));
  } finally {
    await executor.close();
  }
}

const replyLines = (lines: string[]) =>
  lines.filter((line) => line.includes('"web_reply"')).map((line) => JSON.parse(line));

// Named exception (Part 22x): the 'lapsed-invite-login' and 'lapsed-invite-bonus' shapes (a kind-'invite' principal whose grant
// lapsed) are deleted with the legacy invite principals; migration 126 made them guests with a login / a bonus past their
// window, which are exactly the two shapes below, so the same claims and replies stay asserted for them.
const REGISTERED: Shape[] = ['login-only-old', 'guest-bonus-past-window'];
const MODELS = ['deepseek', 'xai', 'gemini'] as const;

for (const shape of REGISTERED)
  for (const chosen of MODELS) {
    test(`17i voice reply is PUBLISHED for ${shape} (${chosen}), through the real stage queue and executor`, async (t) => {
      const f = modelFixture(t, { chosen, fetch: answer(chosen) });
      applyShape(f.store, shape, f.clock.now());
      const lines = await captured(() => drive(f, { capMs: 4_000 }));
      assert.equal(
        f.status(),
        'published',
        `${shape}: ${f.get<{ failure_code: string }>("SELECT failure_code FROM web_operations WHERE id='operation'")?.failure_code}`,
      );
      const reply = replyLines(lines);
      assert.equal(reply.length, 1);
      assert.deepEqual([reply[0].outcome, reply[0].voice], ['published', true]);
      assert.ok(f.calls.length >= 2, 'draft and review were really called');
    });
  }

for (const shape of REGISTERED)
  test(`17i text reply (voice unavailable) is PUBLISHED for ${shape}`, async (t) => {
    const f = modelFixture(t, {
      chosen: 'deepseek',
      fetch: answer('deepseek'),
      fish: async () => {
        throw new DomainError('FISH_RATE_LIMITED');
      },
    });
    applyShape(f.store, shape, f.clock.now());
    const lines = await captured(() => drive(f, { capMs: 4_000, step: 2_500 }));
    assert.equal(f.status(), 'published', shape);
    const reply = replyLines(lines);
    assert.deepEqual([reply[0].outcome, reply[0].voice], ['published', false]);
  });

test('17i a plain guest past its window still gets TRIAL_EXPIRED and nothing runs', async (t) => {
  const f = modelFixture(t, { chosen: 'deepseek', fetch: answer('deepseek') });
  applyShape(f.store, 'plain-guest-past-window', f.clock.now());
  await captured(() => drive(f, { step: 20_000, capMs: 6_000 }));
  assert.equal(f.status(), 'failed');
  assert.equal(f.calls.length, 0, 'no provider was called');
  assert.equal(f.attempts().length, 0, 'no budget was reserved');
  // Admission answers TRIAL_EXPIRED (web-registered-17h 2a); an operation already queued dies at its deadline, unclaimed.
  assert.equal(f.get("SELECT 1 FROM web_stage_attempts WHERE operation_id='operation'"), undefined, 'no stage ran');
});

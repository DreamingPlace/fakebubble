import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptedAuditEnvelope, draftEnvelope } from '../../text-fixtures.ts';
import { draftArgs, modelFixture, reviewArgs, wire, type FetchCall } from '../fixtures/model-choice.ts';
import { WebProviderExecutor } from '../../../apps/server/generation/web-provider-executor.ts';
import { webReplyLine } from '../../../apps/server/generation/web-reply-telemetry.ts';
import { WEB_LIMITS } from '../../../config/web-v1.ts';
import { DomainError } from '../../../packages/domain/errors.ts';
import type { WebRuntimeStore as WebStore } from '../../../apps/server/platform/web-store-contract.ts';

const DRAFT = 'submit_dialogue_draft';
const answer =
  (rateLimitXai = false) =>
  (call: FetchCall, _n: number, request: Parameters<Parameters<typeof modelFixture>[1]['fetch']>[2]) => {
    if (call.provider === 'xai') {
      if (rateLimitXai) return wire.error.xaiRateLimit();
      return Response.json(wire.xai(call.tool, draftArgs(request)));
    }
    if (call.provider === 'gemini')
      return Response.json(wire.gemini(call.tool, call.tool === DRAFT ? draftArgs(request) : reviewArgs(request)));
    return Response.json(call.tool === DRAFT ? draftEnvelope(request) : acceptedAuditEnvelope(request));
  };

/** Capture console.log lines written while `run` executes. */
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

async function runToPublished(f: ReturnType<typeof modelFixture>) {
  await f.runText();
  f.advance(WEB_LIMITS.coordinatorLeaseMs + 1); // the fixture's own coordinator lease ends; the executor takes over
  const executor = new WebProviderExecutor(f.store as unknown as WebStore, f.clock, f.runner, {
    hold: () => {},
    settled: async () => {},
  });
  try {
    const started = Date.now();
    while (
      f.get<{ status: string }>("SELECT status FROM web_operations WHERE id='operation'")!.status !== 'published' &&
      Date.now() - started < 10_000
    ) {
      executor.managedPass('telemetry');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } finally {
    await executor.close();
  }
}

const KEYS = [
  'event',
  'outcome',
  'chosen',
  'draft',
  'review',
  'backup',
  'abandoned',
  'textMs',
  'audioMs',
  'voice',
  'pointsCharged',
];

test('a published reply logs exactly one web_reply line with the agreed fields', async (t) => {
  const f = modelFixture(t, { chosen: 'xai', fetch: answer() });
  const lines = await captured(() => runToPublished(f));
  const replies = lines.filter((line) => line.includes('"web_reply"'));
  assert.equal(replies.length, 1, lines.join('\n'));
  const line = JSON.parse(replies[0]!);
  assert.deepEqual(Object.keys(line), KEYS);
  assert.equal(line.event, 'web_reply');
  assert.equal(line.outcome, 'published');
  assert.equal(line.chosen, 'xai');
  assert.deepEqual(line.draft, { provider: 'xai', model: 'grok-4.7' });
  assert.deepEqual(line.review, { provider: 'deepseek', model: 'deepseek-v4-pro' });
  assert.equal(line.backup, false);
  assert.deepEqual(line.abandoned, []);
  assert.equal(line.voice, true);
  assert.equal(typeof line.pointsCharged, 'number');
});

test('a backup model is reported with the abandoned codes', async (t) => {
  const f = modelFixture(t, { chosen: 'xai', fetch: answer(true) });
  const lines = await captured(() => runToPublished(f));
  const line = JSON.parse(lines.find((l) => l.includes('"web_reply"'))!);
  assert.equal(line.backup, true);
  assert.deepEqual(line.abandoned, ['XAI_RATE_LIMITED']);
  assert.equal(line.draft.provider, 'deepseek');
  assert.equal(line.chosen, 'xai');
});

test('the line carries no id, content, principal or IP of any kind', async (t) => {
  const f = modelFixture(t, { chosen: 'gemini', fetch: answer() });
  const lines = await captured(() => runToPublished(f));
  const text = lines.find((l) => l.includes('"web_reply"'))!;
  // Every identifier and piece of content the fixture's operation is made of.
  const forbidden = [
    'operation',
    'principal',
    'player',
    'world',
    'conversation',
    'character',
    'input',
    'request',
    'fixture-instance',
    '合成',
    '192.0.2',
    'ip',
  ];
  for (const word of forbidden) assert.ok(!text.toLowerCase().includes(word), `${word} in ${text}`);
  assert.doesNotMatch(text, /[0-9a-f]{16,}/i, 'no hash / uuid-like value');
});

test('failed and UNKNOWN replies are reported; an unfinished or cancelled one is not', () => {
  // A reader holding only the operation status: a database without the Part 21b tables still yields a line.
  const reader = (status: string) =>
    ({
      get: (sql: string) => (sql.includes('FROM web_operations') ? { status } : undefined),
      all: () => [],
    }) as never;
  for (const status of ['failed', 'unknown'] as const) {
    const line = webReplyLine(reader(status), 'x')!;
    assert.equal(line.outcome, status);
    assert.equal(line.chosen, null);
    assert.equal(line.pointsCharged, 0, 'no reply, no charge');
    assert.equal(line.voice, false);
  }
  for (const status of ['queued', 'text_running', 'ready_to_publish', 'cancelled'])
    assert.equal(webReplyLine(reader(status), 'x'), null, status);
});

// ---- Part 21i: every path that finishes a reply reports it exactly once, from the object that runs the executor --------------------

const replyLines = (lines: string[]) =>
  lines.filter((line) => line.includes('"web_reply"')).map((line) => JSON.parse(line));

/**
 * Runs managed passes until the operation is final. `restart` makes every pass a NEW executor (the object was evicted and
 * woke again: nothing in memory survives); `step` moves the clock between passes (waiting out a backoff).
 */
async function drive(
  f: ReturnType<typeof modelFixture>,
  options: { restart?: boolean; step?: number; until?: string[] } = {},
) {
  f.advance(WEB_LIMITS.coordinatorLeaseMs + 1);
  const until = options.until ?? ['published', 'failed', 'unknown'];
  const make = () =>
    new WebProviderExecutor(f.store as unknown as WebStore, f.clock, f.runner, {
      hold: () => {},
      settled: async () => {},
    });
  let executor = make();
  try {
    const started = Date.now();
    while (
      !until.includes(f.get<{ status: string }>("SELECT status FROM web_operations WHERE id='operation'")!.status) &&
      Date.now() - started < 10_000
    ) {
      executor.managedPass('telemetry');
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (options.step) f.advance(options.step);
      if (options.restart) {
        await executor.close();
        executor = make();
      }
    }
    // One more look, as the next alarm would take.
    executor.managedPass('telemetry');
    await new Promise((resolve) => setTimeout(resolve, 10));
  } finally {
    await executor.close();
  }
}

test('Part 21i voice reply: one line, with voice true', async (t) => {
  const f = modelFixture(t, { chosen: null, fetch: answer() });
  await f.runText();
  const lines = replyLines(await captured(() => drive(f)));
  assert.equal(lines.length, 1);
  assert.deepEqual([lines[0].outcome, lines[0].voice, lines[0].backup], ['published', true, false]);
});

test('Part 21i the object restarts between every pass: still exactly one line, and none while the reply is unfinished', async (t) => {
  const f = modelFixture(t, { chosen: 'xai', fetch: answer() });
  const lines = replyLines(await captured(() => drive(f, { restart: true })));
  assert.equal(f.status(), 'published');
  assert.equal(lines.length, 1, JSON.stringify(lines));
  assert.equal(lines[0].outcome, 'published');
  assert.equal(lines[0].chosen, 'xai');
});

test('Part 21i recovery after a restart: a reply found ready to publish by a NEW executor is reported by it', async (t) => {
  const f = modelFixture(t, { chosen: null, fetch: answer() });
  await f.runText();
  // The previous object claimed the publication (ready_to_publish) and was evicted before it committed.
  for (
    let claim = f.queue.claimAudio(f.lease, 'audio-worker');
    claim;
    claim = f.queue.claimAudio(f.lease, 'audio-worker')
  )
    await f.runner.runSpeech(claim, f.signal());
  const { WebVerticalPublisher } = await import('../../../apps/server/conversation/web-vertical-publisher.ts');
  const publisher = new WebVerticalPublisher(f.store as unknown as WebStore, f.clock);
  publisher.claim(f.lease, 'operation', 'provider-publisher');
  assert.equal(f.status(), 'ready_to_publish');
  const lines = replyLines(await captured(() => drive(f)));
  assert.equal(f.status(), 'published');
  assert.equal(lines.length, 1, JSON.stringify(lines));
  assert.equal(lines[0].outcome, 'published');
});

test('Part 21i voice to text fallback (Fish rate limited): one line, voice false', async (t) => {
  const f = modelFixture(t, {
    chosen: null,
    fetch: answer(),
    fish: async () => {
      throw new DomainError('FISH_RATE_LIMITED');
    },
  });
  await f.runText();
  const lines = replyLines(await captured(() => drive(f, { step: 2_500 })));
  assert.equal(f.status(), 'published');
  assert.equal(lines.length, 1, JSON.stringify(lines));
  assert.deepEqual([lines[0].outcome, lines[0].voice], ['published', false]);
  // And the same when the object restarts between every pass.
  const g = modelFixture(t, {
    chosen: null,
    fetch: answer(),
    fish: async () => {
      throw new DomainError('FISH_RATE_LIMITED');
    },
  });
  await g.runText();
  const again = replyLines(await captured(() => drive(g, { step: 2_500, restart: true })));
  assert.equal(again.length, 1, JSON.stringify(again));
  assert.deepEqual([again[0].outcome, again[0].voice], ['published', false]);
});

test('Part 21i backup model: one line naming the abandoned code, also across restarts', async (t) => {
  const f = modelFixture(t, { chosen: 'xai', fetch: answer(true) });
  const lines = replyLines(await captured(() => drive(f, { restart: true })));
  assert.equal(lines.length, 1, JSON.stringify(lines));
  assert.deepEqual([lines[0].backup, lines[0].abandoned], [true, ['XAI_RATE_LIMITED']]);
});

test('Part 21i a reply that expires is reported once as failed; an UNKNOWN one once as unknown, and its later expiry adds nothing', async (t) => {
  const f = modelFixture(t, { chosen: null, fetch: answer() });
  // The deadline passes before anything could finish it.
  f.advance(WEB_LIMITS.coordinatorLeaseMs + 1);
  f.store.run("UPDATE web_operations SET deadline_at=? WHERE id='operation'", f.clock.now() + 1);
  f.advance(10);
  const failed = replyLines(await captured(() => drive(f)));
  assert.equal(f.status(), 'failed');
  assert.equal(failed.length, 1, JSON.stringify(failed));
  assert.deepEqual([failed[0].outcome, failed[0].pointsCharged], ['failed', 0]);

  const g = modelFixture(t, { chosen: null, fetch: answer() });
  const executor = new WebProviderExecutor(g.store as unknown as WebStore, g.clock, g.runner, {
    hold: () => {},
    settled: async () => {},
  });
  g.advance(WEB_LIMITS.coordinatorLeaseMs + 1);
  const lines = await captured(async () => {
    executor.managedPass('telemetry');
    g.store.run("UPDATE web_operations SET status='unknown',stage_version=stage_version+1 WHERE id='operation'");
    executor.managedPass('telemetry');
    g.advance(1_000_000);
    executor.managedPass('telemetry'); // expiry of the unknown reply
    await new Promise((resolve) => setTimeout(resolve, 10));
    executor.managedPass('telemetry');
  });
  await executor.close();
  const unknown = replyLines(lines);
  assert.equal(unknown.length, 1, JSON.stringify(unknown));
  assert.equal(unknown[0].outcome, 'unknown');
});

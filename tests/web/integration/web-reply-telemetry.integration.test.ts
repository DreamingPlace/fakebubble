import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptedAuditEnvelope, draftEnvelope } from '../../text-fixtures.ts';
import { draftArgs, modelFixture, reviewArgs, wire, type FetchCall } from '../fixtures/model-choice.ts';
import { WebProviderExecutor } from '../../../apps/server/generation/web-provider-executor.ts';
import { webReplyLine } from '../../../apps/server/generation/web-reply-telemetry.ts';
import { WEB_LIMITS } from '../../../config/web-v1.ts';
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

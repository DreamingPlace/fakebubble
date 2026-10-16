import assert from 'node:assert/strict';
import test from 'node:test';
import { DomainError } from '../../../packages/domain/errors.ts';
import { readWebV7Request } from '../../../apps/server/generation/web-v7-request.ts';
import type { WebStore } from '../../../apps/server/platform/store.ts';
import { acceptedAuditEnvelope, draftEnvelope } from '../../text-fixtures.ts';
import { modelFixture, type FetchCall } from '../fixtures/model-choice.ts';

/**
 * Part 21d: a reply published as a voice->text fallback (origin='text_fallback') is an ordinary part of the conversation.
 * The next request must carry its text (transcript, short-term turns) and the next reply must succeed: the memory episode
 * of the fallback reply cites the fallback bubbles as evidence, so they have to count as trusted sources.
 */
const DRAFT = 'submit_dialogue_draft';
type Request = NonNullable<Parameters<typeof draftEnvelope>[0]>;

function fixture(t: Parameters<typeof modelFixture>[0]) {
  const answer = (call: FetchCall, request: Request) => {
    if (call.tool === DRAFT) return Response.json(draftEnvelope(request));
    const envelope = acceptedAuditEnvelope(request);
    const fn = envelope.choices[0]!.message.tool_calls[0]!.function;
    fn.arguments = JSON.stringify({
      ...JSON.parse(fn.arguments),
      topics: [
        {
          key: '养猫',
          memoryId: null,
          summary: '玩家养了一只猫。',
          importance: 5,
          sourceKind: 'player_statement',
          evidenceMessageIds: request.requiredMessageIds,
        },
      ],
    });
    return Response.json(envelope);
  };
  const f = modelFixture(t, {
    chosen: 'deepseek',
    fish: async () => {
      throw new DomainError('FISH_RATE_LIMITED');
    },
    fetch: (call, _n, first) => {
      const second = (call.body.messages as { content: string }[]).some((m) => m.content.includes('input-second'));
      const request: Request = second ? readWebV7Request(f.store as WebStore, 'second').request : first;
      return answer(call, request);
    },
  });
  return f;
}

/** Voice fails every time (first call plus three backed-off retries), then the reviewed text is published as text. */
async function replyAsTextFallback(f: ReturnType<typeof fixture>, operationId: string) {
  for (const backoff of [2000, 4000, 8000, 0]) {
    const claim = f.queue.claimAudio(f.lease, 'audio-worker');
    assert.ok(claim, `voice claimable after ${backoff}ms`);
    await f.runner.runSpeech(claim, f.signal());
    f.advance(backoff);
  }
  return f.runner.publishTextFallback(f.lease, operationId);
}

test('after a voice->text fallback reply, the next request carries the fallback text and the next reply succeeds', async (t) => {
  const f = fixture(t);
  await f.runText();
  const receipt = await replyAsTextFallback(f, 'operation');
  assert.ok(receipt.messageIds.length > 0);
  assert.deepEqual(
    f
      .all<{ origin: string }>("SELECT origin FROM web_publication_items WHERE operation_id='operation'")
      .map((r) => r.origin),
    receipt.messageIds.map(() => 'text_fallback'),
  );
  const replyTexts = f.all<{ body: string }>(
    `SELECT m.body FROM web_publication_items i JOIN messages m ON m.id=i.message_id
    WHERE i.operation_id='operation' ORDER BY i.ordinal`,
  );
  assert.ok(replyTexts.length > 0 && replyTexts.every((row) => row.body.length > 0));
  // The memory episode of the fallback reply cites the fallback bubbles.
  const cited = f.all<{ evidence_ids_json: string }>('SELECT evidence_ids_json FROM memory_episodes');
  assert.ok(cited.length > 0);

  f.addOperation('second', 'input-second 还记得我说的话吗？', 'deepseek');
  f.advance(1000);
  const claim = f.queue.claimText(f.lease, 'text-worker')!;
  assert.equal(claim.operationId, 'second');
  // (b) freezing the next request does not throw WEB_V7_MEMORY_SOURCE_UNTRUSTED.
  const frozen = readWebV7Request(f.store as WebStore, 'second').request;
  // (a) the fallback reply is in the transcript, in order, and counts as a recent turn.
  const transcript = frozen.messages.map((message) => message.text);
  for (const row of replyTexts)
    assert.ok(transcript.includes(row.body), `transcript has the fallback bubble: ${row.body}`);
  assert.ok(transcript.indexOf(replyTexts[0]!.body) < transcript.indexOf('input-second 还记得我说的话吗？'));
  assert.equal(frozen.shortTermTurns?.length, 1, 'the fallback reply is a recent turn');
  // The reply itself succeeds.
  await f.runner.runText(claim, f.signal());
  assert.equal(f.get<{ status: string }>("SELECT status FROM web_operations WHERE id='second'")!.status, 'text_ready');
});

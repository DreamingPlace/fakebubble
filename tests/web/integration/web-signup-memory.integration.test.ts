import assert from 'node:assert/strict';
import test from 'node:test';
import { readWebV7Request } from '../../../apps/server/generation/web-v7-request.ts';
import type { WebStore } from '../../../apps/server/platform/store.ts';
import { acceptedAuditEnvelope, draftEnvelope } from '../../text-fixtures.ts';
import { modelFixture } from '../fixtures/model-choice.ts';

/**
 * Part 21d: long-term memory is recalled for a guest who signed up (holds the signup bonus) exactly like for an account or
 * invite principal; a plain trial guest keeps short-term context only. Memory is WRITTEN for every principal.
 */
type Request = NonNullable<Parameters<typeof draftEnvelope>[0]>;

function fixture(t: Parameters<typeof modelFixture>[0]) {
  const f = modelFixture(t, {
    chosen: 'deepseek',
    fetch: (call, _n, first) => {
      const ids = [
        ...(call.body.messages as { content: string }[])
          .map((m) => m.content)
          .join('\n')
          .matchAll(/input-(o\d+|last)/g),
      ];
      const id = ids.length ? ids[ids.length - 1]![1]! : 'operation';
      const request: Request = id === 'operation' ? first : readWebV7Request(f.store as WebStore, id).request;
      if (call.tool === 'submit_dialogue_draft') return Response.json(draftEnvelope(request));
      const envelope = acceptedAuditEnvelope(request);
      const fn = envelope.choices[0]!.message.tool_calls[0]!.function;
      fn.arguments = JSON.stringify({
        ...JSON.parse(fn.arguments),
        topics:
          id === 'operation'
            ? [
                {
                  key: '养猫',
                  memoryId: null,
                  summary: '玩家养了一只猫。',
                  importance: 5,
                  sourceKind: 'player_statement',
                  evidenceMessageIds: request.requiredMessageIds,
                },
              ]
            : [],
      });
      return Response.json(envelope);
    },
  });
  return f;
}

/** The player states the fact, then talks for nine more turns (beyond the eight short-term turns), then asks. */
async function converse(f: ReturnType<typeof fixture>) {
  await f.runText();
  await f.finishReply('operation');
  for (const id of ['o1', 'o2', 'o3', 'o4', 'o5', 'o6', 'o7', 'o8', 'o9']) {
    f.addOperation(id, `input-${id} 聊聊别的 ${id}`, 'deepseek');
    f.advance(1000);
    await f.runner.runText(f.queue.claimText(f.lease, 'text-worker')!, f.signal());
    await f.finishReply(id);
  }
  f.addOperation('last', 'input-last 还记得我养猫吗？', 'deepseek');
  f.advance(1000);
  assert.equal(f.queue.claimText(f.lease, 'text-worker')!.operationId, 'last');
  return readWebV7Request(f.store as WebStore, 'last').request;
}

test('a signed-up player (guest with the signup bonus): the fact is recalled beyond the short-term window', async (t) => {
  const f = fixture(t);
  const request = await converse(f);
  assert.equal(request.shortTermTurns?.length, 8, 'the statement is older than the eight short-term turns');
  assert.ok(
    request.memories?.some((memory) => memory.key === '养猫'),
    'long-term memory is recalled',
  );
});

test('a plain trial guest is unchanged: memory is written but never recalled', async (t) => {
  const f = fixture(t);
  f.store.run("DELETE FROM web_signup_bonus WHERE principal_id='principal'");
  const request = await converse(f);
  assert.equal(
    f.all("SELECT 1 FROM memory_topics WHERE topic_key='养猫'").length,
    1,
    'writing is the same for every principal',
  );
  assert.deepEqual(request.memories ?? [], []);
  assert.deepEqual(request.memoryCorrections ?? [], []);
  assert.deepEqual(request.playerFacts ?? [], []);
});

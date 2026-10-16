import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptedAuditEnvelope, draftEnvelope } from '../../text-fixtures.ts';
import { readWebV7Request } from '../../../apps/server/generation/web-v7-request.ts';
import { setPlayerModel } from '../../../apps/server/admission/web-points.ts';
import type { WebStore } from '../../../apps/server/platform/store.ts';
import { modelFixture, wire, type FetchCall } from '../fixtures/model-choice.ts';

/**
 * The player's model only DRAFTS. Review (safety and the memory topics) is always the house reviewer, so switching models in
 * the middle of a conversation writes and links memory exactly as if nothing had changed.
 */
const DRAFT = 'submit_dialogue_draft';
type Request = NonNullable<Parameters<typeof draftEnvelope>[0]>;

function review(request: Request, topics: unknown[]) {
  const envelope = acceptedAuditEnvelope(request);
  const call = envelope.choices[0]!.message.tool_calls[0]!.function;
  call.arguments = JSON.stringify({ ...JSON.parse(call.arguments), topics });
  return envelope;
}

test('switching models mid-conversation keeps the memory topics linked; the reviewer is the same model before and after', async (t) => {
  const reviewers: string[] = [];
  const f = modelFixture(t, {
    chosen: 'xai',
    fetch: (call: FetchCall, _n: number, first: Request) => {
      // Both operations are answered from the request frozen for that operation.
      const id = (call.body.messages as { content: string }[]).some((m) => m.content.includes('input-second'))
        ? 'second'
        : 'operation';
      const request: Request = id === 'second' ? readWebV7Request(f.store as WebStore, 'second').request : first;
      if (call.tool === DRAFT) {
        const args = JSON.parse(draftEnvelope(request).choices[0]!.message.tool_calls[0]!.function.arguments);
        return Response.json(call.provider === 'xai' ? wire.xai(call.tool, args) : wire.gemini(call.tool, args));
      }
      reviewers.push(`${call.provider}:${call.body.model}`);
      const recalled = request.memories ?? [];
      const topics = [
        {
          key: '养猫',
          memoryId: id === 'second' ? (recalled[0]?.id ?? null) : null,
          summary: '玩家养了一只猫。',
          importance: 5,
          sourceKind: 'player_statement',
          evidenceMessageIds: request.requiredMessageIds,
        },
      ];
      return Response.json(review(request, topics));
    },
  });

  // First message: Grok drafts, the house reviewer reviews, the voice reply is published and memory is written.
  await f.runText();
  assert.equal(f.models()!.draft_provider, 'xai');
  await f.finishReply('operation');
  assert.equal(f.status(), 'published');
  const topics = () => f.all<{ topic_key: string }>('SELECT topic_key FROM memory_topics ORDER BY topic_key');
  const episodes = () => f.all<{ job_id: string }>('SELECT job_id FROM memory_episodes ORDER BY job_id');
  assert.deepEqual(
    topics().map((row) => row.topic_key),
    ['养猫'],
  );
  assert.equal(episodes().length, 1);

  // (Later) guests are never given recalled memory (freezeWebV7Request), so the player here is an account principal: the only kind
  // for which a topic can be linked at all. The linking is done by the reviewer, never by the drafting model.
  f.store.run(
    "INSERT INTO web_accounts(id,principal_id,username_norm,password_salt,password_tag,created_at) VALUES ('acc','principal','acc-user',x'00',x'00',?)",
    1,
  );
  f.store.run("UPDATE web_principals SET kind='account',revision=revision+1 WHERE id='principal'");
  f.store.run(
    "UPDATE web_guest_retention SET state='protected',started_at=NULL,expires_at=NULL,revision=revision+1 WHERE principal_id='principal'",
  );

  // The player switches to Gemini; only the NEXT message is affected.
  setPlayerModel(f.store as never, f.clock.now(), 'principal', 'gemini');
  f.addOperation('second', 'input-second 还记得我养猫吗？我的猫今天很乖', 'gemini');
  assert.equal(
    f.get<{ chosen: string }>("SELECT chosen FROM web_operation_models WHERE operation_id='operation'")!.chosen,
    'xai',
  );
  f.advance(1000);
  const claim = f.queue.claimText(f.lease, 'text-worker')!;
  assert.equal(claim.operationId, 'second');
  const frozen = readWebV7Request(f.store as WebStore, 'second').request;
  assert.equal(frozen.memories?.length, 1, 'the memory written under Grok is recalled for the Gemini reply');
  assert.doesNotMatch(JSON.stringify(frozen), /grok|gemini|xai|deepseek/i, 'the frozen request never names a model');
  await f.runner.runText(claim, f.signal());
  assert.equal(
    f.get<{ draft_provider: string }>("SELECT draft_provider FROM web_operation_models WHERE operation_id='second'")!
      .draft_provider,
    'gemini',
  );
  await f.finishReply('second');

  // One topic, two episodes: the link survived the switch.
  assert.deepEqual(
    topics().map((row) => row.topic_key),
    ['养猫'],
  );
  assert.equal(episodes().length, 2);
  assert.deepEqual(
    [...new Set(reviewers)],
    ['deepseek:deepseek-v4-pro'],
    'the same house reviewer before and after the switch',
  );
  assert.equal(reviewers.length, 2);
});

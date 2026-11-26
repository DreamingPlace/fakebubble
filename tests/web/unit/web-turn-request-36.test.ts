import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { promptMessages } from '../../../apps/server/generation/accepted-text-prompt.ts';
import { freezeInputSnapshot } from '../../../apps/server/generation/web-input-snapshot.ts';
import { freezeWebV7Request, readWebV7Request } from '../../../apps/server/generation/web-v7-request.ts';
import { installWriterSetting, writeWriter } from '../../../apps/server/generation/web-writer-setting.ts';
import { WRITER_BATCH_NOTE, writerDraftMessages } from '../../../apps/server/generation/writer-v8.ts';
import type { WebStore } from '../../../apps/server/platform/store.ts';
import { installWebTurns } from '../../../apps/server/turns/web-turn-schema.ts';
import { FREEZE_NOW, schema128, seedFreezeScenario } from '../fixtures/cast-freeze.ts';

/**
 * Part 36: the writer's request for a turn carries ALL of the batch's bubbles in order, with each quote (who wrote the quoted
 * message and what it said, read from the same conversation only). A single message without a quote is byte-identical to before.
 */
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

function batchScenario(options: { writer?: 'v8'; quoteOtherConversation?: boolean } = {}) {
  const store = schema128();
  seedFreezeScenario(store, 'character');
  installWriterSetting(store);
  if (options.writer) writeWriter(store, FREEZE_NOW, 'owner', options.writer);
  installWebTurns(store);
  const message = (id: string, kind: 'player' | 'character', body: string, at: number, conversation = 'conversation') =>
    store.run(
      `INSERT INTO messages(id,world_id,conversation_id,author_kind,author_id,body,created_at,delivery,proactive)
      VALUES (?,'world',?,?,?,?,?,'text',0)`,
      id,
      conversation,
      kind,
      kind === 'player' ? 'player' : 'character',
      body,
      at,
    );
  message('her-old', 'character', '先把鞋脱了，坐下来，慢慢说。', FREEZE_NOW - 50_000);
  message('b1', 'player', '在吗', FREEZE_NOW - 3_000);
  message('b2', 'player', '好～', FREEZE_NOW - 2_000);
  message('b3', 'player', '对了，刚才那个', FREEZE_NOW - 1_000);
  const bubble = (id: string, quote: string | null) =>
    store.run(
      `INSERT INTO web_turn_bubbles(message_id,principal_id,world_id,conversation_id,character_id,request_id,request_hash,quote_message_id,
        ip_hash,created_at,state,operation_id) VALUES (?,'principal','world','conversation','character',?,'h',?,?,?,'turn','operation')`,
      id,
      `req-${id}`,
      quote,
      'a'.repeat(64),
      FREEZE_NOW - 1_000,
    );
  bubble('b1', null);
  bubble('b2', 'her-old');
  bubble('b3', 'b1');
  // the turn's input message is its last bubble
  store.run("UPDATE web_operations SET input_message_id='b3' WHERE id='operation'");
  return store;
}

const freeze = (store: ReturnType<typeof batchScenario>) => {
  freezeInputSnapshot(store as unknown as WebStore, 'operation', FREEZE_NOW);
  freezeWebV7Request(store as unknown as WebStore, 'operation', FREEZE_NOW);
  return readWebV7Request(store as unknown as WebStore, 'operation').request;
};

test('旧 (v7): the request names every bubble of the batch in order, with its quotes; the prompt carries both', (t) => {
  const store = batchScenario();
  t.after(() => store.close());
  const request = freeze(store);
  assert.deepEqual(request.requiredMessageIds, ['b1', 'b2', 'b3']);
  assert.deepEqual(
    request.messages.map((m) => m.id),
    ['b1', 'b2', 'b3'],
    'in the order they were sent',
  );
  assert.equal(request.messages[0]!.replyTo, undefined);
  assert.deepEqual(request.messages[1]!.replyTo, {
    id: 'her-old',
    authorKind: 'character',
    authorId: 'character',
    text: '先把鞋脱了，坐下来，慢慢说。',
    delivery: 'text',
  });
  assert.equal(request.messages[2]!.replyTo!.id, 'b1', 'a bubble can quote one of its own batch');
  const prompt = promptMessages(request)
    .map((m) => m.content)
    .join('\n');
  assert.ok(prompt.includes('requiredMessageIds') && prompt.includes('"replyTo"'), 'the form v7 already understands');
});

test('新 (v8): the batch words are in the writer prompt for a batch or a quote, and only then', (t) => {
  const store = batchScenario({ writer: 'v8' });
  t.after(() => store.close());
  const request = freeze(store);
  assert.equal(request.writer, 'v8');
  const [system] = writerDraftMessages(request);
  assert.ok(system!.content.endsWith(WRITER_BATCH_NOTE), 'appended last, after every stable block');
  // one bubble, no quote: exactly the prompt it always was
  const single = {
    ...request,
    requiredMessageIds: ['b3'],
    messages: request.messages.slice(2).map(({ replyTo: _r, ...m }) => m),
  };
  assert.ok(!writerDraftMessages(single as typeof request)[0]!.content.includes(WRITER_BATCH_NOTE));
  // one bubble WITH a quote gets it
  const quoted = { ...request, requiredMessageIds: ['b3'], messages: request.messages.slice(2) };
  assert.ok(writerDraftMessages(quoted as typeof request)[0]!.content.includes(WRITER_BATCH_NOTE));
});

test('the batch words are pinned: a change is a deliberate change of this hash (docs/status/part-36.md)', () => {
  assert.equal(sha(WRITER_BATCH_NOTE), '72df760e9d483e9faf382259778d5d2f48114a3307701703d93fe9a0d49203fd');
});

test('a bubble of ANOTHER conversation is never a quote in the request', (t) => {
  const store = batchScenario();
  t.after(() => store.close());
  // a second conversation of the same world holds a message; a bubble row (bypassing the service) points at it
  store.run("INSERT INTO character_templates VALUES ('character2',1,'{}')");
  store.run("INSERT INTO world_characters VALUES ('world','character2','friend')");
  store.run(
    "INSERT INTO conversations(world_id,id,kind,private_character_id) VALUES ('world','other','private','character2')",
  );
  store.run(
    "INSERT INTO messages(id,world_id,conversation_id,author_kind,author_id,body,created_at,delivery,proactive) VALUES ('elsewhere','world','other','player','player','别处的话',?,'text',0)",
    FREEZE_NOW - 9_000,
  );
  store.run('DROP TRIGGER web_turn_bubbles_fixed');
  store.run("UPDATE web_turn_bubbles SET quote_message_id='elsewhere' WHERE message_id='b2'");
  const request = freeze(store);
  assert.equal(request.messages[1]!.replyTo, undefined, 'read only inside the conversation of the turn');
});

test('a single message turn has no replyTo and the one id: the request is what it was before Part 36', (t) => {
  const store = schema128();
  t.after(() => store.close());
  seedFreezeScenario(store, 'character');
  const request = freeze(store as ReturnType<typeof batchScenario>);
  assert.deepEqual(request.requiredMessageIds, ['input']);
  assert.ok(!request.messages.some((m) => 'replyTo' in m));
});

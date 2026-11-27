import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WebAdmission } from '../../../apps/server/admission/web-admission.ts';
import { WebStore } from '../../../apps/server/platform/store.ts';
import { WebTurns, turnMemberIds, turnQuotes } from '../../../apps/server/turns/web-turns.ts';
import {
  TURN_MAX_BUBBLES,
  TURN_MAX_PENDING,
  TURN_QUIET_MS,
  installWebTurns,
  purgeTurnsCharacter,
  purgeTurnsConversation,
  purgeTurnsWorld,
  turnsResidue,
} from '../../../apps/server/turns/web-turn-schema.ts';

/**
 * Part 36: 连发. Several bubbles in a row are answered by ONE turn: stored the moment they are sent, closed by the business
 * object after 4 s of quiet (or at the fifth bubble), admitted (and charged) once, quotes scoped to the conversation.
 */
const ip = (digit: string) => digit.repeat(64);
const characterA = 'fixture-character';
const characterB = 'fixture-other';

function fixture(t: import('node:test').TestContext) {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'web-turns-36-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const store = new WebStore(join(parent, 'instance'), { create: true, instanceId: randomUUID() });
  t.after(() => store.close());
  let now = 1_700_000_000_000,
    sequence = 0;
  const nextId = () => `synthetic-${++sequence}`;
  const clock = { now: () => now };
  const admission = new WebAdmission(store, clock, nextId);
  const turns = new WebTurns(store, clock, admission, nextId);
  for (const id of [characterA, characterB])
    store.run('INSERT INTO character_templates(id,version,config_json) VALUES (?,?,?)', id, 1, '{}');
  function guest(name: string) {
    const playerId = `player-${name}`,
      worldId = `world-${name}`,
      principalId = `principal-${name}`;
    store.transaction(() => {
      store.run('INSERT INTO api_players VALUES (?,?)', playerId, now);
      store.run('INSERT INTO worlds VALUES (?,?,?,?)', worldId, playerId, 'Asia/Singapore', '{}');
      for (const id of [characterA, characterB])
        store.run("INSERT INTO world_characters VALUES (?,?,'new')", worldId, id);
    });
    admission.registerGuest({ principalId, playerId, worldId });
    return { principalId, world_id: worldId, player_id: playerId };
  }
  const bubble = (
    actor: ReturnType<typeof guest>,
    text: string,
    extra: { quote?: string; character?: string; id?: string } = {},
  ) =>
    turns.addBubble(actor, {
      requestId: extra.id ?? `r-${++sequence}`,
      characterId: extra.character ?? characterA,
      text,
      quoteMessageId: extra.quote ?? null,
      ipHash: ip('a'),
    });
  const operations = () =>
    store.all<{ id: string; input_message_id: string; status: string }>(
      'SELECT id,input_message_id,status FROM web_operations',
    );
  return { store, admission, turns, clock, guest, bubble, operations, advance: (ms: number) => void (now += ms) };
}

test('three bubbles are answered by ONE turn after 4 s of quiet; one reservation; the turn ends on the last bubble', (t) => {
  const f = fixture(t);
  const actor = f.guest('a');
  const ids = [
    f.bubble(actor, '在吗').messageId,
    f.bubble(actor, '我刚下班').messageId,
    f.bubble(actor, '今天好累').messageId,
  ];
  // every bubble is stored the moment it is sent: nothing is an operation yet, nothing is charged
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM messages')!.n, 3);
  assert.equal(f.operations().length, 0);
  assert.equal(f.store.get<{ trial_reserved: number }>('SELECT trial_reserved FROM web_principals')!.trial_reserved, 0);
  assert.equal(f.turns.view(actor, characterA).state, 'collecting');
  f.advance(TURN_QUIET_MS - 1);
  assert.equal(f.turns.pass(), 0, 'not yet: 4 s of quiet has not passed');
  f.advance(1);
  assert.equal(f.turns.pass(), 1);
  const [operation] = f.operations();
  assert.equal(f.operations().length, 1, 'one turn for three bubbles');
  assert.equal(operation!.input_message_id, ids[2], "the last bubble is the turn's input message");
  assert.deepEqual(turnMemberIds(f.store, operation!.id, operation!.input_message_id), ids, 'all three, in order');
  assert.equal(
    f.store.get<{ trial_reserved: number }>('SELECT trial_reserved FROM web_principals')!.trial_reserved,
    1,
    'one charge per reply, not per bubble',
  );
  assert.equal(f.turns.view(actor, characterA).state, 'replying');
  assert.equal(f.turns.pass(), 0, 'a second pass closes nothing and admits nothing twice');
  assert.equal(f.operations().length, 1);
});

test('every new bubble restarts the 4 s of quiet', (t) => {
  const f = fixture(t);
  const actor = f.guest('a');
  f.bubble(actor, '一');
  f.advance(3_000);
  f.bubble(actor, '二');
  f.advance(3_000);
  assert.equal(f.turns.pass(), 0, '3 s after the second bubble');
  assert.equal(f.turns.nextDue(), f.clock.now() + 1_000);
  f.advance(1_000);
  assert.equal(f.turns.pass(), 1);
});

test('five waiting bubbles close the batch at once, inside the request that stored the fifth', (t) => {
  const f = fixture(t);
  const actor = f.guest('a');
  for (let i = 0; i < TURN_MAX_BUBBLES - 1; i++) f.bubble(actor, `第${i}条`);
  assert.equal(f.operations().length, 0);
  const fifth = f.bubble(actor, '第五条');
  assert.equal(f.operations().length, 1, 'no waiting for the quiet period');
  assert.equal(fifth.turn.state, 'replying');
  assert.equal(turnMemberIds(f.store, f.operations()[0]!.id, fifth.messageId).length, 5);
});

test('bubbles sent while she replies wait for the NEXT turn; at most five go into one turn', (t) => {
  const f = fixture(t);
  const actor = f.guest('a');
  for (let i = 0; i < TURN_MAX_BUBBLES; i++) f.bubble(actor, `前${i}`);
  const first = f.operations()[0]!;
  // her reply is running: seven more bubbles pile up and nothing new is admitted, however long the player is quiet
  for (let i = 0; i < 7; i++) f.bubble(actor, `后${i}`);
  f.advance(60_000);
  assert.equal(f.turns.pass(), 0);
  assert.equal(f.operations().length, 1);
  assert.equal(f.turns.view(actor, characterA).pending, 7);
  // the reply ends: the next turn takes the first five of the waiting bubbles, the last two wait for the one after it
  f.store.run("UPDATE web_operations SET status='published' WHERE id=?", first.id);
  assert.equal(f.turns.pass(), 1);
  assert.equal(f.operations().length, 2);
  const second = f.operations()[1]!;
  assert.equal(turnMemberIds(f.store, second.id, second.input_message_id).length, 5);
  assert.equal(f.turns.view(actor, characterA).pending, 2);
});

test('an UNKNOWN reply frees the slot for the next turn (its money stays held, nothing is resent)', (t) => {
  const f = fixture(t);
  const actor = f.guest('a');
  for (let i = 0; i < TURN_MAX_BUBBLES; i++) f.bubble(actor, `前${i}`);
  const first = f.operations()[0]!;
  f.store.run("UPDATE web_operations SET status='unknown' WHERE id=?", first.id);
  f.bubble(actor, '后');
  f.advance(TURN_QUIET_MS);
  assert.equal(f.turns.pass(), 1);
  assert.equal(f.operations().length, 2);
  assert.equal(f.operations()[0]!.status, 'unknown', 'the first operation is untouched');
});

test('a repeated request id is the same bubble; a different body under it is a conflict; nothing is stored twice', (t) => {
  const f = fixture(t);
  const actor = f.guest('a');
  const first = f.bubble(actor, '你好', { id: 'same' });
  const again = f.bubble(actor, '你好', { id: 'same' });
  assert.equal(again.duplicate, true);
  assert.equal(again.messageId, first.messageId);
  assert.throws(() => f.bubble(actor, '不一样', { id: 'same' }), /IDEMPOTENCY_CONFLICT/);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM messages')!.n, 1);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_turn_bubbles')!.n, 1);
});

test('a quote must name a message of THIS conversation of this player; the quote reaches the request', (t) => {
  const f = fixture(t);
  const a = f.guest('a');
  const b = f.guest('b');
  const mine = f.bubble(a, '我的第一句');
  const otherConversation = f.bubble(a, '另一个角色里的', { character: characterB });
  const theirs = f.bubble(b, '别人的一句');
  assert.throws(
    () => f.bubble(a, '引用', { quote: otherConversation.messageId }),
    /QUOTE_UNAVAILABLE/,
    'another conversation',
  );
  assert.throws(
    () => f.bubble(a, '引用', { quote: theirs.messageId }),
    /QUOTE_UNAVAILABLE/,
    "another player's message",
  );
  assert.throws(() => f.bubble(a, '引用', { quote: 'does-not-exist' }), /QUOTE_UNAVAILABLE/);
  assert.equal(
    f.store.get<{ n: number }>("SELECT count(*) n FROM web_turn_bubbles WHERE principal_id='principal-a'")!.n,
    2,
    'a refused quote stores nothing',
  );
  const quoting = f.bubble(a, '接着说', { quote: mine.messageId });
  const quotes = turnQuotes(f.store, a.world_id, quoting.conversationId, [quoting.messageId, mine.messageId]);
  assert.deepEqual(quotes.get(quoting.messageId), {
    id: mine.messageId,
    authorKind: 'player',
    authorId: a.player_id,
    text: '我的第一句',
    delivery: 'text',
  });
  assert.equal(quotes.has(mine.messageId), false, 'a bubble without a quote has none');
  // the original is gone: the quote is left out of the request
  f.store.run('DELETE FROM web_turn_bubbles WHERE message_id=?', mine.messageId);
  f.store.run('DELETE FROM outbox WHERE message_id=?', mine.messageId);
  f.store.run('DELETE FROM messages WHERE id=?', mine.messageId);
  assert.equal(turnQuotes(f.store, a.world_id, quoting.conversationId, [quoting.messageId]).size, 0);
});

test('at most TURN_MAX_PENDING bubbles wait; a refused bubble stores nothing', (t) => {
  const f = fixture(t);
  const actor = f.guest('a');
  for (let i = 0; i < TURN_MAX_BUBBLES; i++) f.bubble(actor, `前${i}`);
  for (let i = 0; i < TURN_MAX_PENDING; i++) f.bubble(actor, `后${i}`);
  const before = f.store.get<{ n: number }>('SELECT count(*) n FROM messages')!.n;
  assert.throws(() => f.bubble(actor, '多一条'), /WEB_TURN_BUBBLES_FULL/);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM messages')!.n, before);
});

test('a batch whose turn cannot be admitted is refused once, with the code and no retry; the trial is not charged', (t) => {
  const f = fixture(t);
  const actor = f.guest('a');
  f.bubble(actor, '一');
  // the trial runs out between the bubble and the close
  f.store.run('UPDATE web_principals SET trial_used=3 WHERE id=?', actor.principalId);
  f.advance(TURN_QUIET_MS);
  assert.equal(f.turns.pass(), 0);
  assert.equal(f.operations().length, 0);
  assert.equal(f.turns.view(actor, characterA).state, 'refused');
  assert.equal(f.turns.view(actor, characterA).errorCode, 'TRIAL_EXHAUSTED');
  assert.equal(f.turns.pass(), 0, 'not retried');
  assert.equal(f.turns.nextDue(), null);
});

test('the bubble rows are fixed: a pending row changes state once and nothing else changes', (t) => {
  const f = fixture(t);
  const actor = f.guest('a');
  const sent = f.bubble(actor, '一');
  assert.throws(
    () => f.store.run("UPDATE web_turn_bubbles SET quote_message_id='x' WHERE message_id=?", sent.messageId),
    /WEB_TURN_IMMUTABLE/,
  );
  assert.throws(
    () => f.store.run('UPDATE web_turn_bubbles SET ip_hash=? WHERE message_id=?', ip('b'), sent.messageId),
    /WEB_TURN_IMMUTABLE/,
  );
  f.advance(TURN_QUIET_MS);
  f.turns.pass();
  assert.throws(
    () =>
      f.store.run("UPDATE web_turn_bubbles SET state='pending',operation_id=NULL WHERE message_id=?", sent.messageId),
    /WEB_TURN_IMMUTABLE|CHECK/,
  );
});

test('the schema step is digest-checked: a changed table stops the start with WEB_TURN_SCHEMA_MISMATCH', (t) => {
  const f = fixture(t);
  installWebTurns(f.store); // idempotent
  f.store.run("UPDATE web_turn_schema SET sha256='0000000000000000000000000000000000000000000000000000000000000000'");
  assert.throws(() => installWebTurns(f.store), /WEB_TURN_SCHEMA_MISMATCH/);
});

test('the purges leave nothing: world, conversation and character', (t) => {
  for (const purge of ['world', 'conversation', 'character'] as const) {
    const f = fixture(t);
    const actor = f.guest('a');
    const sent = f.bubble(actor, '一');
    assert.equal(turnsResidue(f.store, actor.world_id), 1);
    if (purge === 'world') purgeTurnsWorld(f.store, actor.world_id);
    else if (purge === 'conversation') purgeTurnsConversation(f.store, actor.world_id, sent.conversationId);
    else purgeTurnsCharacter(f.store, characterA);
    assert.equal(turnsResidue(f.store, actor.world_id), 0, purge);
  }
});

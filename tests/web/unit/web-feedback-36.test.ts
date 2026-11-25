import assert from 'node:assert/strict';
import test from 'node:test';
import { WebFeedback } from '../../../apps/server/turns/web-feedback.ts';
import {
  feedbackResidue,
  installWebFeedback,
  purgeFeedbackCharacter,
  purgeFeedbackConversation,
  purgeFeedbackWorld,
} from '../../../apps/server/turns/web-feedback-schema.ts';
import type { WebRuntimeStore } from '../../../apps/server/platform/web-store-contract.ts';
import { FREEZE_NOW, schema128, seedFreezeScenario } from '../fixtures/cast-freeze.ts';

/**
 * Part 36: 👍 / 👎. One rating per player per message, idempotent as a desired state (up / down+target / none); only a reply of the
 * character in the player's own conversation can be rated; a 👎 says what it rates (voice only when there is a voice).
 */
function scenario() {
  const store = schema128();
  seedFreezeScenario(store, 'character');
  store.run('PRAGMA foreign_keys=OFF');
  const message = (id: string, kind: 'player' | 'character', body: string, conversation = 'conversation') =>
    store.run(
      `INSERT INTO messages(id,world_id,conversation_id,author_kind,author_id,body,created_at,delivery,proactive)
      VALUES (?,'world',?,?,?,?,?,'text',0)`,
      id,
      conversation,
      kind,
      kind,
      body,
      FREEZE_NOW,
    );
  const publish = (operation: string, items: [message: string, origin: string, media: string | null][]) => {
    store.run(
      `INSERT INTO web_publications(operation_id,principal_id,player_id,world_id,conversation_id,character_id,input_message_id,job_id,
        request_digest,candidate_digest,published_at,receipt_json) VALUES (?,'principal','player','world','conversation','character','input',?,'d','d',?,'{}')`,
      operation,
      `job-${operation}`,
      FREEZE_NOW,
    );
    items.forEach(([id, origin, media], ordinal) =>
      store.run('INSERT INTO web_publication_items(operation_id,ordinal,message_id,media_id,origin) VALUES (?,?,?,?,?)', operation, ordinal, id, media, origin),
    );
  };
  message('voice', 'character', '先把鞋脱了');
  message('fallback', 'character', '坐下来，慢慢说');
  message('footer', 'character', '有空一定要来找我呀～');
  message('mine', 'player', '我的话');
  publish('operation', [
    ['voice', 'narrative', 'media-1'],
    ['fallback', 'text_fallback', null],
    ['footer', 'trial_footer', 'media-2'],
  ]);
  const feedback = new WebFeedback(store as unknown as WebRuntimeStore, { now: () => FREEZE_NOW });
  const actor = { principalId: 'principal', world_id: 'world', player_id: 'player' };
  let n = 0;
  const rate = (input: { messageId: string; rating: 'up' | 'down' | 'none'; target?: 'voice' | 'content'; id?: string; conversationId?: string }, who = actor) =>
    feedback.rate(who, { requestId: input.id ?? `r${++n}`, conversationId: input.conversationId ?? 'conversation', messageId: input.messageId, rating: input.rating, ...(input.target ? { target: input.target } : {}) });
  return { store, feedback, actor, rate };
}

test('rate, switch and remove are idempotent; one rating per message', (t) => {
  const { store, rate, feedback, actor } = scenario();
  t.after(() => store.close());
  assert.deepEqual(rate({ messageId: 'voice', rating: 'up' }), { rating: 'up', target: null });
  assert.deepEqual(rate({ messageId: 'voice', rating: 'up' }), { rating: 'up', target: null }, 'the same desired state again changes nothing');
  assert.equal(store.get<{ n: number }>('SELECT count(*) n FROM web_feedback')!.n, 1);
  assert.deepEqual(rate({ messageId: 'voice', rating: 'down', target: 'voice' }), { rating: 'down', target: 'voice' }, 'the other button switches it');
  assert.equal(store.get<{ n: number }>('SELECT count(*) n FROM web_feedback')!.n, 1, 'still one row');
  assert.deepEqual(rate({ messageId: 'voice', rating: 'down', target: 'content' }), { rating: 'down', target: 'content' }, 'what is rated down can change');
  assert.deepEqual([...feedback.ratingsOf(actor, ['voice', 'fallback']).entries()], [['voice', { value: 'down', target: 'content' }]]);
  assert.deepEqual(rate({ messageId: 'voice', rating: 'none' }), { rating: null, target: null }, 'tapping again removes it');
  assert.deepEqual(rate({ messageId: 'voice', rating: 'none' }), { rating: null, target: null }, 'removing twice is fine');
  assert.equal(store.get<{ n: number }>('SELECT count(*) n FROM web_feedback')!.n, 0);
});

test('a repeated request id answers the same; a different body under it is a conflict', (t) => {
  const { store, rate } = scenario();
  t.after(() => store.close());
  rate({ id: 'same', messageId: 'voice', rating: 'up' });
  assert.deepEqual(rate({ id: 'same', messageId: 'voice', rating: 'up' }), { rating: 'up', target: null });
  assert.throws(() => rate({ id: 'same', messageId: 'voice', rating: 'down', target: 'content' }), /IDEMPOTENCY_CONFLICT/);
  assert.equal(store.get<{ n: number }>('SELECT count(*) n FROM web_feedback_requests')!.n, 1);
});

test('a 👎 on a text-fallback reply is content only; a voice reply may be rated on either', (t) => {
  const { store, rate } = scenario();
  t.after(() => store.close());
  assert.throws(() => rate({ messageId: 'fallback', rating: 'down', target: 'voice' }), /FEEDBACK_TARGET_INVALID/);
  assert.deepEqual(rate({ messageId: 'fallback', rating: 'down', target: 'content' }), { rating: 'down', target: 'content' });
  assert.deepEqual(rate({ messageId: 'fallback', rating: 'up' }), { rating: 'up', target: null });
  assert.throws(() => rate({ messageId: 'voice', rating: 'down' }), /INVALID_REQUEST/, 'a 👎 must say what it rates');
  assert.throws(() => rate({ messageId: 'voice', rating: 'up', target: 'voice' }), /INVALID_REQUEST/);
});

test('only the character\'s replies of the player\'s own conversation can be rated', (t) => {
  const { store, rate, actor } = scenario();
  t.after(() => store.close());
  for (const messageId of ['footer', 'mine', 'does-not-exist']) assert.throws(() => rate({ messageId, rating: 'up' }), /NOT_FOUND/, messageId);
  assert.throws(() => rate({ messageId: 'voice', rating: 'up', conversationId: 'other-conversation' }), /NOT_FOUND/, 'another conversation');
  // another player (another principal and world) rating this player's message id
  assert.throws(() => rate({ messageId: 'voice', rating: 'up' }, { principalId: 'someone-else', world_id: 'other-world', player_id: 'other-player' }), /NOT_FOUND|WEB_RETENTION_SCOPE_INVALID/, 'a principal this world does not know is refused before anything is read');
  assert.throws(() => rate({ messageId: 'voice', rating: 'up' }, { ...actor, principalId: 'someone-else' }), /NOT_FOUND|WEB_RETENTION_SCOPE_INVALID/, 'the publication belongs to another principal');
  assert.equal(store.get<{ n: number }>('SELECT count(*) n FROM web_feedback')!.n, 0);
});

test('a rating copies the writer and the model of the reply', (t) => {
  const { store, rate } = scenario();
  t.after(() => store.close());
  store.run(
    `INSERT INTO web_v7_requests VALUES ('operation','principal','player','world','conversation','character','input',?, 'd','p','p',1,'k',1,1,'v',?)`,
    JSON.stringify({ writer: 'v8', writerProfile: true }),
    FREEZE_NOW,
  );
  rate({ messageId: 'voice', rating: 'down', target: 'voice' });
  const row = store.get<{ writer: string; model: string; heard_at: number | null }>('SELECT writer,model,heard_at FROM web_feedback');
  assert.equal(row!.writer, 'v8p');
  assert.equal(row!.model, 'deepseek');
  assert.equal(row!.heard_at, null);
});

test('a switch clears the owner\'s 「已听」 mark; the same rating again does not', (t) => {
  const { store, rate } = scenario();
  t.after(() => store.close());
  rate({ messageId: 'voice', rating: 'down', target: 'voice' });
  store.run('UPDATE web_feedback SET heard_at=5');
  rate({ messageId: 'voice', rating: 'down', target: 'voice' });
  assert.equal(store.get<{ heard_at: number | null }>('SELECT heard_at FROM web_feedback')!.heard_at, 5);
  rate({ messageId: 'voice', rating: 'down', target: 'content' });
  assert.equal(store.get<{ heard_at: number | null }>('SELECT heard_at FROM web_feedback')!.heard_at, null);
});

test('the purges leave nothing: world, conversation and character; the schema is digest-checked', (t) => {
  for (const purge of ['world', 'conversation', 'character'] as const) {
    const { store, rate, actor } = scenario();
    rate({ messageId: 'voice', rating: 'up' });
    assert.equal(feedbackResidue(store as never, 'world') > 0, true);
    if (purge === 'world') purgeFeedbackWorld(store as never, 'world');
    else if (purge === 'conversation') purgeFeedbackConversation(store as never, 'world', 'conversation');
    else purgeFeedbackCharacter(store as never, 'character');
    assert.equal(store.get<{ n: number }>('SELECT count(*) n FROM web_feedback')!.n, 0, purge);
    void actor;
    store.close();
  }
  const { store } = scenario();
  t.after(() => store.close());
  installWebFeedback(store as never);
  store.run("UPDATE web_feedback_schema SET sha256='0000000000000000000000000000000000000000000000000000000000000000'");
  assert.throws(() => installWebFeedback(store as never), /WEB_FEEDBACK_SCHEMA_MISMATCH/);
});

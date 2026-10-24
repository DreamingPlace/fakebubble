import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { promptMessages, reviewPromptMessages } from '../../../apps/server/generation/accepted-text-prompt.ts';
import { freezeInputSnapshot } from '../../../apps/server/generation/web-input-snapshot.ts';
import { freezeWebV7Request, readWebV7Request } from '../../../apps/server/generation/web-v7-request.ts';
import type { WebStore } from '../../../apps/server/platform/store.ts';
import { textRequest } from '../../text-fixtures.ts';
import { captureFreeze, FREEZE_NOW, schema128, seedFreezeScenario } from '../fixtures/cast-freeze.ts';

/**
 * Part 26a: the character's welcome line is the first line of the chat. It comes from the published revision the request's
 * template was frozen from, only when nothing earlier in the conversation was cut off, and only in a normal chat.
 */
const OFF_MAIN = JSON.parse(
  readFileSync(new URL('../fixtures/cast-off-main.json', import.meta.url), 'utf8'),
) as ReturnType<typeof captureFreeze>;
const WELCOME_A = '我才放学回来，让你等久了',
  WELCOME_B = '改过之后的新欢迎语';
const DRAFT = { mode: 'casual', bubbles: [{ text: '好呀', expression: 'neutral' }], endsSession: false } as never;

/** The published profiles of a character: version -> welcome text (null = a profile without a welcome line). */
function publish(store: ReturnType<typeof schema128>, characterId: string, versions: Record<number, string | null>) {
  if (!store.get("SELECT 1 FROM sqlite_master WHERE name='web_character_versions'"))
    store.run(`CREATE TABLE web_character_versions(character_id TEXT NOT NULL,version INTEGER NOT NULL,
      profile_json TEXT NOT NULL,content_hash TEXT NOT NULL,created_at INTEGER,PRIMARY KEY(character_id,version)) STRICT`);
  for (const [version, welcome] of Object.entries(versions))
    store.run(
      'INSERT INTO web_character_versions VALUES (?,?,?,?,NULL)',
      characterId,
      Number(version),
      JSON.stringify({
        template: {},
        presentation: { displayName: 'x', publicDescription: '', welcome: { text: welcome, version: `w${version}` } },
      }),
      'h'.repeat(64),
    );
}
const userJson = (messages: { role: string; content: string }[]) => JSON.parse(messages[1]!.content);

test('a request without a welcome is byte-identical to main: request_json, digests and every prompt byte', (t) => {
  for (const setup of ['no catalog', 'profile without a welcome', 'profile row missing', 'empty welcome']) {
    const store = schema128();
    t.after(() => store.close());
    seedFreezeScenario(store);
    if (setup === 'profile without a welcome') publish(store, 'character', { 1: null });
    if (setup === 'empty welcome') publish(store, 'character', { 1: '   ' });
    if (setup === 'profile row missing') publish(store, 'character', { 7: WELCOME_A });
    const out = captureFreeze(store);
    assert.deepEqual(out.request, OFF_MAIN.request, setup);
    assert.deepEqual(out.prompts, OFF_MAIN.prompts, setup);
    assert.equal(out.promptSha256, OFF_MAIN.promptSha256, setup);
    assert.equal(out.request.request_json!.toString().includes('opening'), false, 'the key is absent, not null');
  }
});

test('the welcome of the frozen revision is the first line: an `opening` right before `messages`, said by the character as voice', (t) => {
  const store = schema128();
  t.after(() => store.close());
  seedFreezeScenario(store);
  publish(store, 'character', { 1: WELCOME_A });
  const out = captureFreeze(store);
  const request = JSON.parse(out.request.request_json as string);
  assert.deepEqual(request.opening, { text: WELCOME_A });
  for (const stage of [out.prompts.voice.draft, out.prompts.voice.review, out.prompts.text.draft]) {
    const content = userJson(stage);
    assert.deepEqual(content.opening, [{ authorKind: 'character', delivery: 'voice', text: WELCOME_A }]);
    const keys = Object.keys(content);
    assert.equal(keys[keys.indexOf('opening') + 1], 'messages', 'right before messages');
  }
  // The reviewer sees the same opening; the system prompts are the ones main has (no new sentence, no new hash).
  assert.deepEqual(userJson(out.prompts.voice.review).opening, userJson(out.prompts.voice.draft).opening);
  assert.deepEqual(out.prompts.voice.draft[0], OFF_MAIN.prompts.voice.draft[0]);
  assert.deepEqual(out.prompts.voice.review[0], OFF_MAIN.prompts.voice.review[0]);
  // Everything else in the user JSON is untouched: dropping the key gives main's bytes.
  const { opening: _drop, ...rest } = userJson(out.prompts.voice.draft);
  assert.equal(JSON.stringify(rest), JSON.stringify(userJson(OFF_MAIN.prompts.voice.draft)));
  // It is a line of the character's presentation, never a player fact or a memory.
  for (const table of ['web_player_facts', 'memory_topics', 'memory_episodes'])
    if (store.get('SELECT 1 FROM sqlite_master WHERE name=?', table))
      assert.equal(store.get<{ n: number }>(`SELECT count(*) n FROM ${table}`)!.n, 0, table);
});

test('the seed welcome serves a deployment that has no profile catalog yet', (t) => {
  const store = schema128();
  t.after(() => store.close());
  seedFreezeScenario(store, 'jojo');
  const { request } = (captureFreeze(store), readWebV7Request(store as unknown as WebStore, 'operation'));
  assert.deepEqual(request.opening, { text: 'Thanks Kobe，你终于来了' });
});

test('the welcome comes from the revision the template was frozen from, not the current one, even after an edit and republish', (t) => {
  const store = schema128();
  t.after(() => store.close());
  seedFreezeScenario(store);
  publish(store, 'character', { 1: WELCOME_A });
  const frozen = store as unknown as WebStore;
  freezeInputSnapshot(frozen, 'operation', FREEZE_NOW);
  // The welcome is edited and published as version 2 after the snapshot was taken; the live pointer moves on.
  publish(store, 'character', { 2: WELCOME_B });
  freezeWebV7Request(frozen, 'operation', FREEZE_NOW);
  assert.deepEqual(readWebV7Request(frozen, 'operation').request.opening, { text: WELCOME_A });
  // The first request is immutable: the same bytes, the same digest.
  assert.equal(readWebV7Request(frozen, 'operation').request.opening?.text, WELCOME_A);
});

test('a template frozen at version 2 says the version 2 welcome', (t) => {
  const store = schema128();
  t.after(() => store.close());
  seedFreezeScenario(store);
  publish(store, 'character', { 1: WELCOME_A, 2: WELCOME_B });
  const config = JSON.parse(
    store.get<{ config_json: string }>('SELECT config_json FROM character_templates WHERE id=?', 'character')!
      .config_json,
  );
  store.run(
    'UPDATE character_templates SET version=2, config_json=? WHERE id=?',
    JSON.stringify({ ...config, version: 2 }),
    'character',
  );
  captureFreeze(store);
  assert.deepEqual(readWebV7Request(store as unknown as WebStore, 'operation').request.opening, { text: WELCOME_B });
});

test('rows that are not eligible history (an unpublished earlier input, a note) do not remove the opening', (t) => {
  const store = schema128();
  t.after(() => store.close());
  seedFreezeScenario(store);
  publish(store, 'character', { 1: WELCOME_A });
  // Older than everything the request selects, but never published: not part of the eligible history.
  store.run(
    "INSERT INTO messages(seq,id,world_id,conversation_id,author_kind,author_id,body,created_at,delivery,proactive) VALUES (0,'older','world','conversation','character','character','更早的一句',?,'text',0)",
    FREEZE_NOW - 1,
  );
  const out = captureFreeze(store);
  assert.deepEqual(JSON.parse(out.request.request_json as string).opening, { text: WELCOME_A });
  assert.deepEqual(userJson(out.prompts.voice.draft).opening, [
    { authorKind: 'character', delivery: 'voice', text: WELCOME_A },
  ]);
});

/** The first send ('operation', never published) failed; `turns` published turns follow, then the current input 'last'. */
function afterFailedFirstSend(store: ReturnType<typeof schema128>, turns: number, extraItems = 0) {
  store.db.exec('PRAGMA foreign_keys=OFF');
  store.run(
    "UPDATE web_operations SET status='failed',quota_state='released',stage_version=stage_version+1 WHERE id='operation'",
  );
  let at = FREEZE_NOW,
    items = 0;
  const message = (id: string, kind: 'player' | 'character') =>
    store.run(
      "INSERT INTO messages(id,world_id,conversation_id,author_kind,author_id,body,created_at,delivery,proactive) VALUES (?,'world','conversation',?,?,?,?,'text',0)",
      id,
      kind,
      kind === 'player' ? 'player' : 'character',
      `说话${id}`,
      ++at,
    );
  for (let n = 1; n <= turns; n++) {
    message(`in${n}`, 'player');
    store.run(
      `INSERT INTO web_publications(operation_id,principal_id,player_id,world_id,conversation_id,character_id,input_message_id,job_id,
      request_digest,candidate_digest,published_at,receipt_json) VALUES (?,'principal','player','world','conversation','character',?,?,'d','c',?,'{}')`,
      `op${n}`,
      `in${n}`,
      `job${n}`,
      at,
    );
    for (let k = 0; k < 1 + (n === 1 ? extraItems : 0); k++) {
      message(`re${n}-${k}`, 'character');
      store.run(
        "INSERT INTO web_publication_items(operation_id,ordinal,message_id,media_id,origin) VALUES (?,?,?,'m','narrative')",
        `op${n}`,
        k,
        `re${n}-${k}`,
      );
      items++;
    }
  }
  message('last', 'player');
  store.run(
    `INSERT INTO web_operations(id,principal_id,request_id,payload_hash,world_id,conversation_id,character_id,input_message_id,
    ip_window_id,status,quota_state,created_at,deadline_at,metering_type)
    VALUES ('second','principal','request2','payload','world','conversation','character','last',NULL,'queued','reserved',?,?,'entitled')`,
    FREEZE_NOW,
    FREEZE_NOW + 100_000,
  );
  return items;
}
const freezeSecond = (store: ReturnType<typeof schema128>) => {
  const frozen = store as unknown as WebStore;
  freezeInputSnapshot(frozen, 'second', FREEZE_NOW);
  freezeWebV7Request(frozen, 'second', FREEZE_NOW);
  return readWebV7Request(frozen, 'second').request;
};

test('a failed first send, then a successful second send: the opening is included', (t) => {
  const store = schema128();
  t.after(() => store.close());
  seedFreezeScenario(store);
  publish(store, 'character', { 1: WELCOME_A });
  afterFailedFirstSend(store, 0);
  const request = freezeSecond(store);
  assert.deepEqual(request.opening, { text: WELCOME_A });
  assert.deepEqual(
    request.messages.map((m) => m.id),
    ['last'],
  );
});

test('the opening is kept while every eligible message fits the 24-message window and dropped the moment one is cut', (t) => {
  // 11 turns of (input, reply) + 1 extra reply + the current input = 24: nothing cut.
  const fits = schema128();
  t.after(() => fits.close());
  seedFreezeScenario(fits);
  publish(fits, 'character', { 1: WELCOME_A });
  afterFailedFirstSend(fits, 11, 1);
  const kept = freezeSecond(fits);
  assert.equal(kept.messages.length, 24);
  assert.deepEqual(kept.opening, { text: WELCOME_A });
  // One more eligible message: the oldest falls out of the window.
  for (const turns of [12, 26]) {
    const cut = schema128();
    t.after(() => cut.close());
    seedFreezeScenario(cut);
    publish(cut, 'character', { 1: WELCOME_A });
    afterFailedFirstSend(cut, turns, 1);
    const request = freezeSecond(cut);
    assert.equal(request.messages.length, 24);
    assert.equal('opening' in request, false, `${turns} published turns`);
    assert.equal(JSON.stringify(request).includes('opening'), false);
    assert.equal('opening' in userJson(promptMessages(request)), false);
  }
});

test('a group, a moment and a moment post never carry an opening', () => {
  const base = textRequest();
  assert.doesNotThrow(() => promptMessages({ ...base, opening: { text: WELCOME_A } }));
  const member = { id: base.character.id, name: base.character.name };
  const withKind = (conversation: NonNullable<typeof base.conversation>) =>
    promptMessages({ ...base, opening: { text: WELCOME_A }, conversation });
  assert.throws(
    () => withKind({ kind: 'group', name: '群', members: [member, { id: 'p2', name: '别人' }] }),
    /INVALID_TEXT_REQUEST/,
  );
  assert.throws(
    () => withKind({ kind: 'moment', postMessageId: 'question-1', name: '动态', members: [member] }),
    /INVALID_TEXT_REQUEST/,
  );
  const post = {
    ...base,
    opening: { text: WELCOME_A },
    deliveryMode: 'text' as const,
    requiredMessageIds: [],
    messages: [],
    conversation: { kind: 'moment_post' as const, name: '动态', members: [member] },
  };
  const { opening: _opening, ...plain } = post;
  assert.doesNotThrow(() => promptMessages(plain));
  assert.throws(() => promptMessages(post), /INVALID_TEXT_REQUEST/);
  // An empty or oversized line is not a welcome either.
  assert.throws(() => promptMessages({ ...base, opening: { text: '  ' } }), /INVALID_TEXT_REQUEST/);
  assert.throws(() => promptMessages({ ...base, opening: { text: '好'.repeat(501) } }), /INVALID_TEXT_REQUEST/);
  assert.deepEqual(userJson(reviewPromptMessages({ ...base, opening: { text: WELCOME_A } }, DRAFT)).opening, [
    { authorKind: 'character', delivery: 'voice', text: WELCOME_A },
  ]);
});

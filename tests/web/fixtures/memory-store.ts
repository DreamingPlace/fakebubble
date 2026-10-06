import { readFileSync, readdirSync } from 'node:fs';
import type { CharacterScope, DialogueCandidate } from '../../../packages/contracts/index.ts';
import { Store } from '../../../apps/server/platform/store.ts';
import {
  migrateWebProviderMemory,
  migrateWebProviderMetrics,
  migrateWebProviderOffline,
} from '../../../apps/server/generation/web-provider-migration.ts';

export const NOW = 1_700_000_000_000;
export const scope: CharacterScope = {
  playerId: 'player',
  worldId: 'world',
  conversationId: 'conversation',
  characterId: 'character',
};

/** An in-memory web database at schema 115 with one private conversation, two player messages and a character one. */
export function memoryStore() {
  const store = new Store(':memory:');
  const folder = new URL('../../../apps/server/web-migrations/', import.meta.url);
  for (const file of readdirSync(folder).sort()) {
    if (Number(file.slice(0, 3)) > 112) break;
    store.db.exec(readFileSync(new URL(file, folder), 'utf8'));
  }
  store.db.exec('PRAGMA user_version=112');
  migrateWebProviderOffline(store);
  migrateWebProviderMetrics(store);
  migrateWebProviderMemory(store);
  store.db.exec('PRAGMA foreign_keys=ON');
  store.run('INSERT INTO character_templates VALUES (?,?,?)', 'character', 1, '{}');
  store.run('INSERT INTO character_templates VALUES (?,?,?)', 'other', 1, '{}');
  store.run('INSERT INTO api_players VALUES (?,?)', 'player', NOW);
  store.run('INSERT INTO worlds VALUES (?,?,?,?)', 'world', 'player', 'UTC', '{}');
  for (const [character, conversation] of [
    ['character', 'conversation'],
    ['other', 'conversation-other'],
  ] as const) {
    store.run("INSERT INTO world_characters VALUES ('world',?,'new')", character);
    store.run(
      "INSERT INTO conversations(world_id,id,kind,private_character_id) VALUES ('world',?,'private',?)",
      conversation,
      character,
    );
    store.run("INSERT INTO participants VALUES ('world',?,?)", conversation, character);
    store.run("INSERT INTO contacts VALUES ('world',?,?,'{}')", conversation, character);
  }
  const message = (id: string, kind: 'player' | 'character', conversation = 'conversation') =>
    store.run(
      `INSERT INTO messages(id,world_id,conversation_id,author_kind,author_id,body,created_at,delivery,proactive)
      VALUES (?,'world',?,?,?,?,?,'text',0)`,
      id,
      conversation,
      kind,
      kind === 'player' ? 'player' : conversation === 'conversation' ? 'character' : 'other',
      `${id} body`,
      NOW,
    );
  message('p1', 'player');
  message('p2', 'player');
  message('c1', 'character');
  message('other-p1', 'player', 'conversation-other');
  for (const [job, conversation, character] of [
    ['job1', 'conversation', 'character'],
    ['job2', 'conversation', 'character'],
    ['job3', 'conversation', 'character'],
    ['job-other', 'conversation-other', 'other'],
  ] as const)
    store.run(
      `INSERT INTO jobs(id,world_id,conversation_id,character_id,kind,epoch,status,created_at,lease_until,
      covered_ids_json,requested_delivery) VALUES (?,'world',?,?,'reply',1,'published',?,?,'[]','voice')`,
      job,
      conversation,
      character,
      NOW,
      NOW,
    );
  return store;
}

export function candidate(
  topics: DialogueCandidate['topics'],
  extra: Partial<DialogueCandidate> = {},
): DialogueCandidate {
  return {
    text: '好的',
    delivery: 'text',
    bubbles: [{ text: '好的', expression: 'neutral' }],
    mode: 'casual',
    coveredMessageIds: ['p1'],
    deferredMessageIds: [],
    awaitingPlayerMessageIds: [],
    endsSession: false,
    topics,
    ...extra,
  };
}

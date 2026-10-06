import { readFileSync, readdirSync } from 'node:fs';
import type { CharacterScope } from '../../../packages/contracts/index.ts';
import { Store } from '../../../apps/server/platform/store.ts';
import { textRequest } from '../../text-fixtures.ts';
import {
  migrateWebProviderEmbeddings,
  migrateWebProviderMemory,
  migrateWebProviderMetrics,
  migrateWebProviderOffline,
} from '../../../apps/server/generation/web-provider-migration.ts';

export const T0 = 1_700_000_000_000;
export class TestClock {
  private ms: number;
  constructor(ms = T0) {
    this.ms = ms;
  }
  now() {
    return this.ms;
  }
  advance(ms: number) {
    this.ms += ms;
  }
}

export interface Player {
  n: number;
  principalId: string;
  playerId: string;
  scope: CharacterScope;
}

/** An in-memory web database at schema 116 with the embedding allowance configured. */
export function embedStore(options: { allowance?: boolean } = {}) {
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
  migrateWebProviderEmbeddings(store);
  store.db.exec('PRAGMA foreign_keys=ON');
  store.run('INSERT INTO web_instance(singleton,instance_id) VALUES (1,?)', 'fixture-instance');
  store.run('INSERT INTO character_templates VALUES (?,?,?)', 'character', 1, '{}');
  if (options.allowance !== false)
    store.run("INSERT INTO web_provider_spending(provider,currency,limit_micros) VALUES ('cloudflare','USD',1000000)");
  return store;
}

/** One player with one world, one private conversation with 'character' and a principal of the given kind. */
export function addPlayer(store: Store, n: number, kind: 'guest' | 'account' = 'account'): Player {
  const playerId = `player${n}`;
  const world = `world${n}`;
  const conversation = `conversation${n}`;
  store.run('INSERT INTO api_players VALUES (?,?)', playerId, T0);
  store.run('INSERT INTO worlds VALUES (?,?,?,?)', world, playerId, 'UTC', '{}');
  store.run("INSERT INTO world_characters VALUES (?,'character','new')", world);
  store.run(
    "INSERT INTO conversations(world_id,id,kind,private_character_id) VALUES (?,?,'private','character')",
    world,
    conversation,
  );
  store.run("INSERT INTO participants VALUES (?,?,'character')", world, conversation);
  store.run("INSERT INTO contacts VALUES (?,?,'character','{}')", world, conversation);
  store.run(
    'INSERT INTO web_principals(id,player_id,world_id,kind) VALUES (?,?,?,?)',
    `principal${n}`,
    playerId,
    world,
    kind,
  );
  store.run(
    `INSERT INTO web_guest_retention(principal_id,world_id,started_at,expires_at,state) VALUES (?,?,?,?,?)`,
    `principal${n}`,
    world,
    kind === 'guest' ? T0 - 1 : null,
    kind === 'guest' ? T0 + 999_999_999 : null,
    kind === 'guest' ? 'active' : 'protected',
  );
  if (kind === 'account')
    store.run(
      `INSERT INTO web_accounts(id,principal_id,username_norm,password_salt,password_tag,created_at) VALUES (?,?,?,x'00',x'00',?)`,
      `account${n}`,
      `principal${n}`,
      `user${n}`,
      T0,
    );
  return {
    n,
    principalId: `principal${n}`,
    playerId,
    scope: { playerId, worldId: world, conversationId: conversation, characterId: 'character' },
  };
}

let sequence = 0;
/**
 * A topic with one episode (a job per episode); calling it again for the same key adds a NEWER episode. Every episode
 * comes from a published prior operation of this player, so a later request freeze accepts it as trusted memory.
 */
export function addTopic(
  store: Store,
  player: Player,
  key: string,
  summary: string,
  options: { at?: number; importance?: number; tier?: 'short' | 'long' } = {},
) {
  const at = options.at ?? T0;
  const { worldId, conversationId } = player.scope;
  const k = ++sequence;
  const job = `job${k}`;
  const prior = `prior-op${k}`;
  const message = `prior-input${k}`;
  store.run(
    `INSERT INTO messages(id,world_id,conversation_id,author_kind,author_id,body,created_at,delivery,proactive)
    VALUES (?,?,?,'player',?,?,?,'text',0)`,
    message,
    worldId,
    conversationId,
    player.playerId,
    `之前的话${k}`,
    at,
  );
  store.run(
    `INSERT INTO web_operations(id,principal_id,request_id,payload_hash,world_id,conversation_id,character_id,
    input_message_id,ip_window_id,status,quota_state,created_at,deadline_at,text_queued_at,admission_seq,metering_type)
    VALUES (?,?,?,?,?,?,'character',?,NULL,'published','used',?,?,?,?,'entitled')`,
    prior,
    player.principalId,
    `prior-request${k}`,
    `prior-payload${k}`,
    worldId,
    conversationId,
    message,
    at,
    at + 300_000,
    at,
    1000 + k,
  );
  store.run(
    `INSERT INTO jobs(id,world_id,conversation_id,character_id,kind,epoch,status,created_at,lease_until,
    covered_ids_json,requested_delivery) VALUES (?,?,?,'character','reply',1,'published',?,?,'[]','voice')`,
    job,
    worldId,
    conversationId,
    at,
    at,
  );
  store.run(
    `INSERT INTO web_publications(operation_id,principal_id,player_id,world_id,conversation_id,character_id,
    input_message_id,job_id,request_digest,candidate_digest,published_at,receipt_json)
    VALUES (?,?,?,?,?,'character',?,?,?,?,?,'{}')`,
    prior,
    player.principalId,
    player.playerId,
    worldId,
    conversationId,
    message,
    job,
    'a'.repeat(64),
    'b'.repeat(64),
    at,
  );
  store.run(
    `INSERT INTO memory_topics VALUES (?,?,'character',?,?,0,?,?,?)
    ON CONFLICT(world_id,conversation_id,character_id,topic_key) DO UPDATE SET last_seen=excluded.last_seen`,
    worldId,
    conversationId,
    key,
    options.tier ?? 'long',
    at,
    at + 3_600_000,
    options.importance ?? 5,
  );
  store.run(
    "INSERT OR IGNORE INTO memory_catalog(id,world_id,conversation_id,character_id,topic_key) VALUES (?,?,?,'character',?)",
    `catalog${k}`,
    worldId,
    conversationId,
    key,
  );
  store.run(
    "INSERT INTO memory_episodes VALUES (?,?,'character',?,?,?,'conversation',?,?)",
    worldId,
    conversationId,
    key,
    job,
    summary,
    JSON.stringify([message]),
    at,
  );
}

export const count = (store: Store, sql: string, ...params: (string | number)[]) =>
  store.get<{ n: number }>(`SELECT count(*) n FROM (${sql})`, ...params)!.n;
export const spending = (store: Store) =>
  store.get<{ held_micros: number; spent_micros: number }>(
    "SELECT held_micros,spent_micros FROM web_provider_spending WHERE provider='cloudflare'",
  )!;
export const metrics = (store: Store) =>
  store.all<Record<string, number | string>>('SELECT * FROM web_embed_metrics ORDER BY day');

let operations = 0;
/**
 * A queued, entitled operation with its player input message, ready for the first text claim (which freezes the input
 * snapshot and the v7 request). Also makes sure the character has a valid template and an approved voice binding.
 */
export function addOperation(
  store: Store,
  player: Player,
  body: string,
  options: { id?: string; queuedAt?: number; template?: string } = {},
) {
  const n = ++operations;
  const id = options.id ?? `operation${n}`;
  const { worldId, conversationId } = player.scope;
  store.run(
    'UPDATE character_templates SET config_json=? WHERE id=?',
    options.template ?? JSON.stringify({ ...textRequest().character, id: 'character' }),
    'character',
  );
  if (!store.get('SELECT 1 FROM web_provider_voice_bindings WHERE character_id=?', 'character'))
    store.run(
      "INSERT INTO web_provider_voice_bindings VALUES ('character','voice:v1',1,'profile','reference','s2.1-pro','synthetic_fixture',1,NULL)",
    );
  store.run(
    `INSERT INTO messages(id,world_id,conversation_id,author_kind,author_id,body,created_at,delivery,proactive)
    VALUES (?,?,?,'player',?,?,?,'text',0)`,
    `input${n}`,
    worldId,
    conversationId,
    player.playerId,
    body,
    options.queuedAt ?? T0,
  );
  store.run(
    `INSERT INTO web_operations(id,principal_id,request_id,payload_hash,world_id,conversation_id,character_id,
    input_message_id,ip_window_id,status,quota_state,created_at,deadline_at,text_queued_at,admission_seq,metering_type)
    VALUES (?,?,?,?,?,?,'character',?,NULL,'queued','reserved',?,?,?,?,'entitled')`,
    id,
    player.principalId,
    `request${n}`,
    `payload${n}`,
    worldId,
    conversationId,
    `input${n}`,
    options.queuedAt ?? T0,
    (options.queuedAt ?? T0) + 300_000,
    options.queuedAt ?? T0,
    n,
  );
  return { id, messageId: `input${n}` };
}

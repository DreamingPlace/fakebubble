import { readFileSync, readdirSync } from 'node:fs';
import type { CharacterScope } from '../../../packages/contracts/index.ts';
import { Store } from '../../../apps/server/platform/store.ts';
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
  return {
    n,
    principalId: `principal${n}`,
    playerId,
    scope: { playerId, worldId: world, conversationId: conversation, characterId: 'character' },
  };
}

let sequence = 0;
/** A topic with one episode (a job per episode); calling it again for the same key adds a NEWER episode. */
export function addTopic(
  store: Store,
  player: Player,
  key: string,
  summary: string,
  options: { at?: number; importance?: number; tier?: 'short' | 'long' } = {},
) {
  const at = options.at ?? T0;
  const { worldId, conversationId } = player.scope;
  const job = `job${++sequence}`;
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
    `catalog${++sequence}`,
    worldId,
    conversationId,
    key,
  );
  store.run(
    "INSERT INTO memory_episodes VALUES (?,?,'character',?,?,?,'conversation','[]',?)",
    worldId,
    conversationId,
    key,
    job,
    summary,
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

import { createHash } from 'node:crypto';
import type { TextDraft } from '../../../apps/server/generation/accepted-text-protocol.ts';
import { promptMessages, reviewPromptMessages } from '../../../apps/server/generation/accepted-text-prompt.ts';
import { WebProviderOffline } from '../../../apps/server/generation/web-provider-offline.ts';
import { freezeInputSnapshot } from '../../../apps/server/generation/web-input-snapshot.ts';
import { freezeWebV7Request, readWebV7Request } from '../../../apps/server/generation/web-v7-request.ts';
import type { Store, WebStore } from '../../../apps/server/platform/store.ts';
import { textRequest } from '../../text-fixtures.ts';
import { schema127 } from './invite-tiers.ts';
import { migrateWebProviderStats } from '../../../apps/server/generation/web-provider-migration.ts';

/**
 * Part 24a: one reply frozen end to end - the input snapshot, the v7 request and every prompt byte - on a store whose schema is
 * decided by the caller. The same scenario was run on main (3f57e04, schema 128) to capture tests/web/fixtures/cast-off-main.json;
 * with CAST_CONTEXT_ENABLED off, or on with nothing published, schema 129 must reproduce it exactly.
 */
export const FREEZE_NOW = 1_800_000_000_000;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

/** The real schema through 128 (the schema of main before Part 24a). */
export function schema128() {
  const store = schema127();
  migrateWebProviderStats(store, FREEZE_NOW);
  return store;
}

export function seedFreezeScenario(store: Store, characterId = 'character') {
  store.run('INSERT INTO web_instance(singleton,instance_id) VALUES (1,?)', 'fixture-instance');
  store.run(
    'INSERT OR REPLACE INTO character_templates VALUES (?,?,?)',
    characterId,
    1,
    JSON.stringify({ ...textRequest().character, id: characterId, name: '快照角色' }),
  );
  store.run('INSERT INTO api_players VALUES (?,?)', 'player', FREEZE_NOW);
  store.run('INSERT INTO worlds VALUES (?,?,?,?)', 'world', 'player', 'UTC', '{}');
  store.run("INSERT INTO world_characters VALUES ('world',?,'friend')", characterId);
  store.run(
    "INSERT INTO conversations(world_id,id,kind,private_character_id) VALUES ('world','conversation','private',?)",
    characterId,
  );
  store.run("INSERT INTO participants VALUES ('world','conversation',?)", characterId);
  store.run("INSERT INTO contacts VALUES ('world','conversation',?,'{}')", characterId);
  store.run(
    "INSERT INTO messages(id,world_id,conversation_id,author_kind,author_id,body,created_at,delivery,proactive) VALUES ('input','world','conversation','player','player','今天想聊什么？',?,'text',0)",
    FREEZE_NOW,
  );
  store.run("INSERT INTO web_principals(id,player_id,world_id,kind) VALUES ('principal','player','world','guest')");
  store.run(
    `INSERT INTO web_guest_retention(principal_id,world_id,started_at,expires_at,state) VALUES ('principal','world',?,?,'active')`,
    FREEZE_NOW - 1,
    FREEZE_NOW + 999_999,
  );
  store.run(
    `INSERT INTO web_operations(id,principal_id,request_id,payload_hash,world_id,conversation_id,
    character_id,input_message_id,ip_window_id,status,quota_state,created_at,deadline_at,metering_type)
    VALUES ('operation','principal','request','payload','world','conversation',?,'input',
      NULL,'queued','reserved',?,?,'entitled')`,
    characterId,
    FREEZE_NOW,
    FREEZE_NOW + 100_000,
  );
  new WebProviderOffline(store, { now: () => FREEZE_NOW }).configureVoice({
    characterId,
    voiceVersion: 'fixture-voice:v1',
    voiceRevision: 1,
    profileId: 'synthetic-profile',
    referenceId: 'synthetic-reference',
    model: 's2.1-pro',
    approved: true,
  });
}

const DRAFT: TextDraft = {
  mode: 'casual',
  bubbles: [{ text: '好呀，聊聊今天吧', expression: 'neutral' }],
  endsSession: false,
} as never;

/** Freeze 'operation' and report everything that must not move while the switch is off. */
export function captureFreeze(store: Store, castContext?: boolean) {
  const frozen = store as unknown as WebStore;
  if (castContext !== undefined) Object.assign(store, { castContext });
  freezeInputSnapshot(frozen, 'operation', FREEZE_NOW);
  freezeWebV7Request(frozen, 'operation', FREEZE_NOW);
  const snapshot = store.get<Record<string, unknown>>(
    `SELECT operation_id,capability,format_version,principal_id,player_id,world_id,conversation_id,character_id,input_message_id,
    input_seq,input_body,input_digest,template_version,template_json,template_digest,access_revision,frozen_at,snapshot_digest
    FROM web_input_snapshots WHERE operation_id='operation'`,
  )!;
  const row = store.get<Record<string, string | number>>(
    `SELECT request_json,request_digest,protocol_digest,prompt_digest,memory_version,player_context_key,relationship_version,
    scene_revision,voice_version,frozen_at FROM web_v7_requests WHERE operation_id='operation'`,
  )!;
  const { request } = readWebV7Request(frozen, 'operation');
  const text = { ...request, deliveryMode: 'text' as const };
  const prompts = (r: typeof request) => ({
    draft: promptMessages(r),
    review: reviewPromptMessages(r, DRAFT),
  });
  const voice = prompts(request),
    plain = prompts(text);
  // plain objects (node:sqlite rows have no prototype), so they compare with the JSON captured on main
  return JSON.parse(
    JSON.stringify({
      snapshot,
      request: row,
      prompts: { voice, text: plain },
      promptSha256: sha(JSON.stringify([voice, plain])),
    }),
  ) as {
    snapshot: Record<string, unknown>;
    request: Record<string, string | number>;
    prompts: {
      voice: { draft: { role: string; content: string }[]; review: { role: string; content: string }[] };
      text: { draft: { role: string; content: string }[]; review: { role: string; content: string }[] };
    };
    promptSha256: string;
  };
}

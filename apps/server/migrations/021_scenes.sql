CREATE TABLE scene_states (
  world_id TEXT NOT NULL, conversation_id TEXT NOT NULL, character_id TEXT NOT NULL,
  revision INTEGER NOT NULL, scene_json TEXT NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER, control_input_seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(world_id, conversation_id, character_id),
  FOREIGN KEY(world_id, conversation_id, character_id) REFERENCES participants(world_id, conversation_id, character_id)
) STRICT;
CREATE TABLE scene_job_contexts (
  world_id TEXT NOT NULL, conversation_id TEXT NOT NULL, character_id TEXT NOT NULL, job_id TEXT NOT NULL UNIQUE,
  context_json TEXT NOT NULL, last_input_seq INTEGER NOT NULL,
  PRIMARY KEY(world_id, conversation_id, character_id, job_id),
  FOREIGN KEY(world_id, conversation_id, job_id) REFERENCES jobs(world_id, conversation_id, id)
) STRICT;
CREATE TABLE scene_events (
  id TEXT PRIMARY KEY, world_id TEXT NOT NULL, conversation_id TEXT NOT NULL, character_id TEXT NOT NULL,
  revision INTEGER NOT NULL, scene_json TEXT NOT NULL, recorded_at INTEGER NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('dialogue','player_control')),
  evidence_json TEXT NOT NULL, response_json TEXT, job_id TEXT UNIQUE,
  UNIQUE(world_id, conversation_id, character_id, revision),
  FOREIGN KEY(world_id, conversation_id, character_id) REFERENCES participants(world_id, conversation_id, character_id),
  FOREIGN KEY(world_id, conversation_id, job_id) REFERENCES jobs(world_id, conversation_id, id)
) STRICT;
CREATE TABLE scene_end_requests (
  world_id TEXT NOT NULL, conversation_id TEXT NOT NULL, character_id TEXT NOT NULL,
  request_id TEXT NOT NULL, request_hash TEXT NOT NULL, revision INTEGER NOT NULL, recorded_at INTEGER NOT NULL,
  PRIMARY KEY(world_id, request_id),
  FOREIGN KEY(world_id, conversation_id, character_id) REFERENCES participants(world_id, conversation_id, character_id)
) STRICT;
ALTER TABLE jobs ADD COLUMN scene_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE speech_tasks ADD COLUMN delivery_style TEXT NOT NULL DEFAULT 'conversational';

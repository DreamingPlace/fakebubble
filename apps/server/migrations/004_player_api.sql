CREATE TABLE api_players (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE api_devices (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL REFERENCES api_players(id),
  secret_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
) STRICT;
CREATE TABLE pairing_invites (
  token_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  target_player_id TEXT REFERENCES api_players(id),
  consumed_device_id TEXT REFERENCES api_devices(id),
  claim_hash TEXT
) STRICT;
CREATE TABLE world_setup_receipts (
  player_id TEXT PRIMARY KEY REFERENCES api_players(id),
  request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  world_id TEXT NOT NULL REFERENCES worlds(id)
) STRICT;
CREATE TABLE text_attempts (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id),
  world_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  character_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL CHECK(status IN ('running','published','failed','interrupted')),
  error_code TEXT,
  generation_json TEXT,
  FOREIGN KEY(world_id,conversation_id,character_id) REFERENCES contacts(world_id,conversation_id,character_id)
) STRICT;
CREATE TABLE text_retry_state (
  world_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  character_id TEXT NOT NULL,
  failures INTEGER NOT NULL,
  retry_at INTEGER,
  error_code TEXT NOT NULL,
  PRIMARY KEY(world_id,conversation_id,character_id),
  FOREIGN KEY(world_id,conversation_id,character_id) REFERENCES contacts(world_id,conversation_id,character_id)
) STRICT;
CREATE INDEX outbox_world_cursor ON outbox(world_id,seq);
CREATE INDEX messages_conversation_cursor ON messages(world_id,conversation_id,seq);
CREATE INDEX text_attempts_scope ON text_attempts(world_id,conversation_id,character_id,started_at);

ALTER TABLE messages ADD COLUMN reply_to_json TEXT CHECK(reply_to_json IS NULL OR json_valid(reply_to_json));
ALTER TABLE batches ADD COLUMN response_ready_at INTEGER NOT NULL DEFAULT 0 CHECK(response_ready_at >= 0);

CREATE TABLE response_fallbacks (
  trigger_message_id TEXT PRIMARY KEY REFERENCES messages(id),
  world_id TEXT NOT NULL REFERENCES worlds(id),
  conversation_id TEXT NOT NULL,
  character_id TEXT NOT NULL,
  batch_id TEXT NOT NULL REFERENCES batches(id),
  created_at INTEGER NOT NULL,
  FOREIGN KEY(world_id,conversation_id,character_id) REFERENCES contacts(world_id,conversation_id,character_id)
) STRICT;

CREATE TABLE message_feedback (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  world_id TEXT NOT NULL REFERENCES worlds(id),
  conversation_id TEXT NOT NULL,
  character_id TEXT NOT NULL,
  message_id TEXT NOT NULL REFERENCES messages(id),
  request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  category TEXT NOT NULL CHECK(category IN ('tone','incomplete','logic','persona','other')),
  note TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  created_at INTEGER NOT NULL,
  UNIQUE(world_id,request_id),
  FOREIGN KEY(world_id,conversation_id,character_id) REFERENCES contacts(world_id,conversation_id,character_id)
) STRICT;
CREATE INDEX message_feedback_character ON message_feedback(character_id,seq);

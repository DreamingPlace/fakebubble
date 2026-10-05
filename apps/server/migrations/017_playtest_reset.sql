-- Test reset is an explicit data operation, never a conversational memory command.
CREATE TABLE playtest_resets (
  id TEXT PRIMARY KEY, world_id TEXT NOT NULL REFERENCES worlds(id), character_id TEXT NOT NULL,
  old_conversation_id TEXT NOT NULL, new_conversation_id TEXT NOT NULL,
  request_id TEXT NOT NULL, request_hash TEXT NOT NULL, relationship TEXT NOT NULL,
  created_at INTEGER NOT NULL, UNIQUE(world_id,request_id), UNIQUE(world_id,old_conversation_id)
) STRICT;
CREATE TABLE retired_sync_cursors (
  world_id TEXT NOT NULL REFERENCES worlds(id), message_id TEXT NOT NULL, seq INTEGER NOT NULL,
  PRIMARY KEY(world_id,message_id)
) STRICT;
CREATE TABLE retired_proactive_usage (
  world_id TEXT NOT NULL REFERENCES worlds(id), character_id TEXT NOT NULL, quota_day TEXT NOT NULL,
  contacts INTEGER NOT NULL CHECK(contacts>0), last_at INTEGER NOT NULL,
  PRIMARY KEY(world_id,character_id,quota_day)
) STRICT;
CREATE TABLE playtest_reset_usage (
  reset_id TEXT NOT NULL REFERENCES playtest_resets(id), kind TEXT NOT NULL, task_id TEXT NOT NULL,
  status TEXT NOT NULL, generation_json TEXT, PRIMARY KEY(reset_id,kind,task_id)
) STRICT;
CREATE TABLE playtest_media_cleanup (
  media_id TEXT PRIMARY KEY, reset_id TEXT NOT NULL REFERENCES playtest_resets(id), error_code TEXT
) STRICT;

-- Submitted QA originals are intentionally retained outside the deleted chat history.
CREATE TABLE message_feedback_next (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
  world_id TEXT NOT NULL REFERENCES worlds(id), conversation_id TEXT NOT NULL, character_id TEXT NOT NULL,
  message_id TEXT NOT NULL, request_id TEXT NOT NULL, request_hash TEXT NOT NULL,
  category TEXT NOT NULL CHECK(category IN ('tone','incomplete','logic','persona','other')),
  note TEXT NOT NULL, snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)), created_at INTEGER NOT NULL,
  UNIQUE(world_id,request_id),
  FOREIGN KEY(world_id,character_id) REFERENCES world_characters(world_id,character_id)
) STRICT;
INSERT INTO message_feedback_next SELECT * FROM message_feedback;
DROP TABLE message_feedback;
ALTER TABLE message_feedback_next RENAME TO message_feedback;
CREATE INDEX message_feedback_character ON message_feedback(character_id,seq);

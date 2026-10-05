ALTER TABLE reply_items ADD COLUMN not_before INTEGER NOT NULL DEFAULT 0;
CREATE TABLE dialogue_bubbles (
  world_id TEXT NOT NULL, conversation_id TEXT NOT NULL, job_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0), message_id TEXT NOT NULL UNIQUE REFERENCES messages(id),
  expression TEXT NOT NULL, PRIMARY KEY(job_id, ordinal),
  FOREIGN KEY(world_id, conversation_id, job_id) REFERENCES jobs(world_id, conversation_id, id)
) STRICT;
CREATE TABLE memory_topics (
  world_id TEXT NOT NULL, conversation_id TEXT NOT NULL, character_id TEXT NOT NULL,
  topic_key TEXT NOT NULL, tier TEXT NOT NULL CHECK(tier IN ('short','long')),
  player_mentions INTEGER NOT NULL DEFAULT 0, last_seen INTEGER NOT NULL, active_until INTEGER NOT NULL,
  PRIMARY KEY(world_id, conversation_id, character_id, topic_key),
  FOREIGN KEY(world_id, conversation_id, character_id) REFERENCES contacts(world_id, conversation_id, character_id)
) STRICT;
CREATE TABLE memory_episodes (
  world_id TEXT NOT NULL, conversation_id TEXT NOT NULL, character_id TEXT NOT NULL, topic_key TEXT NOT NULL,
  job_id TEXT NOT NULL, summary TEXT NOT NULL, source_kind TEXT NOT NULL,
  evidence_ids_json TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY(world_id, conversation_id, character_id, topic_key, job_id),
  FOREIGN KEY(world_id, conversation_id, character_id, topic_key) REFERENCES memory_topics(world_id, conversation_id, character_id, topic_key),
  FOREIGN KEY(world_id, conversation_id, job_id) REFERENCES jobs(world_id, conversation_id, id)
) STRICT;
CREATE TABLE memory_mentions (
  world_id TEXT NOT NULL, conversation_id TEXT NOT NULL, character_id TEXT NOT NULL, topic_key TEXT NOT NULL,
  message_id TEXT NOT NULL REFERENCES messages(id),
  PRIMARY KEY(world_id, conversation_id, character_id, topic_key, message_id),
  FOREIGN KEY(world_id, conversation_id, character_id, topic_key) REFERENCES memory_topics(world_id, conversation_id, character_id, topic_key)
) STRICT;

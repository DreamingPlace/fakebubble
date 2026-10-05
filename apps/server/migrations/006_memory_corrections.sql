CREATE TABLE memory_catalog (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
  world_id TEXT NOT NULL, conversation_id TEXT NOT NULL, character_id TEXT NOT NULL, topic_key TEXT NOT NULL,
  UNIQUE(world_id,conversation_id,character_id,topic_key),
  FOREIGN KEY(world_id,conversation_id,character_id,topic_key) REFERENCES memory_topics(world_id,conversation_id,character_id,topic_key)
) STRICT;
INSERT INTO memory_catalog(id,world_id,conversation_id,character_id,topic_key)
  SELECT lower(hex(randomblob(16))),world_id,conversation_id,character_id,topic_key FROM memory_topics ORDER BY rowid;
CREATE INDEX memory_catalog_scope ON memory_catalog(world_id,conversation_id,character_id,seq);
CREATE TABLE memory_corrections (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
  world_id TEXT NOT NULL, conversation_id TEXT NOT NULL, character_id TEXT NOT NULL, topic_key TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>0), request_id TEXT NOT NULL, request_hash TEXT NOT NULL,
  summary TEXT NOT NULL, reason TEXT NOT NULL, evidence_ids_json TEXT NOT NULL, recorded_at INTEGER NOT NULL,
  UNIQUE(world_id,request_id), UNIQUE(world_id,conversation_id,character_id,topic_key,revision),
  FOREIGN KEY(world_id,conversation_id,character_id,topic_key) REFERENCES memory_topics(world_id,conversation_id,character_id,topic_key)
) STRICT;
CREATE INDEX memory_corrections_scope ON memory_corrections(world_id,conversation_id,character_id,seq);
CREATE TABLE memory_context_versions (
  world_id TEXT NOT NULL, conversation_id TEXT NOT NULL, character_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>0),
  PRIMARY KEY(world_id,conversation_id,character_id),
  FOREIGN KEY(world_id,conversation_id,character_id) REFERENCES contacts(world_id,conversation_id,character_id)
) STRICT;
ALTER TABLE jobs ADD COLUMN memory_version INTEGER NOT NULL DEFAULT 0 CHECK(memory_version>=0);

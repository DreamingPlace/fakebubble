CREATE TABLE conversation_reads (
  world_id TEXT NOT NULL, conversation_id TEXT NOT NULL, through_seq INTEGER NOT NULL CHECK(through_seq>=0),
  PRIMARY KEY(world_id,conversation_id),
  FOREIGN KEY(world_id,conversation_id) REFERENCES conversations(world_id,id)
) STRICT;
CREATE TABLE player_characters (
  character_id TEXT PRIMARY KEY REFERENCES character_templates(id), world_id TEXT NOT NULL REFERENCES worlds(id),
  request_id TEXT NOT NULL, request_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
  UNIQUE(world_id,request_id)
) STRICT;
CREATE TABLE relationship_test_versions (
  world_id TEXT NOT NULL, conversation_id TEXT NOT NULL, character_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>0), values_json TEXT,
  request_id TEXT NOT NULL, request_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY(world_id,conversation_id,character_id,revision), UNIQUE(world_id,request_id),
  FOREIGN KEY(world_id,conversation_id,character_id) REFERENCES contacts(world_id,conversation_id,character_id)
) STRICT;

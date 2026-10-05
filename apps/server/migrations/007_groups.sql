CREATE TABLE group_conversations (
  world_id TEXT NOT NULL, conversation_id TEXT NOT NULL, name TEXT NOT NULL,
  created_at INTEGER, next_recipient INTEGER NOT NULL DEFAULT 0 CHECK(next_recipient>=0),
  PRIMARY KEY(world_id,conversation_id),
  FOREIGN KEY(world_id,conversation_id) REFERENCES conversations(world_id,id)
) STRICT;
INSERT INTO group_conversations(world_id,conversation_id,name)
  SELECT world_id,id,'群聊' FROM conversations WHERE kind='group';
CREATE TABLE group_creation_receipts (
  world_id TEXT NOT NULL, request_id TEXT NOT NULL, request_hash TEXT NOT NULL, conversation_id TEXT NOT NULL,
  PRIMARY KEY(world_id,request_id),
  FOREIGN KEY(world_id,conversation_id) REFERENCES group_conversations(world_id,conversation_id)
) STRICT;
ALTER TABLE messages ADD COLUMN mentioned_ids_json TEXT;
CREATE TABLE group_message_routes (
  world_id TEXT NOT NULL, conversation_id TEXT NOT NULL, message_id TEXT NOT NULL UNIQUE REFERENCES messages(id),
  request_id TEXT NOT NULL, request_hash TEXT NOT NULL, routing_json TEXT NOT NULL,
  PRIMARY KEY(world_id,request_id),
  FOREIGN KEY(world_id,conversation_id) REFERENCES group_conversations(world_id,conversation_id)
) STRICT;
CREATE INDEX group_routes_scope ON group_message_routes(world_id,conversation_id);
CREATE TABLE group_job_reads (
  world_id TEXT NOT NULL, conversation_id TEXT NOT NULL, character_id TEXT NOT NULL,
  job_id TEXT NOT NULL PRIMARY KEY, message_ids_json TEXT NOT NULL,
  FOREIGN KEY(world_id,conversation_id,job_id) REFERENCES jobs(world_id,conversation_id,id),
  FOREIGN KEY(world_id,conversation_id,character_id) REFERENCES participants(world_id,conversation_id,character_id)
) STRICT;
CREATE TABLE group_message_knowledge (
  world_id TEXT NOT NULL, conversation_id TEXT NOT NULL, character_id TEXT NOT NULL,
  message_id TEXT NOT NULL REFERENCES messages(id), learned_at INTEGER NOT NULL, evidence_job_id TEXT NOT NULL,
  PRIMARY KEY(world_id,conversation_id,character_id,message_id),
  FOREIGN KEY(world_id,conversation_id,evidence_job_id) REFERENCES jobs(world_id,conversation_id,id),
  FOREIGN KEY(world_id,conversation_id,character_id) REFERENCES participants(world_id,conversation_id,character_id)
) STRICT;
CREATE INDEX group_knowledge_actor ON group_message_knowledge(world_id,character_id,learned_at);

CREATE TABLE moment_threads (
  world_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  root_message_id TEXT NOT NULL,
  responder_id TEXT NOT NULL,
  liked INTEGER NOT NULL DEFAULT 0 CHECK(liked IN (0,1)),
  like_revision INTEGER NOT NULL DEFAULT 0 CHECK(like_revision >= 0),
  PRIMARY KEY(world_id,conversation_id),
  FOREIGN KEY(world_id,conversation_id) REFERENCES conversations(world_id,id),
  FOREIGN KEY(world_id,conversation_id,responder_id) REFERENCES participants(world_id,conversation_id,character_id),
  FOREIGN KEY(root_message_id) REFERENCES messages(id)
) STRICT;
CREATE TABLE moment_requests (
  world_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('create','comment','like')),
  request_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  PRIMARY KEY(world_id,request_id),
  FOREIGN KEY(world_id,conversation_id) REFERENCES moment_threads(world_id,conversation_id)
) STRICT;
CREATE INDEX moment_requests_thread ON moment_requests(world_id,conversation_id);

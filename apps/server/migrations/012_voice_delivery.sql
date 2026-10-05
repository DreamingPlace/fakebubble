CREATE TABLE voice_profiles (
  id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version>0),
  profile_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  approved_at INTEGER,
  approval_note TEXT,
  PRIMARY KEY(id,version)
) STRICT;
CREATE TABLE speech_tasks (
  media_id TEXT PRIMARY KEY REFERENCES media(id),
  world_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  character_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal>=0 AND ordinal<6),
  attempt INTEGER NOT NULL CHECK(attempt>0),
  profile_json TEXT NOT NULL,
  text TEXT NOT NULL,
  expression TEXT NOT NULL,
  speed REAL NOT NULL,
  retry INTEGER NOT NULL CHECK(retry IN (0,1)),
  state TEXT NOT NULL CHECK(state IN ('queued','generating','ready','failed')),
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  lease_until INTEGER,
  error_code TEXT,
  generation_json TEXT,
  duration_ms INTEGER,
  byte_length INTEGER,
  sha256 TEXT,
  UNIQUE(job_id,ordinal,attempt),
  FOREIGN KEY(world_id,conversation_id,character_id) REFERENCES contacts(world_id,conversation_id,character_id),
  FOREIGN KEY(world_id,conversation_id,job_id) REFERENCES jobs(world_id,conversation_id,id)
) STRICT;
CREATE INDEX speech_tasks_due ON speech_tasks(state,retry,created_at);
CREATE TABLE speech_retry_receipts (
  world_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL REFERENCES messages(id),
  request_id TEXT NOT NULL,
  media_id TEXT NOT NULL REFERENCES speech_tasks(media_id),
  PRIMARY KEY(world_id,request_id),
  FOREIGN KEY(world_id,conversation_id) REFERENCES conversations(world_id,id)
) STRICT;

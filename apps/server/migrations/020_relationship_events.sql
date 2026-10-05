CREATE TABLE relationship_states (
  world_id TEXT NOT NULL, character_id TEXT NOT NULL, revision INTEGER NOT NULL,
  trust_delta INTEGER NOT NULL DEFAULT 0, familiarity_delta INTEGER NOT NULL DEFAULT 0,
  positive_days INTEGER NOT NULL DEFAULT 0, kinds_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY(world_id, character_id),
  FOREIGN KEY(world_id, character_id) REFERENCES world_characters(world_id, character_id)
) STRICT;
CREATE TABLE relationship_daily_budgets (
  world_id TEXT NOT NULL, character_id TEXT NOT NULL, local_day TEXT NOT NULL,
  positive_used INTEGER NOT NULL DEFAULT 0, negative_used INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(world_id, character_id, local_day),
  FOREIGN KEY(world_id, character_id) REFERENCES world_characters(world_id, character_id)
) STRICT;
CREATE TABLE relationship_job_contexts (
  world_id TEXT NOT NULL, conversation_id TEXT NOT NULL, character_id TEXT NOT NULL, job_id TEXT NOT NULL UNIQUE,
  messages_json TEXT NOT NULL, PRIMARY KEY(world_id, conversation_id, character_id, job_id),
  FOREIGN KEY(world_id, conversation_id, job_id) REFERENCES jobs(world_id, conversation_id, id)
) STRICT;
CREATE TABLE relationship_reviews (
  world_id TEXT NOT NULL, conversation_id TEXT NOT NULL, character_id TEXT NOT NULL, job_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL, candidate_json TEXT NOT NULL, outcome TEXT NOT NULL, recorded_at INTEGER NOT NULL,
  PRIMARY KEY(world_id, conversation_id, character_id, job_id, ordinal),
  FOREIGN KEY(world_id, conversation_id, job_id) REFERENCES jobs(world_id, conversation_id, id)
) STRICT;
CREATE TABLE relationship_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
  world_id TEXT NOT NULL, conversation_id TEXT NOT NULL, character_id TEXT NOT NULL, job_id TEXT NOT NULL,
  event_key TEXT NOT NULL, anchor_id TEXT NOT NULL REFERENCES messages(id), input_fingerprint TEXT NOT NULL,
  candidate_json TEXT NOT NULL, response_id TEXT NOT NULL REFERENCES messages(id),
  trust_delta INTEGER NOT NULL, familiarity_delta INTEGER NOT NULL, local_day TEXT NOT NULL,
  policy_version INTEGER NOT NULL, review_version TEXT NOT NULL, recorded_at INTEGER NOT NULL,
  UNIQUE(world_id, conversation_id, character_id, event_key),
  UNIQUE(world_id, conversation_id, character_id, anchor_id),
  UNIQUE(world_id, conversation_id, character_id, input_fingerprint),
  FOREIGN KEY(world_id, conversation_id, job_id) REFERENCES jobs(world_id, conversation_id, id)
) STRICT;
CREATE TABLE relationship_corrections (
  world_id TEXT NOT NULL, conversation_id TEXT NOT NULL, character_id TEXT NOT NULL,
  event_id TEXT NOT NULL UNIQUE REFERENCES relationship_events(id), request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL, reason TEXT NOT NULL, recorded_at INTEGER NOT NULL,
  PRIMARY KEY(world_id, conversation_id, character_id, event_id), UNIQUE(world_id, request_id),
  FOREIGN KEY(world_id, conversation_id, character_id) REFERENCES participants(world_id, conversation_id, character_id)
) STRICT;
ALTER TABLE jobs ADD COLUMN relationship_version INTEGER NOT NULL DEFAULT 0;

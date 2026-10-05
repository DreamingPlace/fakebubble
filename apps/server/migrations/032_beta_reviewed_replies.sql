CREATE TABLE beta_reviewed_replies (
  job_id TEXT PRIMARY KEY, world_id TEXT NOT NULL, conversation_id TEXT NOT NULL, character_id TEXT NOT NULL,
  template_version INTEGER NOT NULL CHECK(template_version > 0), reviewed_at INTEGER NOT NULL,
  candidate_json TEXT NOT NULL CHECK(json_valid(candidate_json)),
  preparation_token TEXT, preparation_until INTEGER,
  CHECK((preparation_token IS NULL AND preparation_until IS NULL) OR
    (preparation_token IS NOT NULL AND preparation_until IS NOT NULL AND preparation_until > reviewed_at)),
  FOREIGN KEY(world_id, conversation_id, job_id) REFERENCES jobs(world_id, conversation_id, id),
  FOREIGN KEY(world_id, conversation_id, character_id) REFERENCES participants(world_id, conversation_id, character_id)
) STRICT;

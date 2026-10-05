-- Reviewed candidates stay private until each individual message is committed.
CREATE TABLE dialogue_deliveries (
  job_id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  character_id TEXT NOT NULL,
  template_version INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  delays_json TEXT NOT NULL,
  next_ordinal INTEGER NOT NULL DEFAULT 0 CHECK(next_ordinal>=0 AND next_ordinal<=6),
  next_due_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued','complete','cancelled')),
  FOREIGN KEY(world_id,conversation_id,character_id) REFERENCES contacts(world_id,conversation_id,character_id),
  FOREIGN KEY(world_id,conversation_id,job_id) REFERENCES jobs(world_id,conversation_id,id)
) STRICT;
CREATE INDEX dialogue_deliveries_due ON dialogue_deliveries(state,next_due_at);

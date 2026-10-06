-- Memory importance, player facts and the review-changed metric. The business object is the only writer.
-- Existing memory rows keep their data: they gain the default importance 3 (small talk).
ALTER TABLE memory_topics ADD COLUMN importance INTEGER NOT NULL DEFAULT 3 CHECK(importance BETWEEN 1 AND 10);

-- Stable facts the player stated about themselves, scoped like every private memory row. A fact is retired,
-- never deleted; superseded_by names the fact that replaced it (no foreign key so purge order does not matter).
CREATE TABLE memory_facts (
  world_id TEXT NOT NULL, conversation_id TEXT NOT NULL, character_id TEXT NOT NULL,
  id TEXT PRIMARY KEY,
  fact_key TEXT NOT NULL CHECK(length(fact_key) BETWEEN 1 AND 64),
  statement TEXT NOT NULL CHECK(length(statement) BETWEEN 1 AND 240),
  importance INTEGER NOT NULL CHECK(importance BETWEEN 1 AND 10),
  evidence_message_ids_json TEXT NOT NULL CHECK(json_valid(evidence_message_ids_json)),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  retired_at INTEGER, superseded_by TEXT,
  CHECK(retired_at IS NOT NULL OR superseded_by IS NULL),
  FOREIGN KEY(world_id,conversation_id,character_id) REFERENCES contacts(world_id,conversation_id,character_id)
) STRICT;
CREATE UNIQUE INDEX memory_facts_active ON memory_facts(world_id,conversation_id,character_id,fact_key)
  WHERE retired_at IS NULL;
CREATE INDEX memory_facts_scope ON memory_facts(world_id,conversation_id,character_id,importance DESC);

-- 1 when the review returned non-empty replacementBubbles (it rewrote the draft), 0 when it accepted it as is.
ALTER TABLE web_operation_metrics ADD COLUMN review_changed INTEGER CHECK(review_changed IN (0,1));

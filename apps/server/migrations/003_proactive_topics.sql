CREATE TABLE proactive_topics (
  world_id TEXT NOT NULL, conversation_id TEXT NOT NULL, character_id TEXT NOT NULL,
  intent_id TEXT NOT NULL PRIMARY KEY REFERENCES proactive_intents(id),
  selected_key TEXT, pool_json TEXT NOT NULL, roll REAL CHECK(roll >= 0 AND roll < 1),
  selected_at INTEGER NOT NULL,
  FOREIGN KEY(world_id, conversation_id, character_id) REFERENCES contacts(world_id, conversation_id, character_id)
) STRICT;

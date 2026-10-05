CREATE TABLE autonomy_days (
  world_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  character_id TEXT NOT NULL,
  local_day TEXT NOT NULL,
  template_version INTEGER NOT NULL,
  schedule_json TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  planned_at INTEGER NOT NULL,
  roll REAL CHECK(roll >= 0 AND roll < 1),
  time_roll REAL CHECK(time_roll >= 0 AND time_roll < 1),
  scheduled_at INTEGER,
  expires_at INTEGER,
  status TEXT NOT NULL CHECK(status IN ('scheduled','skipped','pending','complete','expired')),
  reason TEXT,
  intent_id TEXT UNIQUE REFERENCES proactive_intents(id),
  PRIMARY KEY(world_id,conversation_id,character_id,local_day),
  FOREIGN KEY(world_id,conversation_id,character_id) REFERENCES contacts(world_id,conversation_id,character_id)
) STRICT;
CREATE INDEX autonomy_days_open ON autonomy_days(status,scheduled_at) WHERE status IN ('scheduled','pending');
CREATE INDEX proactive_intents_pending ON proactive_intents(status,created_at) WHERE status='pending';

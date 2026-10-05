CREATE TABLE moment_post_settings (
  world_id TEXT NOT NULL, character_id TEXT NOT NULL, revision INTEGER NOT NULL, policy_json TEXT NOT NULL,
  PRIMARY KEY(world_id,character_id), FOREIGN KEY(world_id,character_id) REFERENCES world_characters(world_id,character_id)
) STRICT;
CREATE TABLE moment_post_setting_requests (
  world_id TEXT NOT NULL, character_id TEXT NOT NULL, request_id TEXT NOT NULL, request_hash TEXT NOT NULL,
  result_json TEXT NOT NULL, PRIMARY KEY(world_id,request_id),
  FOREIGN KEY(world_id,character_id) REFERENCES world_characters(world_id,character_id)
) STRICT;
CREATE TABLE moment_post_days (
  world_id TEXT NOT NULL, character_id TEXT NOT NULL, local_day TEXT NOT NULL,
  template_version INTEGER NOT NULL, schedule_json TEXT NOT NULL, policy_json TEXT NOT NULL,
  planned_at INTEGER NOT NULL, roll REAL, time_roll REAL, scheduled_at INTEGER, expires_at INTEGER,
  status TEXT NOT NULL CHECK(status IN ('scheduled','skipped','pending','complete','expired')), reason TEXT,
  conversation_id TEXT, published_message_id TEXT REFERENCES messages(id),
  PRIMARY KEY(world_id,character_id,local_day),
  FOREIGN KEY(world_id,character_id) REFERENCES world_characters(world_id,character_id),
  FOREIGN KEY(world_id,conversation_id) REFERENCES conversations(world_id,id)
) STRICT;
CREATE TABLE moment_post_drafts (
  world_id TEXT NOT NULL, conversation_id TEXT NOT NULL, character_id TEXT NOT NULL, local_day TEXT NOT NULL,
  PRIMARY KEY(world_id,conversation_id), UNIQUE(world_id,character_id,local_day),
  FOREIGN KEY(world_id,character_id,local_day) REFERENCES moment_post_days(world_id,character_id,local_day),
  FOREIGN KEY(world_id,conversation_id,character_id) REFERENCES participants(world_id,conversation_id,character_id)
) STRICT;
ALTER TABLE jobs ADD COLUMN surface TEXT NOT NULL DEFAULT 'chat' CHECK(surface IN ('chat','moment_post'));
CREATE INDEX moment_post_days_due ON moment_post_days(status,scheduled_at);

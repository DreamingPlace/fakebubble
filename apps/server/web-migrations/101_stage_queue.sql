ALTER TABLE web_operations ADD COLUMN stage_version INTEGER NOT NULL DEFAULT 1 CHECK(stage_version > 0);
ALTER TABLE web_operations ADD COLUMN text_queued_at INTEGER NOT NULL DEFAULT 0 CHECK(text_queued_at >= 0);
ALTER TABLE web_operations ADD COLUMN audio_queued_at INTEGER CHECK(audio_queued_at IS NULL OR audio_queued_at >= 0);
ALTER TABLE web_operations ADD COLUMN lease_epoch INTEGER;
ALTER TABLE web_operations ADD COLUMN lease_token TEXT;
ALTER TABLE web_operations ADD COLUMN lease_owner TEXT;
ALTER TABLE web_operations ADD COLUMN lease_expires_at INTEGER;
UPDATE web_operations SET text_queued_at=created_at;

CREATE TABLE web_scheduler_state (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  epoch INTEGER NOT NULL CHECK(epoch >= 0),
  coordinator_token TEXT,
  coordinator_expires_at INTEGER NOT NULL DEFAULT 0,
  text_last_principal_id TEXT,
  audio_last_principal_id TEXT
) STRICT;
INSERT INTO web_scheduler_state(singleton,epoch) VALUES (1,0);

CREATE TABLE web_reviewed_candidates (
  operation_id TEXT PRIMARY KEY REFERENCES web_operations(id),
  input_message_id TEXT NOT NULL,
  narrative_json TEXT NOT NULL,
  input_version TEXT NOT NULL,
  character_version TEXT NOT NULL,
  template_version TEXT NOT NULL,
  voice_version TEXT NOT NULL,
  access_revision INTEGER NOT NULL CHECK(access_revision > 0),
  text_usage_json TEXT NOT NULL,
  reviewed_at INTEGER NOT NULL
) STRICT;

CREATE TABLE web_stage_attempts (
  operation_id TEXT NOT NULL REFERENCES web_operations(id),
  stage TEXT NOT NULL CHECK(stage IN ('text','audio')),
  attempt INTEGER NOT NULL CHECK(attempt BETWEEN 1 AND 2),
  dispatch_state TEXT NOT NULL CHECK(dispatch_state IN ('not_sent','sent','known','unknown')),
  provider_request_id TEXT NOT NULL,
  provider_receipt TEXT,
  usage_json TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(operation_id,stage,attempt)
) STRICT;

CREATE INDEX web_operations_text_waiting ON web_operations(status,text_queued_at,principal_id,id);
CREATE INDEX web_operations_audio_waiting ON web_operations(status,audio_queued_at,principal_id,id);
CREATE INDEX web_operations_stage_lease ON web_operations(status,lease_expires_at);

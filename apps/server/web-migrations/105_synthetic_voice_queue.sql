ALTER TABLE web_operations ADD COLUMN audio_wait_used_ms INTEGER CHECK(audio_wait_used_ms IS NULL OR audio_wait_used_ms >= 0);
ALTER TABLE web_operations ADD COLUMN audio_wait_started_at INTEGER CHECK(audio_wait_started_at IS NULL OR audio_wait_started_at >= 0);

CREATE TABLE web_synthetic_voice_segments (
  operation_id TEXT NOT NULL REFERENCES web_operations(id),
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0), text_digest TEXT NOT NULL,
  voice_version TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','running','synthetic_complete')),
  claim_stage_version INTEGER, claim_epoch INTEGER, claim_token TEXT,
  completed_at INTEGER,
  PRIMARY KEY(operation_id,ordinal),
  CHECK((state='pending' AND claim_stage_version IS NULL AND completed_at IS NULL) OR
    (state='running' AND claim_stage_version IS NOT NULL AND completed_at IS NULL) OR
    (state='synthetic_complete' AND claim_stage_version IS NOT NULL AND completed_at IS NOT NULL))
) STRICT;

CREATE TABLE web_external_attempts_next (
  operation_id TEXT NOT NULL REFERENCES web_operations(id),
  stage TEXT NOT NULL CHECK(stage IN ('text','audio')),
  phase TEXT NOT NULL CHECK(phase IN ('draft','review','speech')),
  ordinal INTEGER NOT NULL CHECK(ordinal >= -1),
  provider TEXT NOT NULL, provider_request_id TEXT NOT NULL,
  dispatch_state TEXT NOT NULL CHECK(dispatch_state IN ('not_sent','sent','unknown','known')),
  outcome TEXT CHECK(outcome IN ('succeeded','failed','not_dispatched')),
  stage_version INTEGER NOT NULL, lease_epoch INTEGER NOT NULL, lease_token TEXT NOT NULL,
  principal_id TEXT NOT NULL, world_id TEXT NOT NULL, conversation_id TEXT NOT NULL, input_message_id TEXT NOT NULL,
  created_at INTEGER NOT NULL, sent_at INTEGER, settled_at INTEGER, receipt_json TEXT, usage_json TEXT,
  PRIMARY KEY(operation_id,stage,phase,ordinal),
  UNIQUE(provider,provider_request_id),
  FOREIGN KEY(provider,stage,phase) REFERENCES web_external_budgets(provider,stage,phase),
  CHECK((stage='text' AND phase IN ('draft','review') AND ordinal=-1) OR
    (stage='audio' AND phase='speech' AND ordinal>=0)),
  CHECK((dispatch_state='not_sent' AND sent_at IS NULL AND outcome IS NULL) OR
    (dispatch_state IN ('sent','unknown') AND sent_at IS NOT NULL AND outcome IS NULL) OR
    (dispatch_state='known' AND outcome IS NOT NULL))
) STRICT;
INSERT INTO web_external_attempts_next SELECT * FROM web_external_attempts;

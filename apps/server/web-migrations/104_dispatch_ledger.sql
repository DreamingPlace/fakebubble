CREATE TABLE web_external_budgets (
  provider TEXT NOT NULL, stage TEXT NOT NULL CHECK(stage IN ('text','audio')),
  phase TEXT NOT NULL CHECK(phase IN ('draft','review','speech')),
  capacity INTEGER NOT NULL CHECK(capacity > 0), reserved INTEGER NOT NULL DEFAULT 0 CHECK(reserved >= 0),
  PRIMARY KEY(provider,stage,phase), CHECK(reserved <= capacity),
  CHECK((stage='text' AND phase IN ('draft','review')) OR (stage='audio' AND phase='speech'))
) STRICT;

CREATE TABLE web_external_attempts (
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
    (stage='audio' AND phase='speech' AND ordinal=0)),
  CHECK((dispatch_state='not_sent' AND sent_at IS NULL AND outcome IS NULL) OR
    (dispatch_state IN ('sent','unknown') AND sent_at IS NOT NULL AND outcome IS NULL) OR
    (dispatch_state='known' AND outcome IS NOT NULL))
) STRICT;
CREATE INDEX web_external_attempts_state ON web_external_attempts(dispatch_state,operation_id);

-- Web-local transport events and durable synthetic text outputs. Existing 108 publication
-- records remain the authority; old transitions are not fabricated during migration.
ALTER TABLE web_operations ADD COLUMN failure_code TEXT;
CREATE TABLE web_local_text_outputs (
  operation_id TEXT NOT NULL REFERENCES web_operations(id),
  phase TEXT NOT NULL CHECK(phase IN ('draft','review')),
  request_digest TEXT NOT NULL,
  output_json TEXT NOT NULL CHECK(json_valid(output_json)),
  output_digest TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(operation_id,phase)
) STRICT;

CREATE TABLE web_local_audio_outputs (
  operation_id TEXT NOT NULL REFERENCES web_operations(id),
  ordinal INTEGER NOT NULL CHECK(ordinal>=0),
  byte_length INTEGER NOT NULL CHECK(byte_length>0 AND byte_length<=6000000),
  sha256 TEXT NOT NULL,
  bytes BLOB NOT NULL,
  PRIMARY KEY(operation_id,ordinal),
  CHECK(length(bytes)=byte_length)
) STRICT;

CREATE TABLE web_local_guest_budget (
  ip_hash TEXT NOT NULL, window_start INTEGER NOT NULL,
  created INTEGER NOT NULL CHECK(created>=0 AND created<=32),
  PRIMARY KEY(ip_hash,window_start)
) STRICT;

CREATE TABLE web_local_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  principal_id TEXT NOT NULL REFERENCES web_principals(id),
  world_id TEXT NOT NULL,
  conversation_id TEXT,
  operation_id TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('operation','publication','access')),
  revision INTEGER NOT NULL CHECK(revision > 0),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json))
) STRICT;
CREATE INDEX web_local_events_principal_seq ON web_local_events(principal_id,seq);
CREATE UNIQUE INDEX web_local_event_revision ON web_local_events(operation_id,revision)
  WHERE kind='operation';
CREATE TRIGGER web_local_text_outputs_no_update BEFORE UPDATE ON web_local_text_outputs
BEGIN SELECT RAISE(ABORT,'WEB_TEXT_OUTPUT_IMMUTABLE'); END;
CREATE TRIGGER web_local_text_outputs_no_delete BEFORE DELETE ON web_local_text_outputs
BEGIN SELECT RAISE(ABORT,'WEB_TEXT_OUTPUT_IMMUTABLE'); END;
CREATE TRIGGER web_local_audio_outputs_no_update BEFORE UPDATE ON web_local_audio_outputs
BEGIN SELECT RAISE(ABORT,'WEB_AUDIO_OUTPUT_IMMUTABLE'); END;
CREATE TRIGGER web_local_audio_outputs_no_delete BEFORE DELETE ON web_local_audio_outputs
BEGIN SELECT RAISE(ABORT,'WEB_AUDIO_OUTPUT_IMMUTABLE'); END;

CREATE TRIGGER web_local_operation_insert AFTER INSERT ON web_operations
BEGIN
  INSERT INTO web_local_events(principal_id,world_id,conversation_id,operation_id,kind,revision,payload_json)
  VALUES (NEW.principal_id,NEW.world_id,NEW.conversation_id,NEW.id,'operation',NEW.stage_version+1,
    json_object('operationId',NEW.id,'requestId',NEW.request_id,'conversationId',NEW.conversation_id,
      'characterId',NEW.character_id,'status',NEW.status,'revision',NEW.stage_version+1,
      'acceptedAt',NEW.created_at,'deadlineAt',NEW.deadline_at,'quotaState',NEW.quota_state,
      'failureCode',NEW.failure_code));
END;
CREATE TRIGGER web_local_operation_update AFTER UPDATE ON web_operations
WHEN NEW.stage_version<>OLD.stage_version OR NEW.status<>OLD.status OR NEW.quota_state<>OLD.quota_state
BEGIN
  INSERT INTO web_local_events(principal_id,world_id,conversation_id,operation_id,kind,revision,payload_json)
  VALUES (NEW.principal_id,NEW.world_id,NEW.conversation_id,NEW.id,'operation',NEW.stage_version+1,
    json_object('operationId',NEW.id,'requestId',NEW.request_id,'conversationId',NEW.conversation_id,
      'characterId',NEW.character_id,'status',NEW.status,'revision',NEW.stage_version+1,
      'acceptedAt',NEW.created_at,'deadlineAt',NEW.deadline_at,'quotaState',NEW.quota_state,
      'failureCode',NEW.failure_code));
END;
CREATE TRIGGER web_local_publication_event AFTER INSERT ON web_user_events
BEGIN
  INSERT INTO web_local_events(principal_id,world_id,conversation_id,operation_id,kind,revision,payload_json)
  VALUES (NEW.principal_id,NEW.world_id,NEW.conversation_id,NEW.operation_id,'publication',1,
    NEW.receipt_json);
END;
CREATE TRIGGER web_local_access_update AFTER UPDATE OF kind,revision,trial_used,trial_reserved ON web_principals
WHEN NEW.revision<>OLD.revision OR NEW.kind<>OLD.kind OR NEW.trial_used<>OLD.trial_used OR NEW.trial_reserved<>OLD.trial_reserved
BEGIN
  INSERT INTO web_local_events(principal_id,world_id,conversation_id,operation_id,kind,revision,payload_json)
  VALUES (NEW.id,NEW.world_id,NULL,NULL,'access',NEW.revision,
    json_object('principalId',NEW.id,'kind',NEW.kind,'revision',NEW.revision,
      'trialUsed',NEW.trial_used,'trialReserved',NEW.trial_reserved,'trialCharacterId',NEW.trial_character_id));
END;

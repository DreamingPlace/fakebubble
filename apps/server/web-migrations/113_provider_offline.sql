-- Offline-only 113. Legacy 107/108 synthetic provenance CHECK constraints remain untouched.
-- The 113-only capacity ticket accepts multiple speech ordinals; copy old rows unchanged.
CREATE TABLE web_external_attempts_113 (
  operation_id TEXT NOT NULL REFERENCES web_operations(id),
  stage TEXT NOT NULL CHECK(stage IN ('text','audio')),
  phase TEXT NOT NULL CHECK(phase IN ('draft','review','speech')),
  ordinal INTEGER NOT NULL CHECK(ordinal >= -1),
  provider TEXT NOT NULL, provider_request_id TEXT NOT NULL,
  dispatch_state TEXT NOT NULL CHECK(dispatch_state IN ('not_sent','sent','unknown','known')),
  outcome TEXT CHECK(outcome IN ('succeeded','failed','not_dispatched')),
  stage_version INTEGER NOT NULL, lease_epoch INTEGER NOT NULL, lease_token TEXT NOT NULL,
  principal_id TEXT NOT NULL, world_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
  input_message_id TEXT NOT NULL, created_at INTEGER NOT NULL, sent_at INTEGER,
  settled_at INTEGER, receipt_json TEXT, usage_json TEXT,
  receipt_digest TEXT, usage_digest TEXT,
  PRIMARY KEY(operation_id,stage,phase,ordinal),
  UNIQUE(provider,provider_request_id),
  FOREIGN KEY(provider,stage,phase) REFERENCES web_external_budgets(provider,stage,phase),
  CHECK((stage='text' AND phase IN ('draft','review') AND ordinal=-1) OR
    (stage='audio' AND phase='speech' AND ordinal>=0)),
  CHECK((dispatch_state='not_sent' AND sent_at IS NULL AND outcome IS NULL) OR
    (dispatch_state IN ('sent','unknown') AND sent_at IS NOT NULL AND outcome IS NULL) OR
    (dispatch_state='known' AND outcome IS NOT NULL))
) STRICT;
INSERT INTO web_external_attempts_113 SELECT * FROM web_external_attempts;
DROP TABLE web_external_attempts;
ALTER TABLE web_external_attempts_113 RENAME TO web_external_attempts;
CREATE INDEX web_external_attempts_state ON web_external_attempts(dispatch_state,operation_id);

CREATE TABLE web_provider_spending (
  provider TEXT PRIMARY KEY,
  currency TEXT NOT NULL CHECK(currency='USD'),
  limit_micros INTEGER NOT NULL CHECK(limit_micros>0 AND limit_micros<=3000000),
  held_micros INTEGER NOT NULL DEFAULT 0 CHECK(held_micros>=0),
  spent_micros INTEGER NOT NULL DEFAULT 0 CHECK(spent_micros>=0),
  CHECK(held_micros+spent_micros<=limit_micros)
) STRICT;

CREATE TABLE web_provider_prices (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL REFERENCES web_provider_spending(provider),
  model TEXT NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('draft','review','speech')),
  currency TEXT NOT NULL CHECK(currency='USD'),
  unit TEXT NOT NULL CHECK(unit IN ('token','byte','call')),
  upper_micros_per_unit INTEGER NOT NULL CHECK(upper_micros_per_unit>0),
  valid_from INTEGER NOT NULL,
  valid_until INTEGER NOT NULL CHECK(valid_until>valid_from),
  version INTEGER NOT NULL CHECK(version>0),
  UNIQUE(provider,model,phase,version)
) STRICT;
CREATE TRIGGER web_provider_prices_no_update BEFORE UPDATE ON web_provider_prices
BEGIN SELECT RAISE(ABORT,'WEB_PROVIDER_PRICE_IMMUTABLE'); END;
CREATE TRIGGER web_provider_prices_no_delete BEFORE DELETE ON web_provider_prices
BEGIN SELECT RAISE(ABORT,'WEB_PROVIDER_PRICE_IMMUTABLE'); END;

CREATE TABLE web_provider_attempts (
  operation_id TEXT NOT NULL REFERENCES web_operations(id),
  phase TEXT NOT NULL CHECK(phase IN ('draft','review','speech')),
  ordinal INTEGER NOT NULL,
  principal_id TEXT NOT NULL, player_id TEXT NOT NULL,
  world_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
  character_id TEXT NOT NULL, input_message_id TEXT NOT NULL,
  request_digest TEXT NOT NULL, policy_hash TEXT NOT NULL,
  wire_request_hash TEXT NOT NULL, voice_version TEXT NOT NULL,
  provider TEXT NOT NULL REFERENCES web_provider_spending(provider),
  model TEXT NOT NULL, price_id TEXT NOT NULL REFERENCES web_provider_prices(id),
  max_units INTEGER NOT NULL CHECK(max_units>0),
  held_micros INTEGER NOT NULL CHECK(held_micros>0),
  stage_version INTEGER, lease_epoch INTEGER, lease_token TEXT,
  state TEXT NOT NULL CHECK(state IN ('not_sent','sent','unknown','known')),
  sent_at INTEGER, settled_at INTEGER,
  outcome TEXT CHECK(outcome IN ('succeeded','failed','not_dispatched')),
  usage_units INTEGER,
  charged_micros INTEGER,
  receipt_json TEXT, metadata_json TEXT,
  output_digest TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(operation_id,phase,ordinal),
  CHECK((phase IN ('draft','review') AND ordinal=-1) OR (phase='speech' AND ordinal>=0)),
  CHECK((stage_version IS NULL AND lease_epoch IS NULL AND lease_token IS NULL) OR
        (stage_version IS NOT NULL AND lease_epoch IS NOT NULL AND lease_token IS NOT NULL)),
  CHECK((state='not_sent' AND sent_at IS NULL AND settled_at IS NULL AND outcome IS NULL) OR
        (state IN ('sent','unknown') AND sent_at IS NOT NULL AND settled_at IS NULL AND outcome IS NULL) OR
        (state='known' AND settled_at IS NOT NULL AND outcome IS NOT NULL AND
         usage_units IS NOT NULL AND charged_micros IS NOT NULL))
) STRICT;

CREATE TABLE web_provider_outputs (
  operation_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  payload_json TEXT CHECK(payload_json IS NULL OR json_valid(payload_json)),
  audio_bytes BLOB,
  spoken_text TEXT,
  sha256 TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  policy_hash TEXT NOT NULL,
  wire_request_hash TEXT NOT NULL,
  voice_version TEXT NOT NULL,
  PRIMARY KEY(operation_id,phase,ordinal),
  FOREIGN KEY(operation_id,phase,ordinal) REFERENCES web_provider_attempts(operation_id,phase,ordinal),
  CHECK((phase IN ('draft','review') AND payload_json IS NOT NULL AND audio_bytes IS NULL AND spoken_text IS NULL) OR
        (phase='speech' AND payload_json IS NULL AND audio_bytes IS NOT NULL AND spoken_text IS NOT NULL AND length(spoken_text)>0))
) STRICT;
CREATE TRIGGER web_provider_outputs_no_update BEFORE UPDATE ON web_provider_outputs
BEGIN SELECT RAISE(ABORT,'WEB_PROVIDER_OUTPUT_IMMUTABLE'); END;
CREATE TRIGGER web_provider_outputs_no_delete BEFORE DELETE ON web_provider_outputs
BEGIN SELECT RAISE(ABORT,'WEB_PROVIDER_OUTPUT_IMMUTABLE'); END;

CREATE TABLE web_provider_candidates (
  operation_id TEXT PRIMARY KEY REFERENCES web_v7_requests(operation_id),
  request_digest TEXT NOT NULL, candidate_json TEXT NOT NULL CHECK(json_valid(candidate_json)),
  candidate_digest TEXT NOT NULL, voice_version TEXT NOT NULL,
  draft_output_digest TEXT NOT NULL, review_output_digest TEXT NOT NULL,
  reviewed_at INTEGER NOT NULL
) STRICT;
CREATE TRIGGER web_provider_candidates_no_update BEFORE UPDATE ON web_provider_candidates
BEGIN SELECT RAISE(ABORT,'WEB_PROVIDER_CANDIDATE_IMMUTABLE'); END;
CREATE TRIGGER web_provider_candidates_no_delete BEFORE DELETE ON web_provider_candidates
BEGIN SELECT RAISE(ABORT,'WEB_PROVIDER_CANDIDATE_IMMUTABLE'); END;

CREATE TABLE web_provider_voice_segments (
  operation_id TEXT NOT NULL REFERENCES web_provider_candidates(operation_id),
  ordinal INTEGER NOT NULL CHECK(ordinal>=0), text_digest TEXT NOT NULL,
  voice_version TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','running','complete')),
  claim_stage_version INTEGER, claim_epoch INTEGER, claim_token TEXT,
  completed_at INTEGER,
  PRIMARY KEY(operation_id,ordinal),
  CHECK((state='pending' AND claim_stage_version IS NULL AND completed_at IS NULL) OR
        (state='running' AND claim_stage_version IS NOT NULL AND completed_at IS NULL) OR
        (state='complete' AND claim_stage_version IS NOT NULL AND completed_at IS NOT NULL))
) STRICT;

-- In-memory-only 113 keeps verified bytes in this sidecar; no public media endpoint is enabled.
CREATE TABLE web_provider_media_assets (
  operation_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  media_id TEXT NOT NULL UNIQUE,
  origin TEXT NOT NULL CHECK(origin='provider'),
  principal_id TEXT NOT NULL, player_id TEXT NOT NULL, world_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL, character_id TEXT NOT NULL, input_message_id TEXT NOT NULL,
  text_digest TEXT NOT NULL, voice_version TEXT NOT NULL,
  sha256 TEXT NOT NULL, byte_length INTEGER NOT NULL CHECK(byte_length>0),
  duration_ms INTEGER NOT NULL CHECK(duration_ms>0), audio_bytes BLOB NOT NULL,
  verified_at INTEGER NOT NULL,
  PRIMARY KEY(operation_id,ordinal),
  FOREIGN KEY(operation_id,ordinal) REFERENCES web_provider_voice_segments(operation_id,ordinal),
  CHECK(length(audio_bytes)=byte_length)
) STRICT;
CREATE TRIGGER web_provider_media_no_update BEFORE UPDATE ON web_provider_media_assets
BEGIN SELECT RAISE(ABORT,'WEB_PROVIDER_MEDIA_IMMUTABLE'); END;
CREATE TRIGGER web_provider_media_no_delete BEFORE DELETE ON web_provider_media_assets
BEGIN SELECT RAISE(ABORT,'WEB_PROVIDER_MEDIA_IMMUTABLE'); END;

CREATE TABLE web_provider_footer_assets (
  character_id TEXT NOT NULL REFERENCES character_templates(id), voice_version TEXT NOT NULL,
  media_id TEXT NOT NULL UNIQUE, origin TEXT NOT NULL CHECK(origin='operator_approved'),
  body TEXT NOT NULL, sha256 TEXT NOT NULL, byte_length INTEGER NOT NULL CHECK(byte_length>0),
  duration_ms INTEGER NOT NULL CHECK(duration_ms>0), audio_bytes BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(character_id,voice_version),
  CHECK(length(audio_bytes)=byte_length)
) STRICT;
CREATE TRIGGER web_provider_footer_no_update BEFORE UPDATE ON web_provider_footer_assets
BEGIN SELECT RAISE(ABORT,'WEB_PROVIDER_FOOTER_IMMUTABLE'); END;
CREATE TRIGGER web_provider_footer_no_delete BEFORE DELETE ON web_provider_footer_assets
BEGIN SELECT RAISE(ABORT,'WEB_PROVIDER_FOOTER_IMMUTABLE'); END;

CREATE TABLE web_provider_voice_bindings (
  character_id TEXT PRIMARY KEY REFERENCES character_templates(id),
  voice_version TEXT NOT NULL, voice_revision INTEGER NOT NULL CHECK(voice_revision>0),
  profile_id TEXT NOT NULL, reference_id TEXT NOT NULL,
  model TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('synthetic_fixture','user_selected')),
  approved INTEGER NOT NULL CHECK(approved=1),
  -- user_selected carries digests of the user's selection record; never raw private material.
  evidence_json TEXT,
  CHECK((source='synthetic_fixture' AND evidence_json IS NULL) OR
        (source='user_selected' AND evidence_json IS NOT NULL AND json_valid(evidence_json)))
) STRICT;
CREATE TRIGGER web_provider_voice_bindings_no_update BEFORE UPDATE ON web_provider_voice_bindings
BEGIN SELECT RAISE(ABORT,'WEB_PROVIDER_VOICE_IMMUTABLE'); END;
CREATE TRIGGER web_provider_voice_bindings_no_delete BEFORE DELETE ON web_provider_voice_bindings
BEGIN SELECT RAISE(ABORT,'WEB_PROVIDER_VOICE_IMMUTABLE'); END;

-- Browse-card welcome audio: one immutable clip per character voice version, spoken in the
-- selected voice. Public playback never exposes private profile/reference identifiers.
CREATE TABLE web_provider_welcome_assets (
  character_id TEXT NOT NULL REFERENCES web_provider_voice_bindings(character_id),
  voice_version TEXT NOT NULL, text_version TEXT NOT NULL, body TEXT NOT NULL CHECK(length(body)>0),
  media_id TEXT NOT NULL UNIQUE, origin TEXT NOT NULL CHECK(origin='operator_approved'),
  sha256 TEXT NOT NULL, byte_length INTEGER NOT NULL CHECK(byte_length>0),
  duration_ms INTEGER NOT NULL CHECK(duration_ms>0), audio_bytes BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(character_id,voice_version),
  CHECK(length(audio_bytes)=byte_length)
) STRICT;
CREATE TRIGGER web_provider_welcome_no_update BEFORE UPDATE ON web_provider_welcome_assets
BEGIN SELECT RAISE(ABORT,'WEB_PROVIDER_WELCOME_IMMUTABLE'); END;
CREATE TRIGGER web_provider_welcome_no_delete BEFORE DELETE ON web_provider_welcome_assets
BEGIN SELECT RAISE(ABORT,'WEB_PROVIDER_WELCOME_IMMUTABLE'); END;

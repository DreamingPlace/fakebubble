ALTER TABLE web_operations ALTER COLUMN ip_window_id DROP NOT NULL;
ALTER TABLE web_operations ADD COLUMN metering_type TEXT NOT NULL DEFAULT 'trial'
  CHECK((metering_type='trial' AND ip_window_id IS NOT NULL) OR
        (metering_type='entitled' AND ip_window_id IS NULL));

CREATE TABLE web_v7_requests (
  operation_id TEXT PRIMARY KEY REFERENCES web_operations(id),
  principal_id TEXT NOT NULL, player_id TEXT NOT NULL, world_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL, character_id TEXT NOT NULL, input_message_id TEXT NOT NULL,
  request_json TEXT NOT NULL, request_digest TEXT NOT NULL,
  protocol_digest TEXT NOT NULL, prompt_digest TEXT NOT NULL, memory_version INTEGER NOT NULL,
  player_context_key TEXT NOT NULL, relationship_version INTEGER NOT NULL,
  scene_revision INTEGER NOT NULL, voice_version TEXT NOT NULL,
  frozen_at INTEGER NOT NULL
) STRICT;
CREATE TRIGGER web_v7_requests_no_update BEFORE UPDATE ON web_v7_requests
BEGIN SELECT RAISE(ABORT,'WEB_V7_REQUEST_IMMUTABLE'); END;
CREATE TRIGGER web_v7_requests_no_delete BEFORE DELETE ON web_v7_requests
BEGIN SELECT RAISE(ABORT,'WEB_V7_REQUEST_IMMUTABLE'); END;

CREATE TABLE web_v7_candidates (
  operation_id TEXT PRIMARY KEY REFERENCES web_v7_requests(operation_id),
  request_digest TEXT NOT NULL, candidate_json TEXT NOT NULL, candidate_digest TEXT NOT NULL,
  draft_receipt_json TEXT NOT NULL, review_receipt_json TEXT NOT NULL,
  origin TEXT NOT NULL CHECK(origin='synthetic_test'), reviewed_at INTEGER NOT NULL
) STRICT;
CREATE TRIGGER web_v7_candidates_no_update BEFORE UPDATE ON web_v7_candidates
BEGIN SELECT RAISE(ABORT,'WEB_V7_CANDIDATE_IMMUTABLE'); END;
CREATE TRIGGER web_v7_candidates_no_delete BEFORE DELETE ON web_v7_candidates
BEGIN SELECT RAISE(ABORT,'WEB_V7_CANDIDATE_IMMUTABLE'); END;

CREATE TABLE web_publications (
  operation_id TEXT PRIMARY KEY REFERENCES web_operations(id),
  principal_id TEXT NOT NULL, player_id TEXT NOT NULL, world_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL, character_id TEXT NOT NULL, input_message_id TEXT NOT NULL,
  job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id), request_digest TEXT NOT NULL,
  candidate_digest TEXT NOT NULL, published_at INTEGER NOT NULL,
  receipt_json TEXT NOT NULL
) STRICT;
CREATE INDEX web_publications_scope ON web_publications(principal_id,world_id,conversation_id,character_id,published_at);
CREATE TRIGGER web_publications_no_update BEFORE UPDATE ON web_publications
BEGIN SELECT RAISE(ABORT,'WEB_PUBLICATION_IMMUTABLE'); END;
CREATE TRIGGER web_publications_no_delete BEFORE DELETE ON web_publications
BEGIN SELECT RAISE(ABORT,'WEB_PUBLICATION_IMMUTABLE'); END;
CREATE TABLE web_publication_items (
  operation_id TEXT NOT NULL REFERENCES web_publications(operation_id),
  ordinal INTEGER NOT NULL CHECK(ordinal>=0), message_id TEXT NOT NULL UNIQUE REFERENCES messages(id),
  media_id TEXT NOT NULL, origin TEXT NOT NULL CHECK(origin IN ('narrative','trial_footer')),
  PRIMARY KEY(operation_id,ordinal)
) STRICT;
CREATE TRIGGER web_publication_items_no_update BEFORE UPDATE ON web_publication_items
BEGIN SELECT RAISE(ABORT,'WEB_PUBLICATION_ITEM_IMMUTABLE'); END;
CREATE TRIGGER web_publication_items_no_delete BEFORE DELETE ON web_publication_items
BEGIN SELECT RAISE(ABORT,'WEB_PUBLICATION_ITEM_IMMUTABLE'); END;
CREATE TABLE web_footer_assets (
  character_id TEXT PRIMARY KEY REFERENCES character_templates(id),
  media_id TEXT NOT NULL UNIQUE, origin TEXT NOT NULL CHECK(origin='synthetic_test'),
  body TEXT NOT NULL CHECK(body='有空一定要来找我呀～'),
  format TEXT NOT NULL CHECK(format='wav_pcm16'), byte_length INTEGER NOT NULL,
  sha256 TEXT NOT NULL, duration_ms INTEGER NOT NULL, created_at INTEGER NOT NULL
) STRICT;
CREATE TRIGGER web_footer_assets_no_update BEFORE UPDATE ON web_footer_assets
BEGIN SELECT RAISE(ABORT,'WEB_FOOTER_IMMUTABLE'); END;
CREATE TRIGGER web_footer_assets_no_delete BEFORE DELETE ON web_footer_assets
BEGIN SELECT RAISE(ABORT,'WEB_FOOTER_IMMUTABLE'); END;
CREATE TABLE web_user_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, principal_id TEXT NOT NULL,
  world_id TEXT NOT NULL, conversation_id TEXT NOT NULL, operation_id TEXT NOT NULL REFERENCES web_operations(id),
  kind TEXT NOT NULL CHECK(kind='publication'), receipt_json TEXT NOT NULL, created_at INTEGER NOT NULL,
  UNIQUE(operation_id,kind)
) STRICT;

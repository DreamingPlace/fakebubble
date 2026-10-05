-- Scoped synthetic-local test candidate. Only an explicit migration in B's
-- registered local test root may execute this; ordinary reopen remains denied.
ALTER TABLE web_operations ALTER COLUMN input_message_id DROP NOT NULL;
ALTER TABLE web_external_attempts ADD COLUMN receipt_digest TEXT;
ALTER TABLE web_external_attempts ADD COLUMN usage_digest TEXT;

CREATE TABLE web_ip_lifetime_quota (
  ip_hash TEXT PRIMARY KEY, key_fingerprint TEXT NOT NULL,
  used_total INTEGER NOT NULL CHECK(used_total>=0),
  reserved_total INTEGER NOT NULL CHECK(reserved_total>=0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0)
) STRICT;

CREATE TABLE web_guest_retention (
  principal_id TEXT PRIMARY KEY REFERENCES web_principals(id),
  world_id TEXT NOT NULL REFERENCES worlds(id),
  started_at INTEGER, expires_at INTEGER,
  state TEXT NOT NULL CHECK(state IN ('unstarted','active','protected','purging','purged')),
  db_cleared_at INTEGER,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
  CHECK((started_at IS NULL AND expires_at IS NULL AND state IN ('unstarted','protected')) OR
        (started_at IS NOT NULL AND expires_at>started_at AND state IN ('active','protected','purging','purged')))
) STRICT;

-- This gate must be inserted and deleted inside the same scoped cleanup transaction.
-- It is never an HTTP capability; no gate row is allowed to survive a completed T2.
CREATE TABLE web_retention_purge_gate (
  principal_id TEXT PRIMARY KEY REFERENCES web_principals(id),
  world_id TEXT NOT NULL REFERENCES worlds(id),
  retention_revision INTEGER NOT NULL CHECK(retention_revision>0)
) STRICT;

CREATE TABLE web_retention_file_cleanup (
  media_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL REFERENCES web_principals(id),
  world_id TEXT NOT NULL REFERENCES worlds(id),
  byte_length INTEGER NOT NULL CHECK(byte_length>0), sha256 TEXT NOT NULL,
  duration_ms INTEGER NOT NULL CHECK(duration_ms>0),
  state TEXT NOT NULL CHECK(state IN ('pending','deleted')),
  queued_at INTEGER NOT NULL, deleted_at INTEGER,
  CHECK((state='pending' AND deleted_at IS NULL) OR
        (state='deleted' AND deleted_at IS NOT NULL))
) STRICT;

DROP TRIGGER web_input_snapshots_no_delete;
CREATE TRIGGER web_input_snapshots_no_delete BEFORE DELETE ON web_input_snapshots
WHEN NOT EXISTS (SELECT 1 FROM web_operations o JOIN web_retention_purge_gate g
  ON g.principal_id=o.principal_id AND g.world_id=o.world_id
  JOIN web_guest_retention r ON r.principal_id=g.principal_id AND r.world_id=g.world_id
  WHERE o.id=OLD.operation_id AND r.state='purging' AND r.revision=g.retention_revision)
BEGIN SELECT RAISE(ABORT,'WEB_INPUT_SNAPSHOT_IMMUTABLE'); END;

DROP TRIGGER web_v7_requests_no_delete;
CREATE TRIGGER web_v7_requests_no_delete BEFORE DELETE ON web_v7_requests
WHEN NOT EXISTS (SELECT 1 FROM web_operations o JOIN web_retention_purge_gate g
  ON g.principal_id=o.principal_id AND g.world_id=o.world_id
  JOIN web_guest_retention r ON r.principal_id=g.principal_id AND r.world_id=g.world_id
  WHERE o.id=OLD.operation_id AND r.state='purging' AND r.revision=g.retention_revision)
BEGIN SELECT RAISE(ABORT,'WEB_V7_REQUEST_IMMUTABLE'); END;

DROP TRIGGER web_v7_candidates_no_delete;
CREATE TRIGGER web_v7_candidates_no_delete BEFORE DELETE ON web_v7_candidates
WHEN NOT EXISTS (SELECT 1 FROM web_operations o JOIN web_retention_purge_gate g
  ON g.principal_id=o.principal_id AND g.world_id=o.world_id
  JOIN web_guest_retention r ON r.principal_id=g.principal_id AND r.world_id=g.world_id
  WHERE o.id=OLD.operation_id AND r.state='purging' AND r.revision=g.retention_revision)
BEGIN SELECT RAISE(ABORT,'WEB_V7_CANDIDATE_IMMUTABLE'); END;

DROP TRIGGER web_publications_no_delete;
CREATE TRIGGER web_publications_no_delete BEFORE DELETE ON web_publications
WHEN NOT EXISTS (SELECT 1 FROM web_operations o JOIN web_retention_purge_gate g
  ON g.principal_id=o.principal_id AND g.world_id=o.world_id
  JOIN web_guest_retention r ON r.principal_id=g.principal_id AND r.world_id=g.world_id
  WHERE o.id=OLD.operation_id AND r.state='purging' AND r.revision=g.retention_revision)
BEGIN SELECT RAISE(ABORT,'WEB_PUBLICATION_IMMUTABLE'); END;

DROP TRIGGER web_publication_items_no_delete;
CREATE TRIGGER web_publication_items_no_delete BEFORE DELETE ON web_publication_items
WHEN NOT EXISTS (SELECT 1 FROM web_operations o JOIN web_retention_purge_gate g
  ON g.principal_id=o.principal_id AND g.world_id=o.world_id
  JOIN web_guest_retention r ON r.principal_id=g.principal_id AND r.world_id=g.world_id
  WHERE o.id=OLD.operation_id AND r.state='purging' AND r.revision=g.retention_revision)
BEGIN SELECT RAISE(ABORT,'WEB_PUBLICATION_ITEM_IMMUTABLE'); END;

DROP TRIGGER web_local_text_outputs_no_delete;
CREATE TRIGGER web_local_text_outputs_no_delete BEFORE DELETE ON web_local_text_outputs
WHEN NOT EXISTS (SELECT 1 FROM web_operations o JOIN web_retention_purge_gate g
  ON g.principal_id=o.principal_id AND g.world_id=o.world_id
  JOIN web_guest_retention r ON r.principal_id=g.principal_id AND r.world_id=g.world_id
  WHERE o.id=OLD.operation_id AND r.state='purging' AND r.revision=g.retention_revision)
BEGIN SELECT RAISE(ABORT,'WEB_TEXT_OUTPUT_IMMUTABLE'); END;

DROP TRIGGER web_local_audio_outputs_no_delete;
CREATE TRIGGER web_local_audio_outputs_no_delete BEFORE DELETE ON web_local_audio_outputs
WHEN NOT EXISTS (SELECT 1 FROM web_operations o JOIN web_retention_purge_gate g
  ON g.principal_id=o.principal_id AND g.world_id=o.world_id
  JOIN web_guest_retention r ON r.principal_id=g.principal_id AND r.world_id=g.world_id
  WHERE o.id=OLD.operation_id AND r.state='purging' AND r.revision=g.retention_revision)
BEGIN SELECT RAISE(ABORT,'WEB_AUDIO_OUTPUT_IMMUTABLE'); END;

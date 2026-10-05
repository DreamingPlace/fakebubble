CREATE TABLE character_template_versions (
  character_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  config_json TEXT NOT NULL,
  created_at INTEGER,
  PRIMARY KEY(character_id,version)
) STRICT;
-- Import the current version without inventing a historical publication date.
INSERT INTO character_template_versions SELECT id,version,config_json,NULL FROM character_templates;
CREATE TABLE admin_sessions (
  id TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
) STRICT;
CREATE TABLE admin_login_grants (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  consumed_session_id TEXT REFERENCES admin_sessions(id)
) STRICT;
CREATE TABLE character_draft_revisions (
  character_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  base_version INTEGER,
  template_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  session_id TEXT NOT NULL REFERENCES admin_sessions(id),
  PRIMARY KEY(character_id,revision)
) STRICT;
CREATE TABLE character_drafts (
  character_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  FOREIGN KEY(character_id,revision) REFERENCES character_draft_revisions(character_id,revision)
) STRICT;
CREATE TABLE admin_previews (
  id TEXT PRIMARY KEY,
  character_id TEXT NOT NULL,
  draft_revision INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  prompt_hash TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','generating','succeeded','failed')),
  evidence_kind TEXT NOT NULL CHECK(evidence_kind IN ('deepseek','fixture')),
  request_json TEXT NOT NULL,
  lease_until INTEGER,
  created_at INTEGER NOT NULL,
  finished_at INTEGER,
  result_json TEXT,
  error_code TEXT,
  FOREIGN KEY(character_id,draft_revision) REFERENCES character_draft_revisions(character_id,revision)
) STRICT;
CREATE INDEX admin_previews_queue ON admin_previews(status,created_at);
CREATE INDEX admin_previews_character ON admin_previews(character_id,created_at DESC);
CREATE TABLE character_publications (
  request_id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  character_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  draft_revision INTEGER NOT NULL,
  preview_id TEXT NOT NULL REFERENCES admin_previews(id),
  session_id TEXT NOT NULL REFERENCES admin_sessions(id),
  created_at INTEGER NOT NULL,
  UNIQUE(character_id,version),
  FOREIGN KEY(character_id,version) REFERENCES character_template_versions(character_id,version),
  FOREIGN KEY(character_id,draft_revision) REFERENCES character_draft_revisions(character_id,revision)
) STRICT;

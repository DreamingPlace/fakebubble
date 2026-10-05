CREATE TABLE external_sources (
  id TEXT PRIMARY KEY, revision INTEGER NOT NULL, config_json TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), next_poll_at INTEGER NOT NULL,
  last_poll_at INTEGER, last_success_at INTEGER, error_code TEXT,
  paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN (0,1)), coverage_warning INTEGER NOT NULL DEFAULT 0 CHECK(coverage_warning IN (0,1))
) STRICT;
CREATE TABLE external_source_versions (
  source_id TEXT NOT NULL REFERENCES external_sources(id), revision INTEGER NOT NULL,
  config_json TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(source_id,revision)
) STRICT;
CREATE TABLE source_fetch_attempts (
  id TEXT PRIMARY KEY, source_id TEXT NOT NULL, config_revision INTEGER NOT NULL,
  evidence_kind TEXT NOT NULL CHECK(evidence_kind IN ('weibo_api','fixture')),
  status TEXT NOT NULL CHECK(status IN ('running','completed','failed')),
  started_at INTEGER NOT NULL, lease_until INTEGER NOT NULL, finished_at INTEGER,
  error_code TEXT, received_count INTEGER, skipped_count INTEGER,
  FOREIGN KEY(source_id,config_revision) REFERENCES external_source_versions(source_id,revision)
) STRICT;
CREATE UNIQUE INDEX source_fetch_active ON source_fetch_attempts(source_id) WHERE status='running';
CREATE INDEX source_fetch_history ON source_fetch_attempts(source_id,started_at DESC,id DESC);
CREATE TABLE source_posts (
  source_id TEXT NOT NULL REFERENCES external_sources(id), post_id TEXT NOT NULL,
  current_version INTEGER NOT NULL, PRIMARY KEY(source_id,post_id)
) STRICT;
CREATE TABLE source_post_versions (
  source_id TEXT NOT NULL, post_id TEXT NOT NULL, version INTEGER NOT NULL,
  fetch_id TEXT NOT NULL REFERENCES source_fetch_attempts(id),
  source_sha256 TEXT NOT NULL, post_json TEXT NOT NULL, published_at INTEGER NOT NULL, collected_at INTEGER NOT NULL,
  PRIMARY KEY(source_id,post_id,version), FOREIGN KEY(source_id,post_id) REFERENCES source_posts(source_id,post_id)
) STRICT;
CREATE INDEX source_post_recent ON source_post_versions(source_id,published_at DESC,post_id);
CREATE TABLE source_summaries (
  source_id TEXT NOT NULL, post_id TEXT NOT NULL, version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','running','ready','review','failed')),
  attempt_id TEXT UNIQUE, started_at INTEGER, lease_until INTEGER, finished_at INTEGER,
  result_json TEXT, error_code TEXT,
  PRIMARY KEY(source_id,post_id,version), FOREIGN KEY(source_id,post_id,version) REFERENCES source_post_versions(source_id,post_id,version)
) STRICT;
CREATE INDEX source_summary_queue ON source_summaries(status,source_id,post_id,version);

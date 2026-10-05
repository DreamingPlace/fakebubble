CREATE TABLE admin_voice_previews (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  profile_version INTEGER NOT NULL,
  profile_json TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES admin_sessions(id),
  text TEXT NOT NULL,
  expression TEXT NOT NULL CHECK(expression IN ('neutral','upbeat','soft','hesitant','serious')),
  speed REAL NOT NULL CHECK(speed>=0.5 AND speed<=2),
  evidence_kind TEXT NOT NULL CHECK(evidence_kind IN ('fish','fixture')),
  state TEXT NOT NULL CHECK(state IN ('queued','generating','ready','failed')),
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  lease_until INTEGER,
  finished_at INTEGER,
  error_code TEXT,
  generation_json TEXT,
  duration_ms INTEGER,
  byte_length INTEGER,
  sha256 TEXT,
  FOREIGN KEY(profile_id,profile_version) REFERENCES voice_profiles(id,version)
) STRICT;
CREATE INDEX admin_voice_previews_profile ON admin_voice_previews(profile_id,profile_version,created_at DESC,id DESC);
CREATE INDEX admin_voice_previews_queue ON admin_voice_previews(state,created_at,id);

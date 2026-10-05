CREATE TABLE web_instance (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  instance_id TEXT NOT NULL UNIQUE
) STRICT;

CREATE TABLE web_principals (
  id TEXT PRIMARY KEY, player_id TEXT NOT NULL REFERENCES api_players(id), world_id TEXT NOT NULL REFERENCES worlds(id),
  kind TEXT NOT NULL CHECK(kind IN ('guest','account','invite')),
  trial_character_id TEXT REFERENCES character_templates(id),
  trial_used INTEGER NOT NULL DEFAULT 0 CHECK(trial_used BETWEEN 0 AND 3),
  trial_reserved INTEGER NOT NULL DEFAULT 0 CHECK(trial_reserved BETWEEN 0 AND 3),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  CHECK(trial_used + trial_reserved <= 3)
) STRICT;
CREATE UNIQUE INDEX web_principals_world ON web_principals(world_id);

CREATE TABLE web_ip_windows (
  id TEXT PRIMARY KEY, ip_hash TEXT NOT NULL, starts_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0 CHECK(used BETWEEN 0 AND 3),
  reserved INTEGER NOT NULL DEFAULT 0 CHECK(reserved BETWEEN 0 AND 3),
  CHECK(expires_at > starts_at AND used + reserved <= 3)
) STRICT;
CREATE INDEX web_ip_windows_lookup ON web_ip_windows(ip_hash,starts_at DESC);

CREATE TABLE web_operations (
  id TEXT PRIMARY KEY, principal_id TEXT NOT NULL REFERENCES web_principals(id), request_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL, world_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
  character_id TEXT NOT NULL, input_message_id TEXT NOT NULL UNIQUE REFERENCES messages(id),
  ip_window_id TEXT NOT NULL REFERENCES web_ip_windows(id), status TEXT NOT NULL CHECK(status IN
    ('queued','text_running','text_ready','audio_pending','audio_running','ready_to_publish','retryable_failed','unknown','published','cancelled','failed')),
  quota_state TEXT NOT NULL CHECK(quota_state IN ('reserved','used','released')),
  created_at INTEGER NOT NULL, deadline_at INTEGER NOT NULL,
  UNIQUE(principal_id,request_id),
  FOREIGN KEY(world_id,conversation_id) REFERENCES conversations(world_id,id),
  FOREIGN KEY(world_id,character_id) REFERENCES world_characters(world_id,character_id)
) STRICT;
CREATE INDEX web_operations_waiting ON web_operations(status,created_at,id);
CREATE INDEX web_operations_principal_waiting ON web_operations(principal_id,status,created_at,id);

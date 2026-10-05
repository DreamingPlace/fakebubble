-- Internal candidate. No persistent migration or serve entrypoint is authorized.
CREATE TABLE web_invite_identity_receipts (
  id TEXT PRIMARY KEY,
  old_session_id TEXT NOT NULL UNIQUE REFERENCES web_sessions(id),
  new_session_id TEXT NOT NULL UNIQUE REFERENCES web_sessions(id),
  grant_id TEXT NOT NULL REFERENCES web_invite_grants(id),
  request_id TEXT NOT NULL,
  code_digest TEXT NOT NULL,
  public_receipt TEXT NOT NULL,
  key_id TEXT NOT NULL,
  nonce BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  auth_tag BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  successful_retrievals INTEGER NOT NULL DEFAULT 0 CHECK(successful_retrievals BETWEEN 0 AND 3),
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  failed_window_at INTEGER,
  revoked_at INTEGER,
  CHECK(expires_at > created_at),
  UNIQUE(old_session_id,request_id)
) STRICT;

CREATE TABLE web_invite_credentials (
  grant_id TEXT PRIMARY KEY REFERENCES web_invite_grants(id),
  secret_digest TEXT NOT NULL UNIQUE,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  created_at INTEGER NOT NULL,
  rotated_at INTEGER,
  revoked_at INTEGER
) STRICT;

CREATE TABLE web_invite_credential_receipts (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES web_invite_grants(id),
  request_id TEXT NOT NULL,
  old_secret_digest TEXT NOT NULL,
  new_secret_digest TEXT NOT NULL,
  new_session_id TEXT NOT NULL REFERENCES web_sessions(id),
  key_id TEXT NOT NULL,
  nonce BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  auth_tag BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  successful_retrievals INTEGER NOT NULL DEFAULT 0 CHECK(successful_retrievals BETWEEN 0 AND 3),
  CHECK(expires_at > created_at),
  UNIQUE(old_secret_digest,request_id)
) STRICT;

CREATE TABLE web_invite_attempt_windows (
  purpose TEXT NOT NULL CHECK(purpose IN ('redeem','recover')),
  ip_hash TEXT NOT NULL,
  window_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL CHECK(attempts BETWEEN 0 AND 20),
  PRIMARY KEY(purpose,ip_hash)
) STRICT;

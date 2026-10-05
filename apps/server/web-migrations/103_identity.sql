ALTER TABLE web_instance ADD COLUMN recovery_epoch TEXT NOT NULL DEFAULT 'uninitialized';

CREATE TABLE web_accounts (
  id TEXT PRIMARY KEY, principal_id TEXT NOT NULL UNIQUE REFERENCES web_principals(id),
  username_norm TEXT NOT NULL UNIQUE, password_salt BLOB NOT NULL, password_tag BLOB NOT NULL,
  security_revision INTEGER NOT NULL DEFAULT 1 CHECK(security_revision > 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)), created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE web_sessions (
  id TEXT PRIMARY KEY, token_digest TEXT NOT NULL UNIQUE,
  principal_id TEXT NOT NULL REFERENCES web_principals(id), account_id TEXT REFERENCES web_accounts(id),
  recovery_epoch TEXT NOT NULL, security_revision INTEGER NOT NULL,
  csrf_seed BLOB NOT NULL, created_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL,
  absolute_expires_at INTEGER NOT NULL, revoked_at INTEGER,
  CHECK(absolute_expires_at > created_at)
) STRICT;
CREATE INDEX web_sessions_principal ON web_sessions(principal_id,revoked_at);

CREATE TABLE web_identity_receipts (
  id TEXT PRIMARY KEY, old_session_id TEXT NOT NULL UNIQUE REFERENCES web_sessions(id),
  new_session_id TEXT NOT NULL UNIQUE REFERENCES web_sessions(id),
  account_id TEXT NOT NULL REFERENCES web_accounts(id), action TEXT NOT NULL CHECK(action='register'),
  request_id TEXT NOT NULL, request_mac BLOB NOT NULL, security_revision INTEGER NOT NULL,
  public_receipt TEXT NOT NULL,
  key_id TEXT NOT NULL, nonce BLOB NOT NULL, ciphertext BLOB NOT NULL, auth_tag BLOB NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, successful_retrievals INTEGER NOT NULL DEFAULT 0,
  failed_attempts INTEGER NOT NULL DEFAULT 0, failed_window_at INTEGER,
  revoked_at INTEGER, UNIQUE(old_session_id,action,request_id),
  CHECK(expires_at > created_at AND successful_retrievals BETWEEN 0 AND 3)
) STRICT;

CREATE TABLE beta_instance (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  instance_id TEXT NOT NULL UNIQUE
) STRICT;
CREATE TABLE beta_accounts (
  player_id TEXT PRIMARY KEY REFERENCES api_players(id),
  metering_id TEXT NOT NULL UNIQUE,
  nickname TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','suspended')),
  revision INTEGER NOT NULL CHECK(revision>0),
  suspended_at INTEGER
) STRICT;
CREATE TABLE beta_invites (
  token_hash TEXT PRIMARY KEY REFERENCES pairing_invites(token_hash),
  id TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  revoked_at INTEGER
) STRICT;
CREATE TABLE beta_account_receipts (
  player_id TEXT NOT NULL REFERENCES beta_accounts(player_id),
  request_id TEXT NOT NULL,
  request_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(player_id,request_id)
) STRICT;

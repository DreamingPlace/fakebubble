-- Metadata snapshots only; no historical price, budget reservation or raw generation content.
CREATE TABLE beta_cost_history (
  id TEXT PRIMARY KEY, source_key TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0),
  fingerprint TEXT NOT NULL, player_id TEXT REFERENCES beta_accounts(player_id), metering_id TEXT,
  character_id TEXT, captured_at INTEGER NOT NULL,
  value_json TEXT NOT NULL CHECK(json_valid(value_json)),
  UNIQUE(source_key, revision),
  CHECK((player_id IS NULL AND metering_id IS NULL) OR (player_id IS NOT NULL AND metering_id IS NOT NULL))
) STRICT;
CREATE INDEX beta_cost_history_owner ON beta_cost_history(player_id, captured_at, id);
CREATE TABLE beta_cost_history_receipts (
  request_id TEXT PRIMARY KEY, input_hash TEXT NOT NULL,
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  history_id TEXT NOT NULL REFERENCES beta_cost_history(id), created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX beta_cost_history_receipts_archive ON beta_cost_history_receipts(history_id);

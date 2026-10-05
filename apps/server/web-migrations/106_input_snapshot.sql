CREATE TABLE web_input_snapshots (
  operation_id TEXT PRIMARY KEY REFERENCES web_operations(id),
  capability TEXT NOT NULL CHECK(capability='input-snapshot-only'),
  format_version INTEGER NOT NULL CHECK(format_version=1),
  principal_id TEXT NOT NULL, player_id TEXT NOT NULL,
  world_id TEXT NOT NULL, conversation_id TEXT NOT NULL, character_id TEXT NOT NULL,
  input_message_id TEXT NOT NULL UNIQUE REFERENCES messages(id),
  input_seq INTEGER NOT NULL CHECK(input_seq > 0), input_body TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  template_version INTEGER NOT NULL CHECK(template_version > 0),
  template_json TEXT NOT NULL, template_digest TEXT NOT NULL,
  access_revision INTEGER NOT NULL CHECK(access_revision > 0),
  frozen_at INTEGER NOT NULL CHECK(frozen_at >= 0), snapshot_digest TEXT NOT NULL
) STRICT;

CREATE TRIGGER web_input_snapshots_no_update BEFORE UPDATE ON web_input_snapshots
BEGIN SELECT RAISE(ABORT,'WEB_INPUT_SNAPSHOT_IMMUTABLE'); END;
CREATE TRIGGER web_input_snapshots_no_delete BEFORE DELETE ON web_input_snapshots
BEGIN SELECT RAISE(ABORT,'WEB_INPUT_SNAPSHOT_IMMUTABLE'); END;

ALTER TABLE web_reviewed_candidates ADD COLUMN asset_eligible INTEGER NOT NULL DEFAULT 0 CHECK(asset_eligible IN (0,1));
ALTER TABLE web_synthetic_voice_segments ADD COLUMN asset_eligible INTEGER NOT NULL DEFAULT 0 CHECK(asset_eligible IN (0,1));

CREATE TABLE web_private_audio_assets (
  operation_id TEXT NOT NULL REFERENCES web_operations(id),
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  media_id TEXT NOT NULL UNIQUE, origin TEXT NOT NULL CHECK(origin='synthetic_test'),
  principal_id TEXT NOT NULL, player_id TEXT NOT NULL,
  world_id TEXT NOT NULL, conversation_id TEXT NOT NULL, character_id TEXT NOT NULL,
  input_message_id TEXT NOT NULL, text_digest TEXT NOT NULL, voice_version TEXT NOT NULL,
  format TEXT NOT NULL CHECK(format='wav_pcm16'),
  byte_length INTEGER NOT NULL CHECK(byte_length > 0 AND byte_length <= 6000000),
  sha256 TEXT NOT NULL, duration_ms INTEGER NOT NULL CHECK(duration_ms > 0),
  state TEXT NOT NULL CHECK(state IN ('preparing','synthetic_asset_verified')),
  lease_epoch INTEGER NOT NULL, lease_token TEXT NOT NULL, lease_until INTEGER NOT NULL,
  created_at INTEGER NOT NULL, verified_at INTEGER,
  PRIMARY KEY(operation_id,ordinal),
  FOREIGN KEY(operation_id,ordinal) REFERENCES web_synthetic_voice_segments(operation_id,ordinal),
  CHECK((state='preparing' AND verified_at IS NULL) OR
    (state='synthetic_asset_verified' AND verified_at IS NOT NULL))
) STRICT;

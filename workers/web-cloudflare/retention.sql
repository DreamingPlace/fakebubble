-- New EMPTY web R2 authorities only; never applied to a Node or legacy beta database.
ALTER TABLE web_provider_attempts ADD COLUMN output_proof TEXT;
CREATE TABLE cf_web_audio_objects (
  operation_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
  principal_id TEXT NOT NULL, world_id TEXT NOT NULL,
  reference_json TEXT NOT NULL CHECK(json_valid(reference_json)), erased_at INTEGER,
  PRIMARY KEY(operation_id,ordinal),
  FOREIGN KEY(operation_id) REFERENCES web_operations(id)
) STRICT;
CREATE TRIGGER cf_web_audio_objects_identity BEFORE UPDATE OF operation_id,ordinal,principal_id,world_id,reference_json ON cf_web_audio_objects
BEGIN SELECT RAISE(ABORT,'WEB_AUDIO_INTENT_IMMUTABLE'); END;
CREATE TRIGGER cf_web_audio_objects_no_delete BEFORE DELETE ON cf_web_audio_objects
BEGIN SELECT RAISE(ABORT,'WEB_AUDIO_INTENT_IMMUTABLE'); END;

DROP TRIGGER web_provider_outputs_no_delete;
CREATE TRIGGER web_provider_outputs_no_delete BEFORE DELETE ON web_provider_outputs
WHEN NOT EXISTS (SELECT 1 FROM web_operations o JOIN web_retention_purge_gate g
  ON g.principal_id=o.principal_id AND g.world_id=o.world_id
  JOIN web_guest_retention r ON r.principal_id=g.principal_id AND r.world_id=g.world_id
  JOIN web_principals p ON p.id=g.principal_id AND p.world_id=g.world_id
  WHERE o.id=OLD.operation_id AND p.kind='guest' AND r.state='purging' AND r.revision=g.retention_revision)
BEGIN SELECT RAISE(ABORT,'WEB_PROVIDER_OUTPUT_IMMUTABLE'); END;
DROP TRIGGER web_provider_candidates_no_delete;
CREATE TRIGGER web_provider_candidates_no_delete BEFORE DELETE ON web_provider_candidates
WHEN NOT EXISTS (SELECT 1 FROM web_operations o JOIN web_retention_purge_gate g
  ON g.principal_id=o.principal_id AND g.world_id=o.world_id
  JOIN web_guest_retention r ON r.principal_id=g.principal_id AND r.world_id=g.world_id
  JOIN web_principals p ON p.id=g.principal_id AND p.world_id=g.world_id
  WHERE o.id=OLD.operation_id AND p.kind='guest' AND r.state='purging' AND r.revision=g.retention_revision)
BEGIN SELECT RAISE(ABORT,'WEB_PROVIDER_CANDIDATE_IMMUTABLE'); END;
DROP TRIGGER web_provider_media_no_delete;
CREATE TRIGGER web_provider_media_no_delete BEFORE DELETE ON web_provider_media_assets
WHEN NOT EXISTS (SELECT 1 FROM web_operations o JOIN web_retention_purge_gate g
  ON g.principal_id=o.principal_id AND g.world_id=o.world_id
  JOIN web_guest_retention r ON r.principal_id=g.principal_id AND r.world_id=g.world_id
  JOIN web_principals p ON p.id=g.principal_id AND p.world_id=g.world_id
  WHERE o.id=OLD.operation_id AND p.kind='guest' AND r.state='purging' AND r.revision=g.retention_revision)
BEGIN SELECT RAISE(ABORT,'WEB_PROVIDER_MEDIA_IMMUTABLE'); END;

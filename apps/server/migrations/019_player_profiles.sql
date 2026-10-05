CREATE TABLE player_profile_versions (
  world_id TEXT NOT NULL REFERENCES worlds(id), revision INTEGER NOT NULL CHECK(revision > 0),
  profile_json TEXT NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY(world_id, revision)
) STRICT;
CREATE TABLE player_profile_requests (
  world_id TEXT NOT NULL, request_id TEXT NOT NULL, request_hash TEXT NOT NULL,
  revision INTEGER NOT NULL, PRIMARY KEY(world_id, request_id),
  FOREIGN KEY(world_id, revision) REFERENCES player_profile_versions(world_id, revision)
) STRICT;
CREATE TABLE character_association_versions (
  world_id TEXT NOT NULL, character_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0),
  association_json TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY(world_id, character_id, revision),
  FOREIGN KEY(world_id, character_id) REFERENCES world_characters(world_id, character_id)
) STRICT;
ALTER TABLE jobs ADD COLUMN player_context_key TEXT NOT NULL DEFAULT '0:0';

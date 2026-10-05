CREATE TABLE moment_audience_groups (
  world_id TEXT NOT NULL REFERENCES worlds(id), id TEXT NOT NULL,
  name TEXT NOT NULL, name_key TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>0), archived INTEGER NOT NULL CHECK(archived IN (0,1)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(world_id,id)
) STRICT;
CREATE UNIQUE INDEX moment_audience_group_names ON moment_audience_groups(world_id,name_key) WHERE archived=0;
CREATE TABLE moment_audience_group_members (
  world_id TEXT NOT NULL, group_id TEXT NOT NULL, character_id TEXT NOT NULL,
  PRIMARY KEY(world_id,group_id,character_id),
  FOREIGN KEY(world_id,group_id) REFERENCES moment_audience_groups(world_id,id),
  FOREIGN KEY(world_id,character_id) REFERENCES world_characters(world_id,character_id)
) STRICT;
CREATE TABLE moment_audience_group_receipts (
  world_id TEXT NOT NULL REFERENCES worlds(id), request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL, receipt_json TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY(world_id,request_id)
) STRICT;

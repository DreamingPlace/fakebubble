CREATE TABLE beta_evaluations (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  player_id TEXT NOT NULL REFERENCES beta_accounts(player_id),
  world_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  character_id TEXT NOT NULL,
  target_key TEXT NOT NULL,
  target_json TEXT NOT NULL CHECK(json_valid(target_json)),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  revision INTEGER NOT NULL CHECK(revision>0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(player_id,world_id,conversation_id,target_key),
  UNIQUE(id,player_id),
  FOREIGN KEY(world_id,conversation_id,group_id) REFERENCES jobs(world_id,conversation_id,id)
) STRICT;
CREATE INDEX beta_evaluation_group ON beta_evaluations(player_id,world_id,conversation_id,group_id,seq);
-- One immutable revision per accepted request. Retries return that revision, not a later edit.
CREATE TABLE beta_evaluation_revisions (
  evaluation_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>0),
  request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  ratings_json TEXT NOT NULL CHECK(json_valid(ratings_json)),
  reason TEXT NOT NULL,
  playback TEXT CHECK(playback IN ('partial','complete')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(evaluation_id,revision),
  UNIQUE(player_id,request_id),
  FOREIGN KEY(evaluation_id,player_id) REFERENCES beta_evaluations(id,player_id)
) STRICT;

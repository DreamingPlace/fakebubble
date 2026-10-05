CREATE TABLE beta_generation_provenance (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id),
  world_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  character_id TEXT NOT NULL,
  character_version INTEGER NOT NULL CHECK(character_version>0),
  policy_hash TEXT,
  release_json TEXT NOT NULL CHECK(json_valid(release_json)),
  FOREIGN KEY(world_id,conversation_id,job_id) REFERENCES jobs(world_id,conversation_id,id)
) STRICT;
CREATE TABLE beta_feedback (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  player_id TEXT NOT NULL REFERENCES beta_accounts(player_id),
  request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  world_id TEXT REFERENCES worlds(id),
  conversation_id TEXT,
  character_id TEXT,
  category TEXT CHECK(category IN ('function','copy','voice','character','other')),
  legacy_id TEXT UNIQUE REFERENCES message_feedback(id),
  legacy_category TEXT,
  note TEXT NOT NULL,
  expected TEXT NOT NULL,
  steps TEXT NOT NULL,
  diagnostics_json TEXT CHECK(diagnostics_json IS NULL OR json_valid(diagnostics_json)),
  service_json TEXT CHECK(service_json IS NULL OR json_valid(service_json)),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  legacy_snapshot_json TEXT CHECK(legacy_snapshot_json IS NULL OR json_valid(legacy_snapshot_json)),
  status TEXT NOT NULL CHECK(status IN ('untriaged','needs_information','confirmed','fixing','retest','resolved')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>0),
  UNIQUE(player_id,request_id),
  CHECK(category IS NOT NULL OR legacy_id IS NOT NULL),
  FOREIGN KEY(world_id,conversation_id) REFERENCES conversations(world_id,id)
) STRICT;
CREATE INDEX beta_feedback_player ON beta_feedback(player_id,seq);
CREATE TABLE beta_feedback_screenshots (
  feedback_id TEXT NOT NULL REFERENCES beta_feedback(id),
  id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal>=0 AND ordinal<3),
  width INTEGER NOT NULL CHECK(width>0 AND width<=4096),
  height INTEGER NOT NULL CHECK(height>0 AND height<=4096 AND width*height<=8388608),
  byte_length INTEGER NOT NULL CHECK(byte_length>0 AND byte_length<=5242880),
  sha256 TEXT NOT NULL,
  png BLOB NOT NULL CHECK(length(png)=byte_length),
  PRIMARY KEY(feedback_id,id),
  UNIQUE(feedback_id,ordinal)
) STRICT;
-- Preserve the original record, category, bounded evidence and receipt verbatim. Do not guess a new category.
INSERT INTO beta_feedback(id,player_id,request_id,request_hash,world_id,conversation_id,character_id,
  category,legacy_id,legacy_category,note,expected,steps,diagnostics_json,service_json,evidence_json,legacy_snapshot_json,status,created_at,updated_at,revision)
SELECT f.id,w.owner_id,'legacy:'||f.request_id,f.request_hash,f.world_id,f.conversation_id,f.character_id,
  NULL,f.id,f.category,f.note,'','',NULL,NULL,'[]',f.snapshot_json,'untriaged',f.created_at,f.created_at,1
FROM message_feedback f JOIN worlds w ON w.id=f.world_id JOIN beta_accounts a ON a.player_id=w.owner_id;

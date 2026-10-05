CREATE TABLE beta_character_roster (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1)
) STRICT;
CREATE TABLE beta_character_catalog (
  character_id TEXT PRIMARY KEY REFERENCES character_templates(id),
  initial INTEGER NOT NULL CHECK(initial IN (0,1)),
  first_version INTEGER NOT NULL CHECK(first_version>0),
  name TEXT NOT NULL,
  offered_at INTEGER,
  CHECK((initial=1 AND offered_at IS NULL) OR (initial=0 AND offered_at IS NOT NULL)),
  FOREIGN KEY(character_id,first_version) REFERENCES character_template_versions(character_id,version)
) STRICT;
-- Existing beta global characters are the migration baseline, never new invitations.
INSERT INTO beta_character_catalog
  SELECT t.id,1,t.version,json_extract(t.config_json,'$.name'),NULL FROM character_templates t
  WHERE NOT EXISTS (SELECT 1 FROM player_characters p WHERE p.character_id=t.id);
INSERT INTO beta_character_roster SELECT 1 WHERE EXISTS (SELECT 1 FROM beta_character_catalog);
CREATE TABLE beta_character_requests (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  player_id TEXT NOT NULL REFERENCES beta_accounts(player_id),
  character_id TEXT NOT NULL REFERENCES beta_character_catalog(character_id),
  status TEXT NOT NULL CHECK(status IN ('pending','accepted','rejected')),
  revision INTEGER NOT NULL CHECK(revision>0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  read_at INTEGER,
  world_id TEXT,
  conversation_id TEXT,
  relationship TEXT CHECK(relationship IN ('new','friend','close_friend','lover')),
  association TEXT,
  UNIQUE(player_id,character_id),
  UNIQUE(player_id,id),
  FOREIGN KEY(world_id,conversation_id) REFERENCES conversations(world_id,id),
  CHECK((status='accepted' AND world_id IS NOT NULL AND conversation_id IS NOT NULL AND relationship IS NOT NULL AND association IS NOT NULL AND read_at IS NOT NULL)
    OR (status!='accepted' AND world_id IS NULL AND conversation_id IS NULL AND relationship IS NULL AND association IS NULL)),
  CHECK(status!='rejected' OR read_at IS NOT NULL)
) STRICT;
CREATE INDEX beta_character_requests_player ON beta_character_requests(player_id,seq DESC);
CREATE TABLE beta_character_request_receipts (
  player_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  invitation_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  PRIMARY KEY(player_id,request_id),
  FOREIGN KEY(player_id,invitation_id) REFERENCES beta_character_requests(player_id,id)
) STRICT;

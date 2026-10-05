CREATE TABLE worlds (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL UNIQUE, time_zone TEXT NOT NULL, policy_json TEXT NOT NULL
) STRICT;
CREATE TABLE character_templates (
  id TEXT PRIMARY KEY, version INTEGER NOT NULL CHECK(version > 0), config_json TEXT NOT NULL
) STRICT;
CREATE TABLE world_characters (
  world_id TEXT NOT NULL REFERENCES worlds(id), character_id TEXT NOT NULL REFERENCES character_templates(id),
  relationship TEXT NOT NULL CHECK(relationship IN ('new','friend','close_friend','lover')),
  PRIMARY KEY(world_id, character_id)
) STRICT;
CREATE TABLE conversations (
  world_id TEXT NOT NULL REFERENCES worlds(id), id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('private','group')), private_character_id TEXT,
  CHECK((kind='private' AND private_character_id IS NOT NULL) OR (kind='group' AND private_character_id IS NULL)),
  PRIMARY KEY(world_id, id),
  FOREIGN KEY(world_id, private_character_id) REFERENCES world_characters(world_id, character_id)
) STRICT;
CREATE UNIQUE INDEX one_private_conversation ON conversations(world_id, private_character_id) WHERE kind='private';
CREATE TABLE participants (
  world_id TEXT NOT NULL, conversation_id TEXT NOT NULL, character_id TEXT NOT NULL,
  PRIMARY KEY(world_id, conversation_id, character_id),
  FOREIGN KEY(world_id, conversation_id) REFERENCES conversations(world_id, id),
  FOREIGN KEY(world_id, character_id) REFERENCES world_characters(world_id, character_id)
) STRICT;
CREATE TABLE contacts (
  world_id TEXT NOT NULL, conversation_id TEXT NOT NULL, character_id TEXT NOT NULL, state_json TEXT NOT NULL,
  PRIMARY KEY(world_id, conversation_id, character_id),
  FOREIGN KEY(world_id, conversation_id, character_id) REFERENCES participants(world_id, conversation_id, character_id)
) STRICT;
CREATE TABLE batches (
  id TEXT PRIMARY KEY, world_id TEXT NOT NULL, conversation_id TEXT NOT NULL, character_id TEXT NOT NULL,
  epoch INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('waiting','eligible','complete')),
  created_at INTEGER NOT NULL, guaranteed_at INTEGER NOT NULL, last_draw_at INTEGER,
  draw_count INTEGER NOT NULL DEFAULT 0, last_roll REAL, last_probability REAL,
  UNIQUE(id, character_id),
  FOREIGN KEY(world_id, conversation_id, character_id) REFERENCES contacts(world_id, conversation_id, character_id)
) STRICT;
CREATE INDEX batches_scope ON batches(world_id, conversation_id, character_id, epoch, status);
CREATE TABLE draws (
  id INTEGER PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES batches(id), at INTEGER NOT NULL,
  roll REAL NOT NULL CHECK(roll >= 0 AND roll < 1), probability REAL NOT NULL CHECK(probability >= 0 AND probability <= 1),
  template_version INTEGER NOT NULL, won INTEGER NOT NULL CHECK(won IN (0,1))
) STRICT;
CREATE TABLE messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, world_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
  author_kind TEXT NOT NULL CHECK(author_kind IN ('player','character')), author_id TEXT NOT NULL,
  body TEXT NOT NULL, created_at INTEGER NOT NULL, delivery TEXT NOT NULL CHECK(delivery IN ('text','voice')),
  voice_fallback INTEGER NOT NULL DEFAULT 0 CHECK(voice_fallback IN (0,1)), media_id TEXT,
  proactive INTEGER NOT NULL DEFAULT 0 CHECK(proactive IN (0,1)), quota_day TEXT,
  request_id TEXT, request_hash TEXT, UNIQUE(world_id, request_id),
  FOREIGN KEY(world_id, conversation_id) REFERENCES conversations(world_id, id)
) STRICT;
CREATE INDEX messages_scope ON messages(world_id, conversation_id, seq);
CREATE INDEX quota_day ON messages(world_id, quota_day, author_id) WHERE proactive = 1;
CREATE TABLE proactive_intents (
  id TEXT PRIMARY KEY, world_id TEXT NOT NULL, conversation_id TEXT NOT NULL, character_id TEXT NOT NULL,
  request_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','complete','expired')),
  UNIQUE(world_id, request_id),
  FOREIGN KEY(world_id, conversation_id, character_id) REFERENCES contacts(world_id, conversation_id, character_id)
) STRICT;
CREATE TABLE jobs (
  id TEXT PRIMARY KEY, world_id TEXT NOT NULL, conversation_id TEXT NOT NULL, character_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('reply','proactive')), epoch INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('leased','published','failed')), created_at INTEGER NOT NULL, lease_until INTEGER NOT NULL,
  covered_ids_json TEXT NOT NULL, requested_delivery TEXT NOT NULL CHECK(requested_delivery IN ('text','voice')),
  intent_id TEXT REFERENCES proactive_intents(id), failure_code TEXT, published_message_id TEXT REFERENCES messages(id),
  UNIQUE(world_id, conversation_id, id),
  FOREIGN KEY(world_id, conversation_id, character_id) REFERENCES contacts(world_id, conversation_id, character_id)
) STRICT;
CREATE UNIQUE INDEX one_live_job ON jobs(world_id, conversation_id, character_id) WHERE status = 'leased';
CREATE TABLE reply_items (
  message_id TEXT NOT NULL REFERENCES messages(id), character_id TEXT NOT NULL,
  batch_id TEXT NOT NULL REFERENCES batches(id), job_id TEXT REFERENCES jobs(id),
  covered_by TEXT REFERENCES messages(id), PRIMARY KEY(message_id, character_id),
  FOREIGN KEY(batch_id, character_id) REFERENCES batches(id, character_id)
) STRICT;
CREATE INDEX pending_items ON reply_items(batch_id) WHERE covered_by IS NULL;
CREATE TABLE media (
  id TEXT PRIMARY KEY, world_id TEXT NOT NULL, conversation_id TEXT NOT NULL, job_id TEXT NOT NULL REFERENCES jobs(id),
  status TEXT NOT NULL CHECK(status IN ('pending','ready','failed')), relative_path TEXT,
  FOREIGN KEY(world_id, conversation_id, job_id) REFERENCES jobs(world_id, conversation_id, id),
  FOREIGN KEY(world_id, conversation_id) REFERENCES conversations(world_id, id)
) STRICT;
CREATE TABLE outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, world_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL UNIQUE REFERENCES messages(id), created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','delivered')),
  FOREIGN KEY(world_id, conversation_id) REFERENCES conversations(world_id, id)
) STRICT;

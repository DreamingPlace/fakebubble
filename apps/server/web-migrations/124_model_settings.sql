-- Owner-controlled reply models and prices (Part 21g). The business object is the only writer: the admin page changes these
-- rows with no deploy. Nothing here holds player data and nothing here reaches a prompt.
--
-- PLAYER_MODEL_CHOICE_ENABLED stays the master flag and PLAYER_TEXT_MODELS (with the provider keys) becomes a CEILING: a model
-- the environment does not list, or has no key for, is never offered whatever these rows say. The defaults written here are
-- today's behaviour: all three models on; a guest sees DeepSeek only; registered and invited players see all three.

-- One row per player model. Tiers: guest (trial guest), registered (signed-up player with points), invited (invite principal or
-- account). `points_per_reply` is what a reply written by this model costs a registered player (voice is a separate setting).
CREATE TABLE web_model_settings (
  model TEXT PRIMARY KEY CHECK(model IN ('deepseek','gemini','xai')),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  allowed_guest INTEGER NOT NULL CHECK(allowed_guest IN (0,1)),
  allowed_registered INTEGER NOT NULL CHECK(allowed_registered IN (0,1)),
  allowed_invited INTEGER NOT NULL CHECK(allowed_invited IN (0,1)),
  points_per_reply INTEGER NOT NULL CHECK(points_per_reply BETWEEN 1 AND 200),
  updated_at INTEGER NOT NULL,
  -- The administrator member id who made the last change; NULL for the defaults written by this migration.
  updated_by_admin TEXT
) STRICT;
INSERT INTO web_model_settings(model,enabled,allowed_guest,allowed_registered,allowed_invited,points_per_reply,updated_at,updated_by_admin) VALUES
  ('deepseek',1,1,1,1,10,0,NULL),
  ('gemini',1,0,1,1,20,0,NULL),
  ('xai',1,0,1,1,25,0,NULL);

-- The single voice setting (points added when a reply includes voice) and the revision of the whole settings page, which a save
-- must quote (a second administrator's change is never silently overwritten).
CREATE TABLE web_model_voice (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  voice_points INTEGER NOT NULL CHECK(voice_points BETWEEN 0 AND 20),
  revision INTEGER NOT NULL CHECK(revision>=1),
  updated_at INTEGER NOT NULL,
  updated_by_admin TEXT
) STRICT;
INSERT INTO web_model_voice(singleton,voice_points,revision,updated_at,updated_by_admin) VALUES (1,2,1,0,NULL);

-- Every price table that was ever in force, append-only. A points event, a charge and a refund name the version they were made
-- under (web_points_events.price_version, web_operation_models.price_version), so an operation admitted under an old table keeps
-- its frozen model AND price whatever the owner changes later. The current table is the highest version; a price change
-- (any per-reply price or the voice price) appends a new version. Version 1 is the table Part 21b shipped; version 2 is the
-- defaults above (Grok at 25).
CREATE TABLE web_price_versions (
  version INTEGER PRIMARY KEY CHECK(version>=1),
  deepseek_points INTEGER NOT NULL CHECK(deepseek_points BETWEEN 1 AND 200),
  gemini_points INTEGER NOT NULL CHECK(gemini_points BETWEEN 1 AND 200),
  xai_points INTEGER NOT NULL CHECK(xai_points BETWEEN 1 AND 200),
  voice_points INTEGER NOT NULL CHECK(voice_points BETWEEN 0 AND 20),
  created_at INTEGER NOT NULL,
  created_by_admin TEXT
) STRICT;
INSERT INTO web_price_versions(version,deepseek_points,gemini_points,xai_points,voice_points,created_at,created_by_admin) VALUES
  (1,10,20,40,2,0,NULL),
  (2,10,20,25,2,0,NULL);
CREATE TRIGGER web_price_versions_no_update BEFORE UPDATE ON web_price_versions
BEGIN SELECT RAISE(ABORT,'WEB_PRICE_VERSION_IMMUTABLE'); END;
CREATE TRIGGER web_price_versions_no_delete BEFORE DELETE ON web_price_versions
BEGIN SELECT RAISE(ABORT,'WEB_PRICE_VERSION_IMMUTABLE'); END;

-- Append-only change log of the admin page: who (the administrator member id), when, what. One row per changed field, rows of one
-- save share `save_id`. Settings only: no player id, no email, no content. `field` is one of the setting columns or 'voice_points';
-- values are 0/1 for a switch and the integer points for a price.
CREATE TABLE web_model_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  save_id TEXT NOT NULL,
  admin_id TEXT NOT NULL,
  model TEXT CHECK(model IS NULL OR model IN ('deepseek','gemini','xai')),
  field TEXT NOT NULL CHECK(field IN ('enabled','allowed_guest','allowed_registered','allowed_invited','points_per_reply','voice_points')),
  old_value INTEGER NOT NULL,
  new_value INTEGER NOT NULL CHECK(new_value<>old_value),
  price_version INTEGER NOT NULL CHECK(price_version>=1),
  created_at INTEGER NOT NULL,
  CHECK((field='voice_points') = (model IS NULL))
) STRICT;
CREATE INDEX web_model_changes_recent ON web_model_changes(id);
CREATE TRIGGER web_model_changes_no_update BEFORE UPDATE ON web_model_changes
BEGIN SELECT RAISE(ABORT,'WEB_MODEL_CHANGE_IMMUTABLE'); END;
CREATE TRIGGER web_model_changes_no_delete BEFORE DELETE ON web_model_changes
BEGIN SELECT RAISE(ABORT,'WEB_MODEL_CHANGE_IMMUTABLE'); END;

-- Idempotent dispatch of the admin save: a replay of the same requestId answers what the first save answered; the same
-- requestId with other content is a conflict. No player data.
CREATE TABLE web_model_save_requests (
  request_id TEXT PRIMARY KEY CHECK(length(request_id) BETWEEN 8 AND 64),
  request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
  save_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

-- Part 13b: the 预演测试 evaluation workbench. Everything here is ADMIN-ONLY synthetic data: no table touches a
-- player's world, conversation, memory or message, and nothing here reaches a prompt or a provider. The business
-- object is the only writer. The preview rows themselves (admin_previews, 005) and their billing ledger
-- (web_character_preview_*, created by the preview installer) are not altered: a run, a time mark and a rejected
-- output are SEPARATE rows keyed by the preview id, so the ledger, its triggers and its schema digest stay as they were.
-- No foreign key points at an installer-created table (those do not exist yet when this step runs); only admin_previews.

-- A batch submission is one RUN. It records what it ran on (draft revision + profile hash), the relationship, the
-- simulated wall-clock minute (preview only, inside the character's OWN time zone, recorded in time_zone) and who
-- started it. request_id makes the submission idempotent; request_hash detects a different body under the same id.
CREATE TABLE web_preview_runs (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
  character_id TEXT NOT NULL,
  label TEXT CHECK(label IS NULL OR length(label) BETWEEN 1 AND 60),
  draft_revision INTEGER NOT NULL CHECK(draft_revision>0),
  profile_hash TEXT NOT NULL CHECK(length(profile_hash)=64),
  relationship TEXT NOT NULL CHECK(relationship IN ('new','friend','close_friend','lover')),
  simulated_minute INTEGER CHECK(simulated_minute IS NULL OR simulated_minute BETWEEN 0 AND 1439),
  time_zone TEXT NOT NULL CHECK(length(time_zone) BETWEEN 1 AND 100),
  eval_set_id TEXT,
  eval_set_version INTEGER CHECK(eval_set_version IS NULL OR eval_set_version>0),
  item_count INTEGER NOT NULL CHECK(item_count BETWEEN 1 AND 50),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX web_preview_runs_character ON web_preview_runs(character_id,created_at DESC);

-- Each preview belongs to at most one run (preview_id UNIQUE); a single preview simply has no row here. note is the
-- eval-set line's optional expectation, shown next to the result and never sent to a provider.
CREATE TABLE web_preview_run_items (
  run_id TEXT NOT NULL REFERENCES web_preview_runs(id),
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 1 AND 50),
  preview_id TEXT NOT NULL UNIQUE REFERENCES admin_previews(id),
  note TEXT CHECK(note IS NULL OR length(note)<=300),
  PRIMARY KEY(run_id,ordinal)
) STRICT;

-- Simulated character local time of one preview (a single one or a run's item): minutes after midnight in the
-- character's own zone. Absent = the real clock. The zone is a record of what was used, never an input.
CREATE TABLE web_preview_marks (
  preview_id TEXT PRIMARY KEY REFERENCES admin_previews(id),
  simulated_minute INTEGER NOT NULL CHECK(simulated_minute BETWEEN 0 AND 1439),
  time_zone TEXT NOT NULL CHECK(length(time_zone) BETWEEN 1 AND 100)
) STRICT;

-- What the model returned for a stage that completed with usage but failed validation. Admin-only diagnosis: bounded
-- (raw_output is at most 32 KiB of UTF-8 plus a short truncation marker; raw_bytes is the original size), never
-- shown to a player, never sent to a provider again, deleted with the character's previews. It does not change how
-- the bill is settled: the attempt row in the ledger is written by its own transaction exactly as before.
CREATE TABLE web_preview_rejected (
  preview_id TEXT NOT NULL REFERENCES admin_previews(id),
  phase TEXT NOT NULL CHECK(phase IN ('draft','review')),
  error_code TEXT NOT NULL CHECK(length(error_code) BETWEEN 1 AND 100),
  raw_output TEXT NOT NULL CHECK(length(CAST(raw_output AS BLOB))<=32832),
  raw_bytes INTEGER NOT NULL CHECK(raw_bytes>=0),
  truncated INTEGER NOT NULL CHECK(truncated IN (0,1)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(preview_id,phase)
) STRICT;

-- Eval sets: named lists of inputs (at most 50 lines of {text, note?}). Every save makes a new version; the current
-- one is mirrored in web_eval_sets and all of them are kept in web_eval_set_versions, so a run can name exactly the
-- version it used.
CREATE TABLE web_eval_sets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE CHECK(length(name) BETWEEN 1 AND 60),
  version INTEGER NOT NULL CHECK(version>0),
  items_json TEXT NOT NULL CHECK(json_valid(items_json) AND json_type(items_json)='array' AND json_array_length(items_json) BETWEEN 1 AND 50),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE web_eval_set_versions (
  set_id TEXT NOT NULL REFERENCES web_eval_sets(id),
  version INTEGER NOT NULL CHECK(version>0),
  name TEXT NOT NULL,
  items_json TEXT NOT NULL CHECK(json_valid(items_json)),
  saved_by TEXT NOT NULL,
  saved_at INTEGER NOT NULL,
  PRIMARY KEY(set_id,version)
) STRICT;

-- Requests, run items and marks are immutable once written; saved versions are never edited (a set may be deleted with all its versions).
CREATE TRIGGER web_preview_runs_immutable BEFORE UPDATE ON web_preview_runs
  BEGIN SELECT RAISE(ABORT,'WEB_PREVIEW_RUN_IMMUTABLE'); END;
CREATE TRIGGER web_preview_run_items_immutable BEFORE UPDATE ON web_preview_run_items
  BEGIN SELECT RAISE(ABORT,'WEB_PREVIEW_RUN_IMMUTABLE'); END;
CREATE TRIGGER web_preview_marks_immutable BEFORE UPDATE ON web_preview_marks
  BEGIN SELECT RAISE(ABORT,'WEB_PREVIEW_RUN_IMMUTABLE'); END;
CREATE TRIGGER web_preview_rejected_immutable BEFORE UPDATE ON web_preview_rejected
  BEGIN SELECT RAISE(ABORT,'WEB_PREVIEW_RUN_IMMUTABLE'); END;
CREATE TRIGGER web_eval_set_versions_immutable BEFORE UPDATE ON web_eval_set_versions
  BEGIN SELECT RAISE(ABORT,'WEB_EVAL_SET_IMMUTABLE'); END;

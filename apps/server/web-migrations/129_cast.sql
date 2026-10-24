-- The cast (Part 24a): ONE versioned document holds the shared world - characters, relationships, groups, stories and memes - and one
-- pure function compiles a per-character view of it for the prompt. Nothing here is player data: no principal, world, conversation or
-- operation id, no message. Publishing and rolling back never touch a player table. The business object is the only writer.
-- Everything is behind CAST_CONTEXT_ENABLED (default off); with the switch off the three snapshot columns below stay NULL.

-- Exactly one draft row. `revision` is the compare-and-swap counter of the editor; the document is validated by cast-validation.ts
-- before it is written (the CHECK only keeps it parseable and bounded). The row starts as the empty document of schema 1.
CREATE TABLE web_cast_draft (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  revision INTEGER NOT NULL CHECK(revision>0),
  doc_json TEXT NOT NULL CHECK(json_valid(doc_json) AND length(doc_json)<=300000),
  updated_at INTEGER NOT NULL CHECK(updated_at>=0)
) STRICT;
INSERT INTO web_cast_draft(singleton,revision,doc_json,updated_at) VALUES (1,1,'{"schema":1,"world":{"background":""},"characters":[],"people":[],"ratings":{},"directions":[],"groups":[],"stories":[],"memes":[]}',0);

-- Append-only: every publish and every rollback is a new row with the next version. A rollback republishes an old version's
-- document (from_version says which). The digest is the sha256 of doc_json.
CREATE TABLE web_cast_publications (
  version INTEGER PRIMARY KEY CHECK(version>0),
  doc_json TEXT NOT NULL CHECK(json_valid(doc_json) AND length(doc_json)<=300000),
  digest TEXT NOT NULL CHECK(length(digest)=64),
  published_at INTEGER NOT NULL CHECK(published_at>=0),
  kind TEXT NOT NULL CHECK(kind IN ('publish','rollback')),
  from_version INTEGER REFERENCES web_cast_publications(version),
  CHECK((kind='publish' AND from_version IS NULL) OR (kind='rollback' AND from_version IS NOT NULL AND from_version<version))
) STRICT;
CREATE TRIGGER web_cast_publications_no_update BEFORE UPDATE ON web_cast_publications
BEGIN SELECT RAISE(ABORT,'WEB_CAST_HISTORY_IMMUTABLE'); END;
CREATE TRIGGER web_cast_publications_no_delete BEFORE DELETE ON web_cast_publications
BEGIN SELECT RAISE(ABORT,'WEB_CAST_HISTORY_IMMUTABLE'); END;
CREATE TRIGGER web_cast_draft_no_delete BEFORE DELETE ON web_cast_draft
BEGIN SELECT RAISE(ABORT,'WEB_CAST_DRAFT_REQUIRED'); END;

-- The compiled view of one character, frozen with the input at the first text claim (like template_json). All three are NULL when
-- CAST_CONTEXT_ENABLED was off (or nothing had been published) at that moment, and all three are set together. The snapshot is
-- immutable (web_input_snapshots_no_update), so a later publish, rollback or switch flip never changes an operation already frozen.
ALTER TABLE web_input_snapshots ADD COLUMN cast_version INTEGER;
ALTER TABLE web_input_snapshots ADD COLUMN cast_json TEXT;
ALTER TABLE web_input_snapshots ADD COLUMN cast_digest TEXT;
CREATE TRIGGER web_input_snapshots_cast_together BEFORE INSERT ON web_input_snapshots
WHEN (NEW.cast_version IS NULL) <> (NEW.cast_json IS NULL) OR (NEW.cast_version IS NULL) <> (NEW.cast_digest IS NULL)
  OR (NEW.cast_json IS NOT NULL AND (NEW.cast_version<1 OR length(NEW.cast_digest)<>64 OR NOT json_valid(NEW.cast_json)))
BEGIN SELECT RAISE(ABORT,'WEB_INPUT_SNAPSHOT_CAST_INVALID'); END;

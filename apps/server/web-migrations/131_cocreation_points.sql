-- Co-creation notes (Part 24c): production-team notes (留言条), pair stories, and points for notes. The business object is the only
-- writer. Nothing here reaches a prompt or a provider; submissions stay untrusted text until an administrator copies them into a draft.

-- A submission is about one character (kind 'character', as before), to the production team (kind 'memo': character_id is the
-- placeholder '_memo', never earns) or about the story between two characters (kind 'pair': character_id and partner_id are
-- the two characters). Existing rows are all 'character'.
ALTER TABLE web_cocreation_submissions ADD COLUMN kind TEXT NOT NULL DEFAULT 'character' CHECK(kind IN ('character','memo','pair'));
ALTER TABLE web_cocreation_submissions ADD COLUMN partner_id TEXT;
CREATE TRIGGER web_cocreation_submissions_kind BEFORE INSERT ON web_cocreation_submissions
WHEN (NEW.kind='pair' AND (NEW.partner_id IS NULL OR NEW.partner_id=NEW.character_id))
  OR (NEW.kind<>'pair' AND NEW.partner_id IS NOT NULL)
  OR (NEW.kind='memo' AND NEW.character_id<>'_memo')
BEGIN SELECT RAISE(ABORT,'WEB_COCREATION_KIND_INVALID'); END;
CREATE INDEX web_cocreation_submissions_partner ON web_cocreation_submissions(partner_id) WHERE partner_id IS NOT NULL;

-- Per answer ("note"): note_hash is the digest of the normalized text under its character / pair (the silent duplicate check; NULL for a
-- memo), paid_points what the note earned when submitted (0 = unpaid), adopt_paid 1 once the first adoption has been rewarded - an
-- undo never makes it 0, so a second adoption pays nothing.
ALTER TABLE web_cocreation_answers ADD COLUMN note_hash TEXT CHECK(note_hash IS NULL OR length(note_hash)=64);
ALTER TABLE web_cocreation_answers ADD COLUMN paid_points INTEGER NOT NULL DEFAULT 0 CHECK(paid_points>=0);
ALTER TABLE web_cocreation_answers ADD COLUMN adopt_paid INTEGER NOT NULL DEFAULT 0 CHECK(adopt_paid IN (0,1));
CREATE INDEX web_cocreation_answers_hash ON web_cocreation_answers(note_hash) WHERE note_hash IS NOT NULL;

-- The three numbers (editable by the owner and points.grant holders); one row, compare-and-swap on revision. Every change is audited
-- (numbers only) in web_admin_audit. Defaults: +5 per note, at most 15 paid notes per player per UTC day, +20 when a note is adopted.
CREATE TABLE web_cocreation_points (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  note_points INTEGER NOT NULL CHECK(note_points BETWEEN 0 AND 100),
  daily_cap INTEGER NOT NULL CHECK(daily_cap BETWEEN 0 AND 100),
  adopt_points INTEGER NOT NULL CHECK(adopt_points BETWEEN 0 AND 1000),
  revision INTEGER NOT NULL CHECK(revision>0),
  updated_at INTEGER NOT NULL CHECK(updated_at>=0),
  updated_by TEXT
) STRICT;
INSERT INTO web_cocreation_points(singleton,note_points,daily_cap,adopt_points,revision,updated_at,updated_by) VALUES (1,5,15,20,1,0,NULL);
CREATE TRIGGER web_cocreation_points_no_delete BEFORE DELETE ON web_cocreation_points
BEGIN SELECT RAISE(ABORT,'WEB_COCREATION_POINTS_REQUIRED'); END;

-- web_points_events gains two sources (cocreation_note, cocreation_adopted) and `ref`, the idempotency key of a reward
-- ('<submission>:<ordinal>'; at most one event per source and ref). A CHECK cannot be altered, so the table is rebuilt: ids, rows,
-- indexes and the two triggers are carried over unchanged (the statistics trigger 128 still counts every source by name).
CREATE TABLE web_points_events_131 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  principal_id TEXT NOT NULL REFERENCES web_principals(id),
  operation_id TEXT REFERENCES web_operations(id),
  source TEXT NOT NULL CHECK(source IN ('bonus','grant','daily_refill','reset','spend','refund','cocreation_note','cocreation_adopted')),
  reason TEXT CHECK(reason IS NULL OR reason IN ('reply','no_reply','backup_cheaper','no_voice')),
  delta INTEGER NOT NULL CHECK(delta<>0),
  admin_id TEXT,
  price_version INTEGER NOT NULL CHECK(price_version>0),
  created_at INTEGER NOT NULL,
  ref TEXT,
  CHECK((source='spend' AND operation_id IS NOT NULL AND reason='reply' AND delta<0) OR
        (source='refund' AND operation_id IS NOT NULL AND reason IN ('no_reply','backup_cheaper','no_voice') AND delta>0) OR
        (source IN ('bonus','grant','daily_refill','reset') AND operation_id IS NULL AND reason IS NULL) OR
        (source IN ('cocreation_note','cocreation_adopted') AND operation_id IS NULL AND reason IS NULL AND delta>0 AND ref IS NOT NULL)),
  CHECK(admin_id IS NULL OR source IN ('grant','reset','cocreation_adopted')),
  CHECK(ref IS NULL OR source IN ('cocreation_note','cocreation_adopted'))
) STRICT;
INSERT INTO web_points_events_131(id,principal_id,operation_id,source,reason,delta,admin_id,price_version,created_at)
SELECT id,principal_id,operation_id,source,reason,delta,admin_id,price_version,created_at FROM web_points_events;
UPDATE sqlite_sequence SET seq=max(seq,coalesce((SELECT seq FROM sqlite_sequence WHERE name='web_points_events'),0))
WHERE name='web_points_events_131';
DROP TABLE web_points_events;
ALTER TABLE web_points_events_131 RENAME TO web_points_events;
CREATE INDEX web_points_events_principal ON web_points_events(principal_id,id);
CREATE UNIQUE INDEX web_points_events_once ON web_points_events(operation_id,source,reason) WHERE operation_id IS NOT NULL;
CREATE UNIQUE INDEX web_points_events_bonus_once ON web_points_events(principal_id) WHERE source='bonus';
CREATE UNIQUE INDEX web_points_events_ref_once ON web_points_events(source,ref) WHERE ref IS NOT NULL;
CREATE TRIGGER web_points_events_no_update BEFORE UPDATE ON web_points_events
BEGIN SELECT RAISE(ABORT,'WEB_POINTS_EVENT_IMMUTABLE'); END;
CREATE TRIGGER web_stats_points AFTER INSERT ON web_points_events
BEGIN
  INSERT INTO web_stats_daily(day,metric,character_id,model,value)
  VALUES (strftime('%Y-%m-%d',NEW.created_at/1000,'unixepoch'),
    'points_'||CASE NEW.source WHEN 'spend' THEN 'spent' WHEN 'refund' THEN 'refunded' WHEN 'grant' THEN 'granted' ELSE NEW.source END,
    '',
    CASE WHEN NEW.source IN ('spend','refund')
      THEN coalesce((SELECT chosen FROM web_operation_models WHERE operation_id=NEW.operation_id),'') ELSE '' END,
    abs(NEW.delta))
  ON CONFLICT(day,metric,character_id,model) DO UPDATE SET value=value+excluded.value;
END;

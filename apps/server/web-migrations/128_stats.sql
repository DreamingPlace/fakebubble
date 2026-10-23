-- Player statistics and consumption (Part 22c). The business object is the only writer; every counter below is written when the
-- event happens, in the same transaction, because the rows the events live in (web_operations, web_operation_models,
-- web_points_events, web_provider_attempts, web_player_logins) are DELETED by the purge: no statistic is ever computed from them
-- at report time. Nothing here is backfilled, and nothing here reaches a prompt or a provider.

-- One counter per UTC day ("YYYY-MM-DD"), metric, character and chosen model. Counts only: no principal id, no operation id, no
-- content. character_id / model are '' for a metric that has no such dimension (and model is '' for a reply admitted with model
-- choice off). Metrics (written by the triggers below and by the code named in docs/STATUS.md):
--   reply_published | reply_failed | reply_unknown | reply_voice   by character and chosen model, on the admission day
--   points_spent | points_refunded | points_granted | points_reset | points_daily_refill | points_bonus   points moved that day
--     (spent and refunded by chosen model)
--   signups | new_guests | purge_deleted | purge_inactive | purge_expired   one count per event
--   active_registered | active_guest | chat_registered | chat_guest   a finished day's distinct players (from the markers below,
--     written down by the retention alarm before the markers are pruned; today's are read from the markers)
--   d1_cohort d1_retained d7_cohort d7_retained   written once, when the cohort of day `day` closes, then frozen
--   stats_started   one row: the first UTC day the counters were running
CREATE TABLE web_stats_daily (
  day TEXT NOT NULL CHECK(day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  metric TEXT NOT NULL CHECK(length(metric) BETWEEN 1 AND 48),
  character_id TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  value INTEGER NOT NULL DEFAULT 0 CHECK(value>=0),
  PRIMARY KEY(day,metric,character_id,model)
) STRICT;

-- Who was active on a UTC day, WITHOUT saying who. marker = HMAC-SHA256 under a key derived (HKDF) from SEAL_KEY with the label
-- 'stats-active-v1', over the day and the principal id: it can be recomputed by the business object for a principal it already
-- knows (the D1 / D7 close) but never read back to one. scope 'visit' = opened the site that day, 'chat' = sent a message that
-- day; kind = whether the principal had an email login. Pruned after 35 days by the retention alarm; never shown, exported or logged.
CREATE TABLE web_daily_active (
  day TEXT NOT NULL CHECK(day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  marker TEXT NOT NULL CHECK(length(marker)=64),
  kind TEXT NOT NULL CHECK(kind IN ('guest','registered')),
  scope TEXT NOT NULL CHECK(scope IN ('visit','chat')),
  PRIMARY KEY(day,marker,scope)
) STRICT;

-- Replies: ONE trigger, because the status is set in many places (publisher, dispatch ledger, admission, stage queue, expiry,
-- cancel, recovery, purge). It fires once per operation: when a row that is not yet final becomes published / failed / unknown.
-- published, failed, cancelled and unknown are final for the count (an UNKNOWN call is never retried, so a later expiry of the same
-- operation must not count it a second time); a replay or a second update of a final row counts nothing. The day is the UTC day of
-- admission (created_at), the model is the one the player chose (web_operation_models, '' when there is no row), and a reply is a
-- voice reply when one of its bubbles was published with audio (a text fallback is not).
CREATE TRIGGER web_stats_reply_final AFTER UPDATE OF status ON web_operations
WHEN OLD.status NOT IN ('published','failed','cancelled','unknown') AND NEW.status IN ('published','failed','unknown')
BEGIN
  INSERT INTO web_stats_daily(day,metric,character_id,model,value)
  VALUES (strftime('%Y-%m-%d',NEW.created_at/1000,'unixepoch'),'reply_'||NEW.status,NEW.character_id,
    coalesce((SELECT chosen FROM web_operation_models WHERE operation_id=NEW.id),''),1)
  ON CONFLICT(day,metric,character_id,model) DO UPDATE SET value=value+1;
  INSERT INTO web_stats_daily(day,metric,character_id,model,value)
  SELECT strftime('%Y-%m-%d',NEW.created_at/1000,'unixepoch'),'reply_voice',NEW.character_id,
    coalesce((SELECT chosen FROM web_operation_models WHERE operation_id=NEW.id),''),1
  WHERE NEW.status='published' AND EXISTS (SELECT 1 FROM dialogue_bubbles b JOIN messages m ON m.id=b.message_id
    WHERE b.job_id=NEW.id AND m.delivery='voice')
  ON CONFLICT(day,metric,character_id,model) DO UPDATE SET value=value+1;
END;

-- Points: the append-only ledger is the one place every movement passes (spend at admission, refund, grant, reset, daily refill,
-- the signup bonus). The value is the points moved that day; spent and refunded carry the model the reply was admitted on.
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

-- Signups: a login is created once per principal.
CREATE TRIGGER web_stats_signup AFTER INSERT ON web_player_logins
BEGIN
  INSERT INTO web_stats_daily(day,metric,character_id,model,value)
  VALUES (strftime('%Y-%m-%d',NEW.created_at/1000,'unixepoch'),'signups','','',1)
  ON CONFLICT(day,metric,character_id,model) DO UPDATE SET value=value+1;
END;

-- What the budget ledger really charged for these calls (the attempt's charged_micros, the upper bound it holds), next to the
-- list cost: the consumption table shows both. A row written before this step has 0 here and the page shows it as unknown.
ALTER TABLE web_provider_usage ADD COLUMN ledger_charged_micros INTEGER NOT NULL DEFAULT 0 CHECK(ledger_charged_micros>=0);

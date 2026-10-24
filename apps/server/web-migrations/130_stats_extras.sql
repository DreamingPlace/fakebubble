-- Statistics extras (Part 22d): chat users per character, hourly counts for the 24H chart, and spend by user type. Builds on 128
-- (web_stats_daily, web_daily_active and their triggers). The business object is the only writer. Counts only: no principal id, no
-- operation id and no content in any statistic below, and the markers are HMACs that are pruned. Nothing is backfilled.

-- Invite batches can be marked as the test group. Set at creation and never changed (the trigger below); every batch that exists
-- now is not a test batch. A player who redeemed a code of a test batch is 测试组 for the user-type split of the consumption table.
ALTER TABLE web_invite_batches ADD COLUMN test INTEGER NOT NULL DEFAULT 0 CHECK(test IN (0,1));
CREATE TRIGGER web_invite_batches_test_fixed BEFORE UPDATE OF test ON web_invite_batches WHEN NEW.test<>OLD.test
BEGIN SELECT RAISE(ABORT,'WEB_INVITE_BATCH_TEST_IMMUTABLE'); END;

-- Who chatted with which character on a UTC day, WITHOUT saying who. marker = HMAC-SHA256 under the same stats key as
-- web_daily_active (HKDF from SEAL_KEY, label 'stats-active-v1') over 'chat', the day, the character and the principal. A finished
-- day's per-character counts are written into web_stats_daily (metric chat_users, character_id set) by the retention alarm before
-- its markers are pruned (35 days, like web_daily_active). Never shown, exported or logged.
CREATE TABLE web_chat_active (
  day TEXT NOT NULL CHECK(day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  character_id TEXT NOT NULL CHECK(length(character_id) BETWEEN 1 AND 128),
  marker TEXT NOT NULL CHECK(length(marker)=64),
  PRIMARY KEY(day,character_id,marker)
) STRICT;

-- The 24H chart: counts per UTC hour ('YYYY-MM-DDTHH'), kept for 48 hours and pruned on the retention sweep.
--   reply_published | reply_failed | reply_unknown   per character, by the UTC hour of ADMISSION (the same rule and the same
--     once-only trigger condition as the daily counters, so the 24 hours of a day add up to that day's daily row)
--   chat_users   distinct players that sent a message in the hour: per character, and character_id '' = in total (a player who chats
--     with two characters counts once for each and once in the total)
CREATE TABLE web_stats_hourly (
  hour TEXT NOT NULL CHECK(length(hour)=13 AND substr(hour,11,1)='T' AND hour GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
  metric TEXT NOT NULL CHECK(metric IN ('reply_published','reply_failed','reply_unknown','chat_users')),
  character_id TEXT NOT NULL DEFAULT '',
  value INTEGER NOT NULL DEFAULT 0 CHECK(value>=0),
  PRIMARY KEY(hour,metric,character_id)
) STRICT;
-- The hourly markers behind chat_users (character_id '' = the total). Pruned with the hourly rows.
CREATE TABLE web_chat_active_hourly (
  hour TEXT NOT NULL CHECK(length(hour)=13 AND substr(hour,11,1)='T' AND hour GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'),
  character_id TEXT NOT NULL,
  marker TEXT NOT NULL CHECK(length(marker)=64),
  PRIMARY KEY(hour,character_id,marker)
) STRICT;

-- Hourly replies: the same condition as web_stats_reply_final (a row that is not yet final becomes published / failed / unknown).
CREATE TRIGGER web_stats_reply_final_hourly AFTER UPDATE OF status ON web_operations
WHEN OLD.status NOT IN ('published','failed','cancelled','unknown') AND NEW.status IN ('published','failed','unknown')
BEGIN
  INSERT INTO web_stats_hourly(hour,metric,character_id,value)
  VALUES (strftime('%Y-%m-%dT%H',NEW.created_at/1000,'unixepoch'),'reply_'||NEW.status,NEW.character_id,1)
  ON CONFLICT(hour,metric,character_id) DO UPDATE SET value=value+1;
END;

-- The user type of an operation, frozen at admission (a later tier change never moves an old reply). One row per operation admitted
-- after this step; the type is one of the five below, first match wins: test (redeemed a code of a test batch), unlimited,
-- daily_refill, registered, guest. There is no administrator type: nothing links an administrator to a player (docs/STATUS.md).
-- Like web_operation_models it holds an operation id and an enum only, and outlives the purge of the player.
CREATE TABLE web_operation_user_types (
  operation_id TEXT PRIMARY KEY REFERENCES web_operations(id),
  user_type TEXT NOT NULL CHECK(user_type IN ('test','unlimited','daily_refill','registered','guest')),
  created_at INTEGER NOT NULL
) STRICT;

-- What the budget ledger charged for the provider calls of replies, per UTC day, user type and kind (text = draft and review,
-- voice = speech): the ledger_charged_micros of web_provider_usage split by who the reply was for. user_type 'unknown' = a call of
-- an operation admitted before this step (it has no frozen type). Global counters: no principal, no operation, no content.
CREATE TABLE web_stats_spend (
  day TEXT NOT NULL CHECK(day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  user_type TEXT NOT NULL CHECK(user_type IN ('test','unlimited','daily_refill','registered','guest','unknown')),
  kind TEXT NOT NULL CHECK(kind IN ('text','voice')),
  calls INTEGER NOT NULL DEFAULT 0 CHECK(calls>=0),
  charged_micros INTEGER NOT NULL DEFAULT 0 CHECK(charged_micros>=0),
  PRIMARY KEY(day,user_type,kind)
) STRICT;

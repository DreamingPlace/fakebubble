-- Tester chat review (Part 19, flag CHAT_REVIEW_ENABLED). While testing, the owner reads whole chat transcripts to tune the
-- characters' tone without being able to tell which account a transcript belongs to. The business object is the only writer.
-- Nothing here reaches a prompt or a provider.

-- The anonymous review code of one principal (4 characters from an alphabet without look-alikes: no 0/O, 1/I/L), drawn at
-- random - never derived from an id, email, IP or invite - and shown as "<character label>-<code>". The same code covers all
-- of one player's characters. Player data: removed with the player (account deletion, guest clear, both retention purges).
-- A code is also never handed out while any archive row below still carries it (checked by the code that assigns it).
CREATE TABLE web_review_codes (
  principal_id TEXT PRIMARY KEY REFERENCES web_principals(id),
  code TEXT NOT NULL UNIQUE CHECK(length(code)=4 AND code NOT GLOB '*[^ABCDEFGHJKMNPQRSTUVWXYZ23456789]*'),
  assigned_at INTEGER NOT NULL
) STRICT;

-- One-time chat banner: a row means "this player closed it". Remembered per principal on the server; player data.
CREATE TABLE web_review_notice (
  principal_id TEXT PRIMARY KEY REFERENCES web_principals(id),
  closed_at INTEGER NOT NULL
) STRICT;

-- Anonymous review archive: chat text without identity, kept 180 days after a player's chats were removed. It holds NO
-- principal, player, world, conversation, session or operation id and no column, index or digest that joins to an account.
-- Only the purge-starting transaction writes it (before any content is cleared) and only the sweep deletes from it, by
-- expires_at. Nicknames are replaced by 〔昵称〕 before the text is written. at_local is the character's own local time
-- ("YYYY-MM-DD HH:MM"). speaker is player / character / proactive; a failed reply is a character line with status 'failed'.
CREATE TABLE web_review_archive (
  label TEXT NOT NULL CHECK(length(label) BETWEEN 6 AND 80),
  review_code TEXT NOT NULL CHECK(length(review_code)=4),
  character_id TEXT NOT NULL,
  line_order INTEGER NOT NULL CHECK(line_order>=0),
  at_local TEXT NOT NULL CHECK(length(at_local)=16),
  speaker TEXT NOT NULL CHECK(speaker IN ('player','character','proactive')),
  text TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('ok','failed')),
  error_code TEXT,
  review_changed INTEGER NOT NULL DEFAULT 0 CHECK(review_changed IN (0,1)),
  archived_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  CHECK(expires_at=archived_at+15552000000),
  PRIMARY KEY(label,line_order)
) STRICT;
CREATE INDEX web_review_archive_expiry ON web_review_archive(expires_at);
CREATE INDEX web_review_archive_code ON web_review_archive(review_code);
CREATE INDEX web_review_archive_character ON web_review_archive(character_id);

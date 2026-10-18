-- Invite tiers (Part 22a). An invite is an ENTITLEMENT attached to a normal signed-up account: redeeming a code never changes
-- web_principals.kind or web_guest_retention.state again. The business object is the only writer. Nothing here reaches a prompt.
--
-- The signed-up player's base policy (web_points_policy: the one_off signup bonus) is untouched. The effective tier is: an
-- active entitlement, else registered. 'unlimited' is never charged; 'daily_refill' adds +N points on the first visit of each
-- UTC day, never taking the balance above the cap. Codes stay digest-only (web_invite_codes), shown once at creation.

-- A batch of codes and the tier every code of it grants. daily_amount / total_cap are the batch's CURRENT values (the owner may
-- edit them later; every holder reads them at their next refill). duration_days is the entitlement length counted from
-- redemption (NULL = no expiry). request_id makes creation idempotent; request_digest detects a changed replay.
CREATE TABLE web_invite_batches (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 128),
  tier TEXT NOT NULL CHECK(tier IN ('unlimited','daily_refill')),
  daily_amount INTEGER CHECK(daily_amount IS NULL OR daily_amount BETWEEN 1 AND 100000),
  total_cap INTEGER CHECK(total_cap IS NULL OR total_cap BETWEEN 1 AND 10000000),
  duration_days INTEGER CHECK(duration_days IS NULL OR duration_days BETWEEN 1 AND 3650),
  request_id TEXT UNIQUE,
  request_digest TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  CHECK((tier='daily_refill') = (daily_amount IS NOT NULL AND total_cap IS NOT NULL)),
  CHECK(daily_amount IS NULL OR total_cap IS NULL OR total_cap>=daily_amount)
) STRICT;

-- Codes issued before this Part have no batch of their own: one 'unlimited' batch per distinct batch name carries them.
INSERT INTO web_invite_batches(id,name,tier,daily_amount,total_cap,duration_days,request_id,request_digest,created_by,created_at)
SELECT 'legacy:'||batch,batch,'unlimited',NULL,NULL,NULL,NULL,NULL,NULL,min(created_at) FROM web_invite_codes GROUP BY batch;

ALTER TABLE web_invite_codes ADD COLUMN batch_id TEXT REFERENCES web_invite_batches(id);
UPDATE web_invite_codes SET batch_id='legacy:'||batch;
CREATE INDEX web_invite_codes_batch ON web_invite_codes(batch_id);

-- What a player holds. source 'invite' = redeemed from a code, 'admin' = given by an administrator. kind 'unlimited' or
-- 'daily_refill'; a daily_refill entitlement of a batch reads its amount and cap from the batch, one without a batch
-- (source 'admin') from its own columns. revoked_at / expires_at end it; the player is then a normal registered player.
CREATE TABLE web_entitlements (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES web_principals(id),
  source TEXT NOT NULL CHECK(source IN ('invite','admin')),
  invite_id TEXT REFERENCES web_invite_codes(id),
  batch_id TEXT REFERENCES web_invite_batches(id),
  kind TEXT NOT NULL CHECK(kind IN ('unlimited','daily_refill')),
  daily_amount INTEGER CHECK(daily_amount IS NULL OR daily_amount BETWEEN 1 AND 100000),
  total_cap INTEGER CHECK(total_cap IS NULL OR total_cap BETWEEN 1 AND 10000000),
  starts_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  CHECK((source='invite') = (invite_id IS NOT NULL)),
  CHECK(expires_at IS NULL OR expires_at>starts_at),
  CHECK(kind='unlimited' OR batch_id IS NOT NULL OR (daily_amount IS NOT NULL AND total_cap IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX web_entitlements_invite_once ON web_entitlements(invite_id) WHERE invite_id IS NOT NULL;
CREATE INDEX web_entitlements_principal ON web_entitlements(principal_id,starts_at);
CREATE INDEX web_entitlements_batch ON web_entitlements(batch_id);

-- A redemption of an entitlement code: the idempotency record (principal + requestId), like web_invite_redemptions.
CREATE TABLE web_entitlement_redemptions (
  principal_id TEXT NOT NULL REFERENCES web_principals(id),
  request_id TEXT NOT NULL,
  code_digest TEXT NOT NULL,
  entitlement_id TEXT NOT NULL UNIQUE REFERENCES web_entitlements(id),
  redeemed_at INTEGER NOT NULL,
  PRIMARY KEY(principal_id,request_id)
) STRICT;

-- One row per (player, UTC day) the daily refill ran: the once-a-day guard. delta is what was actually added (0 at the cap).
CREATE TABLE web_entitlement_refills (
  principal_id TEXT NOT NULL REFERENCES web_principals(id),
  day TEXT NOT NULL CHECK(day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  entitlement_id TEXT NOT NULL REFERENCES web_entitlements(id),
  delta INTEGER NOT NULL CHECK(delta>=0),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(principal_id,day)
) STRICT;

-- Append-only owner edits of a batch's N and cap (also written to the admin audit). request_id makes an edit idempotent.
CREATE TABLE web_invite_batch_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL REFERENCES web_invite_batches(id),
  admin_id TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  old_amount INTEGER NOT NULL,
  new_amount INTEGER NOT NULL,
  old_cap INTEGER NOT NULL,
  new_cap INTEGER NOT NULL,
  holders INTEGER NOT NULL CHECK(holders>=0),
  created_at INTEGER NOT NULL
) STRICT;
CREATE TRIGGER web_invite_batch_changes_no_update BEFORE UPDATE ON web_invite_batch_changes
BEGIN SELECT RAISE(ABORT,'WEB_INVITE_BATCH_CHANGE_IMMUTABLE'); END;

-- 玩家编号: a short random code per registered player (8 characters of Crockford base32 - no I, L, O, U), unique, never
-- sequential and never derived from an id, email or invite. Distinct from the chat-review code (web_review_codes).
CREATE TABLE web_player_numbers (
  principal_id TEXT PRIMARY KEY REFERENCES web_principals(id),
  number TEXT NOT NULL UNIQUE CHECK(length(number)=8 AND number NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'),
  created_at INTEGER NOT NULL
) STRICT;

-- Backfill 1: every existing registered player (a signup bonus row, or an email login) gets a number. A collision (about one
-- in 10^12 per pair) is ignored and retried by the next statement; the application assigns any that is still missing.
INSERT OR IGNORE INTO web_player_numbers(principal_id,number,created_at)
SELECT p.id,
  substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ',1+(abs(random())%32),1)||substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ',1+(abs(random())%32),1)||
  substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ',1+(abs(random())%32),1)||substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ',1+(abs(random())%32),1)||
  substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ',1+(abs(random())%32),1)||substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ',1+(abs(random())%32),1)||
  substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ',1+(abs(random())%32),1)||substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ',1+(abs(random())%32),1),
  CAST(strftime('%s','now') AS INTEGER)*1000
FROM web_principals p
WHERE (EXISTS (SELECT 1 FROM web_signup_bonus b WHERE b.principal_id=p.id)
    OR EXISTS (SELECT 1 FROM web_player_logins l WHERE l.principal_id=p.id))
  AND NOT EXISTS (SELECT 1 FROM web_player_numbers n WHERE n.principal_id=p.id);
INSERT OR IGNORE INTO web_player_numbers(principal_id,number,created_at)
SELECT p.id,
  substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ',1+(abs(random())%32),1)||substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ',1+(abs(random())%32),1)||
  substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ',1+(abs(random())%32),1)||substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ',1+(abs(random())%32),1)||
  substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ',1+(abs(random())%32),1)||substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ',1+(abs(random())%32),1)||
  substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ',1+(abs(random())%32),1)||substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ',1+(abs(random())%32),1),
  CAST(strftime('%s','now') AS INTEGER)*1000
FROM web_principals p
WHERE (EXISTS (SELECT 1 FROM web_signup_bonus b WHERE b.principal_id=p.id)
    OR EXISTS (SELECT 1 FROM web_player_logins l WHERE l.principal_id=p.id))
  AND NOT EXISTS (SELECT 1 FROM web_player_numbers n WHERE n.principal_id=p.id);

-- Backfill 2: NO principal kind and NO retention state changes. An invited principal (kind 'invite') with an email login and
-- an ACTIVE grant (not revoked, not past its expiry now) gets an 'unlimited' entitlement carrying the grant's expiry. One with
-- a lapsed grant gets none (it is already a registered player: 17h / 17i). An invited principal WITHOUT a login keeps the
-- legacy path untouched until its grant ends.
INSERT INTO web_entitlements(id,principal_id,source,invite_id,batch_id,kind,daily_amount,total_cap,starts_at,expires_at,revoked_at,created_at)
SELECT 'legacy:'||g.id,g.principal_id,'invite',g.invite_id,c.batch_id,'unlimited',NULL,NULL,g.redeemed_at,g.expires_at,NULL,
  CAST(strftime('%s','now') AS INTEGER)*1000
FROM web_invite_grants g
JOIN web_principals p ON p.id=g.principal_id AND p.player_id=g.player_id AND p.world_id=g.world_id AND p.kind='invite'
JOIN web_invite_codes c ON c.id=g.invite_id
WHERE EXISTS (SELECT 1 FROM web_player_logins l WHERE l.principal_id=g.principal_id)
  AND g.revoked_at IS NULL
  AND (g.expires_at IS NULL OR g.expires_at>CAST(strftime('%s','now') AS INTEGER)*1000);

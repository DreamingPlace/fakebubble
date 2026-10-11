-- Player email logins ("邮箱账号"). A login is a CREDENTIAL bound 1:1 to an existing principal: principal kinds, admission
-- and entitlement are unchanged (a login without an active invite grant keeps the guest-trial treatment), and sessions
-- created by a login keep account_id NULL. This is deliberately not the legacy web_accounts/username/Argon2 path.
-- The business object is the only writer; nothing here reaches a prompt or a provider.

-- One login per principal and one principal per email. email_norm is trimmed + lower-cased. password_hash is the
-- scrypt format of web-admin-password.ts (works in workerd, unlike node:crypto argon2).
CREATE TABLE web_player_logins (
  principal_id TEXT PRIMARY KEY REFERENCES web_principals(id),
  email_norm TEXT NOT NULL UNIQUE CHECK(length(email_norm) BETWEEN 3 AND 254),
  password_hash TEXT NOT NULL CHECK(length(password_hash) BETWEEN 1 AND 256),
  created_at INTEGER NOT NULL,
  password_changed_at INTEGER NOT NULL,
  -- Last activity: set at signup / login and refreshed by bootstrap at most once per UTC day. The inactivity purge
  -- (180 days, see web-player-purge.ts) reads it; a signed-up guest is otherwise kept after the trial ends.
  last_seen_at INTEGER NOT NULL
) STRICT;
CREATE INDEX web_player_logins_seen ON web_player_logins(last_seen_at);

-- One-time email codes. code_digest is an HMAC under a REQUEST_KEY-derived key (never the code itself). A new challenge
-- supersedes the previous live one for the same email and purpose (consumed_at set); rows double as the send ledger
-- behind the per-email / per-IP limits. principal_id is the session principal for signup/bind, NULL for reset.
-- verified_at is set once the right code was entered; the second step (password + nickname) needs it.
-- delivery: 'pending' until the mailer answers, 'accepted' / 'unknown' after it, 'none' when no code mail is sent
-- (already-registered address, unknown reset address): the response to the player is identical either way.
CREATE TABLE web_email_challenges (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK(purpose IN ('signup','reset','bind')),
  email_norm TEXT NOT NULL CHECK(length(email_norm) BETWEEN 3 AND 254),
  principal_id TEXT REFERENCES web_principals(id),
  code_digest TEXT NOT NULL CHECK(length(code_digest)=64),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
  ip_hash TEXT NOT NULL CHECK(length(ip_hash)=64),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  verified_at INTEGER,
  consumed_at INTEGER,
  delivery TEXT NOT NULL DEFAULT 'pending' CHECK(delivery IN ('pending','accepted','unknown','none')),
  CHECK(expires_at>created_at),
  CHECK((purpose='reset') = (principal_id IS NULL))
) STRICT;
CREATE INDEX web_email_challenges_email ON web_email_challenges(email_norm,purpose,created_at);
CREATE INDEX web_email_challenges_ip ON web_email_challenges(ip_hash,created_at);
CREATE INDEX web_email_challenges_principal ON web_email_challenges(principal_id);

-- Emails sent per UTC day ("YYYY-MM-DD"), the global daily cap (Worker var PLAYER_EMAIL_DAILY_CAP, default 200).
CREATE TABLE web_player_email_daily (
  day TEXT PRIMARY KEY CHECK(length(day)=10),
  sends INTEGER NOT NULL CHECK(sends>=0)
) STRICT;

-- Failure counters for login, password and code checks. key is an HMAC (of the email, the IP hash or an email + hour
-- slot): no address and no IP is stored here, and rows carry no principal. login-* / password-* rows are fixed 15-minute
-- windows; 'code-email' rows are one-hour slots (window_at = slot start) whose failures are summed over the last
-- 24 hours, so the wrong-code limit per email is rolling and spans every challenge and purpose.
CREATE TABLE web_player_throttle (
  scope TEXT NOT NULL CHECK(scope IN ('login-email','login-ip','password-principal','code-email')),
  key TEXT NOT NULL CHECK(length(key)=64),
  window_at INTEGER NOT NULL,
  failures INTEGER NOT NULL CHECK(failures>=0),
  PRIMARY KEY(scope,key)
) STRICT;
CREATE INDEX web_player_throttle_window ON web_player_throttle(window_at);

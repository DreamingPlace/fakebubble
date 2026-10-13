-- Signup bonus (Part 17b, flag SIGNUP_BONUS_ENABLED). A guest that signs up with a verified email gets a lifetime allowance
-- of WEB_LIMITS.signupBonusReplies replies, used after the guest trial replies, with no time window and for any character.
-- The business object is the only writer. Nothing here reaches a prompt or a provider.

-- One row per email address that has ever been granted the bonus. email_hmac is an HMAC of the normalized address under a
-- REQUEST_KEY-derived key (never the address). It is deliberately NOT removed when the account is deleted: it is the only
-- thing kept, so that deleting and re-signing-up with the same address does not grant the bonus again.
CREATE TABLE web_bonus_emails (
  email_hmac TEXT PRIMARY KEY CHECK(length(email_hmac)=64),
  granted_at INTEGER NOT NULL
) STRICT;

-- The entitlement of one principal: a row means "this principal was granted the bonus". The allowance is a config constant;
-- how much is left is derived from web_free_operations (reserved + used), so there is no counter to drift. Player data:
-- removed with the player.
CREATE TABLE web_signup_bonus (
  principal_id TEXT PRIMARY KEY REFERENCES web_principals(id),
  granted_at INTEGER NOT NULL
) STRICT;

-- The operations admitted on a free allowance that is NOT counted in web_principals.trial_* (those columns and the IP window
-- tables are CHECK-limited to 3 by migration 100, and a table rebuild is not possible under the foreign keys): metering_type
-- 'entitled', no IP window, plus one row here. tier 'bonus' = the signup bonus (per principal, WEB_LIMITS.signupBonusReplies);
-- tier 'trial_extra' = the guest-trial replies 4 and 5 (WEB_LIMITS.publicTrialReplies - trialReplies, per principal AND per
-- ip_hash, lifetime). An operation counts while its quota_state is 'reserved' or 'used'; a failed or cancelled one is
-- 'released' and counts for nothing, so nothing here is a counter that could drift. 'trial_extra' rows keep the keyed
-- ip_hash and survive the purge, exactly as web_ip_lifetime_quota does (a purge must not reset the per-IP lifetime
-- allowance); 'bonus' rows are removed with the player.
CREATE TABLE web_free_operations (
  operation_id TEXT PRIMARY KEY REFERENCES web_operations(id),
  principal_id TEXT NOT NULL REFERENCES web_principals(id),
  tier TEXT NOT NULL CHECK(tier IN ('trial_extra','bonus')),
  ip_hash TEXT CHECK(ip_hash IS NULL OR length(ip_hash)=64),
  CHECK((tier='trial_extra') = (ip_hash IS NOT NULL))
) STRICT;
CREATE INDEX web_free_operations_principal ON web_free_operations(principal_id,tier);
CREATE INDEX web_free_operations_ip ON web_free_operations(ip_hash,tier);

-- Successful signups per IP (ip_hash is the existing keyed HMAC of the peer) per UTC day ("YYYY-MM-DD").
CREATE TABLE web_signup_ip_daily (
  ip_hash TEXT NOT NULL CHECK(length(ip_hash)=64),
  day TEXT NOT NULL CHECK(length(day)=10),
  signups INTEGER NOT NULL CHECK(signups>=0),
  PRIMARY KEY(ip_hash,day)
) STRICT;

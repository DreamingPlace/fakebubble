-- Internal candidate only. Do not open or serve schema111 until invite sessions,
-- entitlement checks, recovery and HTTP authorization are connected end-to-end.
CREATE TABLE web_invite_codes (
  id TEXT PRIMARY KEY,
  code_digest TEXT NOT NULL UNIQUE,
  issue_request_id TEXT NOT NULL UNIQUE,
  issue_digest TEXT NOT NULL,
  capacity INTEGER NOT NULL DEFAULT 1 CHECK(capacity=1),
  redeemed_count INTEGER NOT NULL DEFAULT 0 CHECK(redeemed_count BETWEEN 0 AND 1),
  redeem_by INTEGER,
  access_duration_ms INTEGER,
  status TEXT NOT NULL CHECK(status IN ('active','revoked')),
  batch TEXT NOT NULL,
  note TEXT,
  created_by TEXT NOT NULL REFERENCES admin_sessions(id),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  CHECK((status='active' AND revoked_at IS NULL) OR
        (status='revoked' AND revoked_at IS NOT NULL))
) STRICT;

CREATE TABLE web_invite_grants (
  id TEXT PRIMARY KEY,
  invite_id TEXT NOT NULL UNIQUE REFERENCES web_invite_codes(id),
  principal_id TEXT NOT NULL UNIQUE REFERENCES web_principals(id),
  player_id TEXT NOT NULL REFERENCES api_players(id),
  world_id TEXT NOT NULL REFERENCES worlds(id),
  redeemed_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER,
  CHECK(expires_at IS NULL OR expires_at>redeemed_at)
) STRICT;

CREATE TABLE web_invite_redemptions (
  principal_id TEXT NOT NULL REFERENCES web_principals(id),
  request_id TEXT NOT NULL,
  code_digest TEXT NOT NULL,
  grant_id TEXT NOT NULL UNIQUE REFERENCES web_invite_grants(id),
  redeemed_at INTEGER NOT NULL,
  PRIMARY KEY(principal_id,request_id)
) STRICT;

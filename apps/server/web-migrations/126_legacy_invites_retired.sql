-- Retire the legacy invite system (Part 22x). DATA ONLY: no table is created, altered or dropped, so every old table
-- (web_invite_grants, web_invite_redemptions, web_invite_credentials, the receipt tables) stays exactly as it is and nothing
-- reads them any more.
--
-- Before this step a code redeemed the old way turned a guest into a principal of kind 'invite' with retention state
-- 'protected'. No code path creates one any more, and no business decision reads that kind: this step turns every existing
-- one into a normal guest, so every rule that exists for guests applies unchanged.
--
--  - With an email login the player is a registered player (17h / 17i rules, 22a entitlements): kind 'guest', state 'active'.
--    The trial window it is given is already over, which is exactly what a registered guest past its trial is.
--  - Without a login it is a guest whose trial window is over: no access, and the retention cleaner purges it on its next
--    pass through the same audited path as every other expired guest.
--
-- 'purging' / 'purged' rows keep their state (their purge continues as it was); only the kind changes.
UPDATE web_guest_retention
SET started_at = COALESCE(started_at, 1),
    expires_at = CASE WHEN started_at IS NULL THEN 2 ELSE started_at + 1 END,
    state = 'active',
    revision = revision + 1
WHERE state = 'protected'
  AND principal_id IN (SELECT id FROM web_principals WHERE kind = 'invite');

UPDATE web_principals SET kind = 'guest', revision = revision + 1 WHERE kind = 'invite';

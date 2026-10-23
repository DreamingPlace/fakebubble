-- Invite codes can be viewed again (Part 22a2, owner request). Since Part 22a a code was stored only as the digest used to
-- redeem it and was shown once at creation. From this step a NEW code is also stored sealed, so the owner (every code) and the
-- administrator who created the batch (that batch's codes) can read it later. The business object is the only writer.
--
--  - web_invite_codes.code_sealed: AES-256-GCM, nonce(12) || ciphertext || tag(16), under a key derived with HKDF-SHA256 from the
--    business worker's SEAL_KEY (info 'invite-code-v1'), with the code row's id as additional authenticated data. The digest
--    that redemption looks up (code_digest) is unchanged and stays the only thing redemption reads. NULL = a code created before
--    this step: it has only its digest and can never be shown again (the pages say 旧邀请码无法再次查看). Nothing is backfilled -
--    the plain codes of old rows are not recoverable from a digest.
--  - web_invite_batches.created_by_member: the administrator MEMBER who created the batch, set at creation. created_by is the
--    login SESSION (it ends after 8 hours); who may see a batch's plain codes must follow the person, not the session. NULL for
--    batches created before this step (they have no sealed codes either).
ALTER TABLE web_invite_codes ADD COLUMN code_sealed BLOB;
ALTER TABLE web_invite_batches ADD COLUMN created_by_member TEXT;

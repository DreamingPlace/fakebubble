-- Player co-creation ("共创"): invited players leave ideas for an official character; administrators read them in an
-- inbox and copy what is useful into the character draft by hand. Nothing here reaches a prompt, nothing is reviewed
-- automatically and no provider is called. The business object is the only writer.

-- One submission = what a player handed over in one go. (principal_id, request_id) makes the submit idempotent:
-- request_hash is the digest of the validated answers, so a replay with other content is a conflict, never a second row.
-- status / starred / admin_note / processed_* are the administrators' working state.
CREATE TABLE web_cocreation_submissions (
  id TEXT PRIMARY KEY,
  character_id TEXT NOT NULL,
  principal_id TEXT NOT NULL REFERENCES web_principals(id),
  request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','processed','archived')),
  starred INTEGER NOT NULL DEFAULT 0 CHECK(starred IN (0,1)),
  admin_note TEXT CHECK(admin_note IS NULL OR length(admin_note)<=4000),
  processed_by TEXT,
  processed_at INTEGER,
  UNIQUE(principal_id,request_id),
  CHECK((processed_by IS NULL) = (processed_at IS NULL))
) STRICT;
-- The rolling 24-hour limit counts a player's submissions to one character; the inbox lists newest first.
CREATE INDEX web_cocreation_submissions_player ON web_cocreation_submissions(principal_id,character_id,created_at);
CREATE INDEX web_cocreation_submissions_inbox ON web_cocreation_submissions(character_id,status,created_at DESC);

-- The answers of a submission, in the order written. text_json is a JSON string for a text card and
-- {"player":..., "replies":[...]} for a dialogue card. Untrusted player text: rendered escaped, never interpreted.
-- adopted_* records that an administrator copied the answer into a draft (the draft itself is saved elsewhere).
CREATE TABLE web_cocreation_answers (
  submission_id TEXT NOT NULL REFERENCES web_cocreation_submissions(id),
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 11),
  card_id TEXT NOT NULL,
  target_field TEXT NOT NULL CHECK(target_field IN
    ('persona','speechStyle','dialogueStyle','dialogueExamples','interests','boundaries','personalityLayers','fictionalPeople','free')),
  kind TEXT NOT NULL CHECK(kind IN ('text','dialogue')),
  text_json TEXT NOT NULL CHECK(json_valid(text_json)),
  adopted_at INTEGER,
  adopted_by TEXT,
  PRIMARY KEY(submission_id,ordinal),
  CHECK((adopted_at IS NULL) = (adopted_by IS NULL)),
  CHECK((kind='text' AND json_type(text_json)='text') OR (kind='dialogue' AND json_type(text_json)='object'))
) STRICT;

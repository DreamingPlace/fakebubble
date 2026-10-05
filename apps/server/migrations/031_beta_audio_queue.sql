ALTER TABLE speech_tasks ADD COLUMN dispatch_seq INTEGER
  CHECK(dispatch_seq IS NULL OR (dispatch_seq > 0 AND dispatch_seq <= 9007199254740991 AND started_at IS NOT NULL));
CREATE UNIQUE INDEX beta_audio_dispatch_sequence ON speech_tasks(dispatch_seq) WHERE dispatch_seq IS NOT NULL;

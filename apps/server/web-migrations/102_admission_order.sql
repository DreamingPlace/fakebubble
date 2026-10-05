ALTER TABLE web_operations ADD COLUMN admission_seq INTEGER CHECK(admission_seq > 0);

WITH ordered AS (
  SELECT id, row_number() OVER (ORDER BY rowid) AS seq FROM web_operations
)
UPDATE web_operations SET admission_seq=(SELECT seq FROM ordered WHERE ordered.id=web_operations.id);

CREATE UNIQUE INDEX web_operations_admission_seq ON web_operations(admission_seq);
CREATE TABLE web_admission_counter (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  last_seq INTEGER NOT NULL CHECK(last_seq >= 0)
) STRICT;
INSERT INTO web_admission_counter(singleton,last_seq)
  SELECT 1,coalesce(max(admission_seq),0) FROM web_operations;

CREATE INDEX web_operations_text_fifo ON web_operations(status,principal_id,admission_seq);
CREATE INDEX web_operations_audio_fifo ON web_operations(status,principal_id,admission_seq);

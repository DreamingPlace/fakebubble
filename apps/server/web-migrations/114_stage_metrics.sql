-- Stage latency metrics and rate-limit bookkeeping. The business object is the only writer; nothing here
-- changes a quota, budget or provider state. Rows are scoped to one operation (and so to one principal).
CREATE TABLE web_operation_metrics (
  operation_id TEXT PRIMARY KEY REFERENCES web_operations(id),
  day TEXT NOT NULL CHECK(day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  text_started_at INTEGER,
  audio_started_at INTEGER,
  text_queue_wait_ms INTEGER CHECK(text_queue_wait_ms IS NULL OR text_queue_wait_ms>=0),
  audio_queue_wait_ms INTEGER CHECK(audio_queue_wait_ms IS NULL OR audio_queue_wait_ms>=0),
  text_stage_ms INTEGER CHECK(text_stage_ms IS NULL OR text_stage_ms>=0),
  audio_stage_ms INTEGER CHECK(audio_stage_ms IS NULL OR audio_stage_ms>=0),
  text_rate_limit_retries INTEGER NOT NULL DEFAULT 0 CHECK(text_rate_limit_retries BETWEEN 0 AND 3),
  audio_rate_limit_retries INTEGER NOT NULL DEFAULT 0 CHECK(audio_rate_limit_retries BETWEEN 0 AND 3),
  fallback_used INTEGER NOT NULL DEFAULT 0 CHECK(fallback_used IN (0,1)),
  fallback_reason TEXT CHECK(fallback_reason IN ('audio_wait','rate_limited')),
  CHECK((fallback_used=0 AND fallback_reason IS NULL) OR (fallback_used=1 AND fallback_reason IS NOT NULL))
) STRICT;
CREATE INDEX web_operation_metrics_day ON web_operation_metrics(day);

-- One row exists exactly for an attempt that a provider rejected with HTTP 429 before running it. The attempt
-- keeps its single budget reservation across retries; this row is how the business object knows the shared
-- budget already holds that reservation (so a retry must not reserve it a second time).
CREATE TABLE web_attempt_rejections (
  operation_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('draft','review','speech')),
  ordinal INTEGER NOT NULL,
  rejections INTEGER NOT NULL CHECK(rejections BETWEEN 1 AND 4),
  last_rejected_at INTEGER NOT NULL,
  last_code TEXT NOT NULL CHECK(last_code IN ('DEEPSEEK_RATE_LIMITED','FISH_RATE_LIMITED')),
  PRIMARY KEY(operation_id,phase,ordinal),
  FOREIGN KEY(operation_id,phase,ordinal) REFERENCES web_provider_attempts(operation_id,phase,ordinal)
) STRICT;

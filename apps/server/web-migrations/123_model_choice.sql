-- Player model choice, points, backup log and usage aggregates (Part 21b, flag PLAYER_MODEL_CHOICE_ENABLED).
-- The business object is the only writer. Nothing here reaches a prompt: the chosen model is routing data.
-- Nothing is backfilled: a player's points balance is created lazily on first touch (100 - 10 x bonus replies already spent).

-- The model a player wants to write their replies. DeepSeek is the default and the universal fallback, so a player with no
-- row is on DeepSeek. `notice` is a one-time message ('model_withdrawn': the owner switched the model off and the player
-- was moved to DeepSeek); the player page shows it once and clears it.
CREATE TABLE web_player_model (
  principal_id TEXT PRIMARY KEY REFERENCES web_principals(id),
  model TEXT NOT NULL CHECK(model IN ('deepseek','gemini','xai')),
  notice TEXT CHECK(notice IS NULL OR notice IN ('model_withdrawn')),
  updated_at INTEGER NOT NULL
) STRICT;

-- Points are player fairness only; the money ledger (budget reservations) is independent of them.
CREATE TABLE web_points_balance (
  principal_id TEXT PRIMARY KEY REFERENCES web_principals(id),
  balance INTEGER NOT NULL CHECK(balance>=0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

-- Append-only: grant (the lazy initialisation), spend (charged at admission), refund (no reply / backup was cheaper).
-- balance == sum(grant) + sum(refund) - sum(spend); price_version names the price table the amount came from.
CREATE TABLE web_points_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  principal_id TEXT NOT NULL REFERENCES web_principals(id),
  operation_id TEXT REFERENCES web_operations(id),
  kind TEXT NOT NULL CHECK(kind IN ('grant','spend','refund')),
  reason TEXT NOT NULL CHECK(reason IN ('signup_bonus_init','reply','no_reply','backup_cheaper','no_voice')),
  points INTEGER NOT NULL CHECK(points>0),
  price_version INTEGER NOT NULL CHECK(price_version>0),
  created_at INTEGER NOT NULL,
  CHECK((kind='grant' AND operation_id IS NULL AND reason='signup_bonus_init') OR
        (kind='spend' AND operation_id IS NOT NULL AND reason='reply') OR
        (kind='refund' AND operation_id IS NOT NULL AND reason IN ('no_reply','backup_cheaper','no_voice')))
) STRICT;
CREATE INDEX web_points_events_principal ON web_points_events(principal_id,id);
-- A charge or a refund of one reason happens at most once per operation: replays and retries are no-ops.
CREATE UNIQUE INDEX web_points_events_once ON web_points_events(operation_id,kind,reason) WHERE operation_id IS NOT NULL;
CREATE UNIQUE INDEX web_points_events_grant_once ON web_points_events(principal_id) WHERE kind='grant';
CREATE TRIGGER web_points_events_no_update BEFORE UPDATE ON web_points_events
BEGIN SELECT RAISE(ABORT,'WEB_POINTS_EVENT_IMMUTABLE'); END;

-- One row per operation admitted with the feature on, frozen at admission (request immutability: switching the model
-- affects the NEXT message only). `chosen` is the model the player asked for; the draft/review columns record what really
-- wrote and reviewed the accepted reply (set once, at publication) for the stats and the chat-review view. Ids, enums and
-- counts only: no content, no principal id.
CREATE TABLE web_operation_models (
  operation_id TEXT PRIMARY KEY REFERENCES web_operations(id),
  chosen TEXT NOT NULL CHECK(chosen IN ('deepseek','gemini','xai')),
  voice INTEGER NOT NULL CHECK(voice IN (0,1)),
  points_charged INTEGER NOT NULL CHECK(points_charged>=0),
  price_version INTEGER NOT NULL CHECK(price_version>0),
  -- 1 once the points of this operation are settled (no reply: refunded in full; reply: backup/voice adjustment applied).
  settled INTEGER NOT NULL DEFAULT 0 CHECK(settled IN (0,1)),
  draft_provider TEXT CHECK(draft_provider IS NULL OR draft_provider IN ('deepseek','gemini','xai')),
  draft_model TEXT,
  review_provider TEXT CHECK(review_provider IS NULL OR review_provider IN ('deepseek','gemini','xai')),
  review_model TEXT,
  backup INTEGER NOT NULL DEFAULT 0 CHECK(backup IN (0,1)),
  created_at INTEGER NOT NULL,
  CHECK((draft_provider IS NULL) = (draft_model IS NULL) AND (review_provider IS NULL) = (review_model IS NULL))
) STRICT;

-- A model that a provider proved did not run the request (HTTP 429, documented overload, region/location not supported,
-- no key): its attempt was settled at zero and removed so the stage could be tried on the next model. One row per
-- abandoned attempt; the count of rows of (operation, phase) is also the generation of the shared budget reservation id.
CREATE TABLE web_provider_backups (
  operation_id TEXT NOT NULL REFERENCES web_operations(id),
  phase TEXT NOT NULL CHECK(phase IN ('draft','review')),
  generation INTEGER NOT NULL CHECK(generation>=0),
  provider TEXT NOT NULL CHECK(provider IN ('deepseek','gemini','xai')),
  model TEXT NOT NULL,
  code TEXT NOT NULL CHECK(length(code) BETWEEN 1 AND 81),
  held_micros INTEGER NOT NULL CHECK(held_micros>=0),
  abandoned_at INTEGER NOT NULL,
  PRIMARY KEY(operation_id,phase,generation)
) STRICT;
CREATE TRIGGER web_provider_backups_no_update BEFORE UPDATE ON web_provider_backups
BEGIN SELECT RAISE(ABORT,'WEB_PROVIDER_BACKUP_IMMUTABLE'); END;

-- Aggregate usage for the owner's stats (Part 22) and `pnpm usage:report`: one row per UTC day, provider, model and phase.
-- Global counters: no principal id, no operation id, no content. `cost_micros` is the cost at the provider's LIST price
-- (config in apps/server/generation/model-list-prices.ts), not the upper bound the budget ledger holds.
CREATE TABLE web_provider_usage (
  day TEXT NOT NULL CHECK(day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('draft','review','speech')),
  calls INTEGER NOT NULL DEFAULT 0 CHECK(calls>=0),
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK(input_tokens>=0),
  cached_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK(cached_input_tokens>=0),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK(output_tokens>=0),
  bytes INTEGER NOT NULL DEFAULT 0 CHECK(bytes>=0),
  cost_micros INTEGER NOT NULL DEFAULT 0 CHECK(cost_micros>=0),
  -- Replies (accepted or not) that these calls belong to: the divisor of the "average cost per reply" report.
  replies INTEGER NOT NULL DEFAULT 0 CHECK(replies>=0),
  PRIMARY KEY(day,provider,model,phase)
) STRICT;

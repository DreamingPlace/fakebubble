CREATE TABLE beta_cost_prices (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL, model TEXT NOT NULL, unit TEXT NOT NULL CHECK(unit IN ('tokens','utf8_bytes')),
  currency TEXT NOT NULL, valid_from INTEGER NOT NULL, valid_until INTEGER NOT NULL CHECK(valid_until>valid_from),
  input_hash TEXT NOT NULL, value_json TEXT NOT NULL CHECK(json_valid(value_json)), created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX beta_cost_prices_active ON beta_cost_prices(provider,model,unit,valid_from,valid_until);
CREATE TABLE beta_cost_budgets (
  id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, currency TEXT NOT NULL, starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL CHECK(ends_at>starts_at),
  value_json TEXT NOT NULL CHECK(json_valid(value_json))
) STRICT;
CREATE INDEX beta_cost_budgets_active ON beta_cost_budgets(owner_key,currency,starts_at,ends_at);
CREATE TABLE beta_cost_calls (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, input_hash TEXT NOT NULL,
  player_id TEXT REFERENCES beta_accounts(player_id), metering_id TEXT, world_id TEXT, conversation_id TEXT, character_id TEXT,
  function TEXT NOT NULL, task_id TEXT NOT NULL, stage TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
  price_id TEXT NOT NULL REFERENCES beta_cost_prices(id), currency TEXT NOT NULL,
  global_budget_id TEXT NOT NULL REFERENCES beta_cost_budgets(id), owner_budget_id TEXT NOT NULL REFERENCES beta_cost_budgets(id),
  state TEXT NOT NULL CHECK(state IN ('reserved','dispatched','unknown','finished','cancelled')),
  value_json TEXT NOT NULL CHECK(json_valid(value_json)), created_at INTEGER NOT NULL,
  CHECK((player_id IS NULL AND metering_id IS NULL AND world_id IS NULL AND conversation_id IS NULL) OR
    (player_id IS NOT NULL AND metering_id IS NOT NULL AND world_id IS NOT NULL AND conversation_id IS NOT NULL AND character_id IS NOT NULL))
) STRICT;
-- Frozen scope IDs deliberately do not reference resettable conversations/jobs/media.
CREATE INDEX beta_cost_calls_owner ON beta_cost_calls(player_id,currency,created_at,seq);
CREATE INDEX beta_cost_calls_task ON beta_cost_calls(task_id,stage);
CREATE TABLE beta_cost_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, call_id TEXT NOT NULL REFERENCES beta_cost_calls(id), request_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('observation','reconciliation','cancel')),
  input_hash TEXT NOT NULL, input_json TEXT NOT NULL CHECK(json_valid(input_json)), result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  created_at INTEGER NOT NULL, UNIQUE(call_id,request_id)
) STRICT;
CREATE INDEX beta_cost_events_call ON beta_cost_events(call_id,seq);
CREATE TABLE beta_cost_admin_receipts (
  request_id TEXT PRIMARY KEY, input_hash TEXT NOT NULL, result_json TEXT NOT NULL CHECK(json_valid(result_json)), created_at INTEGER NOT NULL
) STRICT;

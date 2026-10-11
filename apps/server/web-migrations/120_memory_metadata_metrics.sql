-- Part 16: daily counters for replies whose topics / factOps were invalid and were dropped (the reply itself was valid,
-- so it was delivered and no memory was stored for the turn). Metric only: the business object is the only writer,
-- and nothing here changes a quota, budget or provider state.
ALTER TABLE web_operation_metrics ADD COLUMN topics_dropped INTEGER NOT NULL DEFAULT 0 CHECK(topics_dropped IN (0,1));
ALTER TABLE web_operation_metrics ADD COLUMN facts_dropped INTEGER NOT NULL DEFAULT 0 CHECK(facts_dropped IN (0,1));

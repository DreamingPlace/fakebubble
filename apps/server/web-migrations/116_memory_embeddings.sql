-- Memory topic embeddings (semantic recall). The business object is the only writer; a provider never sees this
-- database. Only memory topics are embedded (key + latest episode summary); player facts always go into the prompt.

-- One vector per topic and model, scoped like every private memory row. `vector` is float32 little-endian
-- (dims*4 bytes). state 'unknown' marks a topic whose embedding call had an UNKNOWN outcome: it stays lexical-only
-- until its text changes (a new source_seq / content_hash is new work), and is never sent again as it is.
CREATE TABLE memory_embeddings (
  world_id TEXT NOT NULL, conversation_id TEXT NOT NULL, character_id TEXT NOT NULL,
  topic_key TEXT NOT NULL, model TEXT NOT NULL,
  dims INTEGER NOT NULL CHECK(dims BETWEEN 1 AND 4096),
  vector BLOB,
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64),
  -- rowid of the latest episode the text was built from: how a changed topic is recognised without hashing every topic
  source_seq INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('ready','unknown')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(world_id,conversation_id,character_id,topic_key,model),
  CHECK((state='ready' AND vector IS NOT NULL AND length(vector)=dims*4) OR (state='unknown' AND vector IS NULL)),
  FOREIGN KEY(world_id,conversation_id,character_id,topic_key)
    REFERENCES memory_topics(world_id,conversation_id,character_id,topic_key)
) STRICT;
CREATE INDEX memory_embeddings_scope ON memory_embeddings(world_id,conversation_id,character_id,model,state);

-- Every embedding provider call, written before it can be sent (phase 'embed'). It is the dispatch ledger of the
-- embedding calls: not_sent -> sent -> known | unknown. A known failure releases its hold; an UNKNOWN outcome keeps
-- the hold and is never retried. An 'index' call carries the topics it embeds (items_json, ids and hashes only,
-- cleared once resolved); a 'query' call is the reply-time embedding of one operation's input, at most one per
-- operation. The text and the vector of a query are never stored.
CREATE TABLE web_embed_attempts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('index','query')),
  phase TEXT NOT NULL DEFAULT 'embed' CHECK(phase='embed'),
  world_id TEXT NOT NULL, conversation_id TEXT NOT NULL, character_id TEXT NOT NULL,
  operation_id TEXT,
  model TEXT NOT NULL,
  texts INTEGER NOT NULL CHECK(texts BETWEEN 1 AND 16),
  max_units INTEGER NOT NULL CHECK(max_units>0),
  price_micros_per_million INTEGER NOT NULL CHECK(price_micros_per_million>0),
  held_micros INTEGER NOT NULL CHECK(held_micros>0),
  items_json TEXT CHECK(items_json IS NULL OR json_valid(items_json)),
  state TEXT NOT NULL CHECK(state IN ('not_sent','sent','unknown','known')),
  outcome TEXT CHECK(outcome IN ('succeeded','failed','not_dispatched')),
  usage_units INTEGER, charged_micros INTEGER, receipt_json TEXT,
  lease_expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL, sent_at INTEGER, settled_at INTEGER,
  CHECK((kind='query' AND operation_id IS NOT NULL) OR (kind='index' AND operation_id IS NULL)),
  CHECK((state='not_sent' AND sent_at IS NULL AND outcome IS NULL) OR
        (state IN ('sent','unknown') AND sent_at IS NOT NULL AND outcome IS NULL) OR
        (state='known' AND settled_at IS NOT NULL AND outcome IS NOT NULL AND usage_units IS NOT NULL AND
         charged_micros IS NOT NULL AND charged_micros<=held_micros))
) STRICT;
CREATE UNIQUE INDEX web_embed_attempts_query ON web_embed_attempts(operation_id) WHERE kind='query';
CREATE INDEX web_embed_attempts_open ON web_embed_attempts(state,kind);
CREATE INDEX web_embed_attempts_scope ON web_embed_attempts(world_id,conversation_id,character_id);

-- Per UTC day counters for the owner-only stage-latency view. No content, no scope.
CREATE TABLE web_embed_metrics (
  day TEXT PRIMARY KEY CHECK(day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  calls INTEGER NOT NULL DEFAULT 0 CHECK(calls>=0),
  texts INTEGER NOT NULL DEFAULT 0 CHECK(texts>=0),
  failures INTEGER NOT NULL DEFAULT 0 CHECK(failures>=0),
  unknowns INTEGER NOT NULL DEFAULT 0 CHECK(unknowns>=0),
  query_fallbacks INTEGER NOT NULL DEFAULT 0 CHECK(query_fallbacks>=0),
  query_timeouts INTEGER NOT NULL DEFAULT 0 CHECK(query_timeouts>=0)
) STRICT;

ALTER TABLE reply_items ADD COLUMN awaiting_player INTEGER NOT NULL DEFAULT 0 CHECK(awaiting_player IN (0,1));
ALTER TABLE reply_items ADD COLUMN clarified_by TEXT REFERENCES messages(id);

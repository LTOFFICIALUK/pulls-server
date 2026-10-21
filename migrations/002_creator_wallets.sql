ALTER TABLE coins ADD COLUMN IF NOT EXISTS creator_index integer;
ALTER TABLE launches ADD COLUMN IF NOT EXISTS creator text;
ALTER TABLE launches ADD COLUMN IF NOT EXISTS creator_index integer;

CREATE UNIQUE INDEX IF NOT EXISTS coins_creator_index_idx ON coins (creator_index) WHERE creator_index IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS launches_creator_index_idx ON launches (creator_index) WHERE creator_index IS NOT NULL;

CREATE TABLE IF NOT EXISTS creator_seq (
  id integer PRIMARY KEY CHECK (id = 1),
  next_index integer NOT NULL DEFAULT 0
);

INSERT INTO creator_seq (id, next_index) VALUES (1, 0) ON CONFLICT DO NOTHING;

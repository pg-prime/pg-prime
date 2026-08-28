-- vs current: the table's comment is REWORDED, the column's is REMOVED, the constraint's
-- and the index's are unchanged, and the sequence gains one. A removal is
-- `COMMENT ON … IS NULL`, which is the only spelling PostgreSQL has for it.

CREATE SCHEMA docs;
COMMENT ON SCHEMA docs IS 'the documented schema';

CREATE TYPE docs.tier AS ENUM ('free', 'pro');
COMMENT ON TYPE docs.tier IS 'subscription tier';

CREATE SEQUENCE docs.counter;
COMMENT ON SEQUENCE docs.counter IS 'a counter';

CREATE TABLE docs.notes (
  id   bigint NOT NULL,
  body text   NOT NULL,
  CONSTRAINT notes_pkey PRIMARY KEY (id),
  CONSTRAINT notes_body_ck CHECK (body <> '')
);
COMMENT ON TABLE docs.notes IS 'notes, after the edit';
COMMENT ON CONSTRAINT notes_body_ck ON docs.notes IS 'no empty bodies';

CREATE INDEX notes_body_idx ON docs.notes (body);
COMMENT ON INDEX docs.notes_body_idx IS 'body lookup';

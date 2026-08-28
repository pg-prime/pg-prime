-- `comment` as its own fact, keyed `[...targetIdentity, 'comment']` (`05` §7.2).
--
-- Every target class `06` §2.2 names is present, so the `pg_description` UNION and the
-- `COMMENT ON <object>` syntax table are both exercised end to end. The reason it is a
-- fact rather than a field: re-wording a comment must not perturb its target's content
-- hash, or every copy-edit reads as an `ALTER TABLE`.

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
COMMENT ON TABLE  docs.notes                IS 'notes, before the edit';
COMMENT ON COLUMN docs.notes.body           IS 'the body';
COMMENT ON CONSTRAINT notes_body_ck ON docs.notes IS 'no empty bodies';

CREATE INDEX notes_body_idx ON docs.notes (body);
COMMENT ON INDEX docs.notes_body_idx IS 'body lookup';

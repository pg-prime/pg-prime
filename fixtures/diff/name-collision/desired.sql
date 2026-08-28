-- Same two squatted names, and now both columns are NOT NULL.
--
-- The order matters and is part of the fixture: the CHECKs are created with the table, so
-- by the time `SET NOT NULL` runs the plain name is already taken and PostgreSQL 18 names
-- the NOT NULL constraints `t_a_not_null1` / `t_b_not_null1`.

CREATE TABLE public.t (
  a integer,
  b integer,
  CONSTRAINT t_a_not_null CHECK (a <> 0),
  CONSTRAINT t_b_not_null CHECK (b <> 0)
);

ALTER TABLE public.t ALTER COLUMN a SET NOT NULL;
ALTER TABLE public.t ALTER COLUMN b SET NOT NULL;

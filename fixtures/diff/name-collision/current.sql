-- `ChooseConstraintName`'s uniquifying suffix (design/11 §3 K3 item 2).
--
-- Both columns already carry a CHECK squatting on the name PostgreSQL would pick for
-- their NOT NULL constraint. On PG 15-17 the §3.5 lock-safe `SET NOT NULL` rewrite has to
-- INVENT a temporary CHECK name, and `<table>_<column>_not_null` is taken — so a blind
-- `makeObjectName` emits `constraint "t_a_not_null" for relation "t" already exists` and
-- the plan does not apply. The server's own rule appends the pass number to the LABEL:
-- `t_a_not_null1`.
--
-- On PG 18 the same squatting makes the column's real NOT NULL constraint `t_a_not_null1`,
-- which does NOT compare equal to `defaultNotNullName` and is therefore carried verbatim
-- as a user name. Both behaviours are exercised by the same pair of files, on the server
-- that has each.

CREATE TABLE public.t (
  a integer,
  b integer,
  CONSTRAINT t_a_not_null CHECK (a <> 0),
  CONSTRAINT t_b_not_null CHECK (b <> 0)
);

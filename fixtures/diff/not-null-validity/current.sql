-- `convalidated` on a `contype = 'n'` row — the gap `06` §3.3 AS BUILT named and this
-- fixture closes, plus §3.5 rows 4 and 5 (the lock-safe `SET NOT NULL`).
--
-- Catalog-gated, not version-gated, and the SAME pair of files runs on 15/16/17 and 18:
--
--  - on PG 18 `unvalidated.b` really is `NOT NULL … NOT VALID`, so the IR records
--    `notNullValidated: false` and the plan's job is to VALIDATE it. Before this field
--    existed, `attnotnull` was set either way and the two states read identically;
--  - on PG 15-17 the `ADD CONSTRAINT … NOT NULL … NOT VALID` below is a syntax error, so
--    the fixture keeps the column plainly NOT NULL there and what the plan exercises is
--    the CHECK-detour rewrite for `nullable.a`.
--
-- `nullable.a` is nullable on both servers and NOT NULL in DESIRED, which is the row-4 /
-- row-5 split: PG 18 gets `ADD CONSTRAINT … NOT NULL … NOT VALID` + `VALIDATE`, PG 15-17
-- gets `ADD CHECK (a IS NOT NULL) NOT VALID` -> `VALIDATE` -> `SET NOT NULL` ->
-- `DROP CONSTRAINT`.

CREATE TABLE public.nullable (
  id bigint NOT NULL PRIMARY KEY,
  a  integer
);

CREATE TABLE public.validated (
  id bigint  NOT NULL PRIMARY KEY,
  b  integer NOT NULL
);

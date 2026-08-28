-- Extensions, declare-only (`06` §2.2 Tier M: "created if absent, never dropped,
-- members projected out").
--
-- CURRENT has `citext` and a table whose column uses it. DESIRED adds `hstore` and a
-- column of that type, so the plan must emit `CREATE EXTENSION IF NOT EXISTS hstore`
-- BEFORE the `ADD COLUMN` that needs it — and must emit nothing at all for `citext`,
-- whose own objects (the type, its operators, its functions) are projected out of every
-- family through `pg_depend` `deptype = 'e'`.

CREATE EXTENSION citext;

CREATE TABLE public.accounts (
  id    bigint NOT NULL PRIMARY KEY,
  login public.citext NOT NULL
);

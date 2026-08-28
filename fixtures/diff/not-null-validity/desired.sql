-- vs current: `nullable.a` becomes NOT NULL (the §3.5 rewrite) and `validated.b` keeps
-- its NOT NULL but gains a USER-CHOSEN name, which on PG 18 is a catalog-only
-- `RENAME CONSTRAINT` and on PG 15-17 is nothing at all.

CREATE TABLE public.nullable (
  id bigint  NOT NULL PRIMARY KEY,
  a  integer NOT NULL
);

CREATE TABLE public.validated (
  id bigint  NOT NULL PRIMARY KEY,
  b  integer CONSTRAINT b_is_present NOT NULL
);

-- Composite types + `typeAttribute` — `06` §2.2 Tier M.
--
-- Two composites on purpose. `addr` is USED by a column, so it is only ever created and
-- never altered: PostgreSQL refuses `ALTER TYPE … {ADD,ALTER} ATTRIBUTE` while any table
-- column has the type, and `CASCADE` does not help (it reaches typed tables and nested
-- composites, not plain columns). `geo` is unused, which is the only shape in which the
-- ALTER paths are reachable at all.
--
-- The filter that matters here is invisible in the fixture: every table also owns a
-- `pg_type` row with `typtype = 'c'`, so an extractor that does not restrict composites
-- to `relkind = 'c'` gives `public.holder` a phantom twin whose `CREATE TYPE` PostgreSQL
-- rejects with "type already exists".

CREATE TYPE public.addr AS (
  street text,
  city   text
);

CREATE TYPE public.geo AS (
  lat numeric(9,6),
  lon numeric(9,6)
);

CREATE TABLE public.holder (
  id   bigint NOT NULL PRIMARY KEY,
  home public.addr
);

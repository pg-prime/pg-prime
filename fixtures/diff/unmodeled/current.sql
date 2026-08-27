-- Blind-spot fixture: this database and `desired.sql` differ ONLY in a storage
-- parameter, which `catalog/extract.ts` does not model. The differ therefore sees
-- no delta, the plan is empty, and the IR-based proof converges - which is exactly
-- the silent-loss class the pg_dump oracle exists to catch.
CREATE TABLE public.widgets (
  id    integer NOT NULL PRIMARY KEY,
  label text    NOT NULL
);

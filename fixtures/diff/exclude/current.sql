-- EXCLUDE constraints — `06` §2.2 Tier M, "opclass/operators verbatim".
--
-- `tstzrange` + `&&` is deliberate: it needs no extension, so the fixture proves the
-- EXCLUDE path itself rather than the extension path. The definition is whatever
-- `pg_get_constraintdef` says, character for character — reconstructing an operator list
-- from `pg_constraint.conexclop` is exactly the kind of re-modelling `06` §3.1 forbids.

CREATE TABLE public.bookings (
  id      bigint NOT NULL PRIMARY KEY,
  room    integer NOT NULL,
  during  tstzrange NOT NULL
);

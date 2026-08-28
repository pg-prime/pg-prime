-- Domains — `06` §2.2 Tier M, `05` §7.2's `domain` kind.
--
-- CURRENT has one domain with a single CHECK and no default; DESIRED alters every axis a
-- domain has (default, NOT NULL, the CHECK set) and adds a second domain used by a
-- column, so the type's dependency edge is exercised too.

CREATE DOMAIN public.email AS text
  CONSTRAINT email_has_at CHECK (VALUE LIKE '%@%');

CREATE TABLE public.people (
  id      bigint NOT NULL PRIMARY KEY,
  address public.email
);

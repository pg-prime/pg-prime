-- Dropping a uniqueness guarantee that a FOREIGN KEY on ANOTHER table binds to.
-- PostgreSQL refuses with "cannot drop constraint … because other objects depend
-- on it" unless the FK is dropped first, and nothing in the IR says so: the FK
-- depends on the referenced TABLE, not on the constraint that makes it unique.
--
-- The names are chosen so the ID sort puts the FK LAST: without a real dependency
-- edge the phase tie-break is a name sort, which would order these correctly here
-- by accident and hide the bug.

CREATE TABLE public.accounts (
  id    bigint NOT NULL,
  slug  text   NOT NULL,
  CONSTRAINT accounts_pkey PRIMARY KEY (id),
  CONSTRAINT accounts_slug_key UNIQUE (slug)
);

CREATE TABLE public.zones (
  id           bigint NOT NULL PRIMARY KEY,
  account_slug text   NOT NULL,
  CONSTRAINT zones_account_fkey FOREIGN KEY (account_slug) REFERENCES public.accounts (slug)
);

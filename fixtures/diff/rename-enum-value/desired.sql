-- DESIRED state: the same label, renamed to 'member', in the same ORDINAL POSITION.
--
-- Everything that named it names the new label, because PostgreSQL stores an enum
-- constant as the `pg_enum` row's oid and re-renders it from the current label — so
-- `ALTER TYPE … RENAME VALUE` is the whole migration: no default to rewrite, no CHECK to
-- re-add, no index to rebuild. That is what the plan has to come out as, and what the
-- `pg_dump` witness compares against.
--
-- The index keeps its old NAME on purpose (`memberships_user_idx`): a label rename is not
-- a column rename, so nothing about it should make an index look renamed.

CREATE TYPE public.member_role AS ENUM ('owner', 'member');

CREATE TABLE public.memberships (
  id   bigint             GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  role public.member_role NOT NULL DEFAULT 'member',
  CONSTRAINT memberships_role_ck CHECK (role <> 'member' OR id > 0)
);

CREATE INDEX memberships_user_idx ON public.memberships (id) WHERE role = 'member';

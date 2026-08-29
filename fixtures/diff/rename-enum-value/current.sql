-- design/05 §3.2/§5.1's `renamedValues` — an enum LABEL rename (design/12 F2, R16 witness).
--
-- CURRENT state: the label is called 'user', and three different DDL forms name it. A
-- label is not in `pg_depend`, so nothing here tells the differ that the 'user' about to
-- disappear and the 'member' about to arrive are the same value: without the annotation
-- this is a removed label plus an added one, which is EN102 (a reorder PostgreSQL cannot
-- express) or a DS104 type replacement that rewrites the table.

CREATE TYPE public.member_role AS ENUM ('owner', 'user');

CREATE TABLE public.memberships (
  id   bigint             GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  role public.member_role NOT NULL DEFAULT 'user',
  CONSTRAINT memberships_role_ck CHECK (role <> 'user' OR id > 0)
);

CREATE INDEX memberships_user_idx ON public.memberships (id) WHERE role = 'user';

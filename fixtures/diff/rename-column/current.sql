-- A column rename whose dependents are the hard part: an index whose stored
-- definition names the column, and a CHECK whose body contains the OLD name both as
-- an identifier and as a STRING LITERAL. A textual rewrite edits the literal too.

CREATE TABLE public.users (
  id         bigint NOT NULL,
  first_name text   NOT NULL,
  CONSTRAINT users_pkey PRIMARY KEY (id),
  CONSTRAINT users_name_ck CHECK (first_name <> 'first_name')
);

CREATE INDEX users_first_name_idx ON public.users (first_name);

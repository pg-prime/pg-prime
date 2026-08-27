CREATE TABLE public.users (
  id   bigint NOT NULL,
  name text   NOT NULL,
  CONSTRAINT users_pkey PRIMARY KEY (id),
  -- the literal is data, not an identifier: it must survive the rename verbatim
  CONSTRAINT users_name_ck CHECK (name <> 'first_name')
);

-- a freshly built database auto-names the index after the NEW column
CREATE INDEX users_name_idx ON public.users (name);

CREATE TABLE public.accounts (
  id    bigint NOT NULL,
  slug  text   NOT NULL,
  CONSTRAINT accounts_pkey PRIMARY KEY (id)
);

CREATE TABLE public.zones (
  id           bigint NOT NULL PRIMARY KEY,
  account_slug text   NOT NULL
);

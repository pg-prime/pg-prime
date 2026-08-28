CREATE EXTENSION citext;
CREATE EXTENSION hstore;

CREATE TABLE public.accounts (
  id    bigint NOT NULL PRIMARY KEY,
  login public.citext NOT NULL,
  tags  public.hstore
);

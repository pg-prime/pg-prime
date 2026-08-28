-- vs current:
--   addr           untouched — the negative control: a composite a column uses must not
--                  acquire a delta just because its neighbour did
--   geo.lat        numeric(9,6) -> double precision  (ALTER TYPE … ALTER ATTRIBUTE)
--   geo.altitude   added                             (ALTER TYPE … ADD ATTRIBUTE)
--   geo.lon        untouched
--   money_amount   a brand-new composite             (CREATE TYPE … AS (…))

CREATE TYPE public.addr AS (
  street text,
  city   text
);

CREATE TYPE public.geo AS (
  lat      double precision,
  lon      numeric(9,6),
  altitude integer
);

CREATE TYPE public.money_amount AS (
  amount   numeric(12,2),
  currency char(3)
);

CREATE TABLE public.holder (
  id   bigint NOT NULL PRIMARY KEY,
  home public.addr
);

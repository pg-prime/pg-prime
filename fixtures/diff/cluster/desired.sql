-- The three transitions, one per table plus the reverse of the first:
--
--   orders  : clustered on its PK  ->  clustered on a plain index   (CLUSTER ON)
--   events  : clustered on nothing ->  clustered on a plain index   (CLUSTER ON)
--   invoices: created already clustered                             (the create path)
--
-- `SET WITHOUT CLUSTER` is the same diff run the other way, which the corpus sweep does by
-- running this pair in both directions.

CREATE TABLE public.orders (
  id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at     timestamptz NOT NULL,
  status text NOT NULL
);
CREATE INDEX orders_at_idx ON public.orders (at);
ALTER TABLE public.orders CLUSTER ON orders_at_idx;

CREATE TABLE public.events (
  id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL
);
CREATE INDEX events_kind_idx ON public.events (kind);
ALTER TABLE public.events CLUSTER ON events_kind_idx;

CREATE TABLE public.invoices (
  id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  number text NOT NULL UNIQUE
);
ALTER TABLE public.invoices CLUSTER ON invoices_number_key;

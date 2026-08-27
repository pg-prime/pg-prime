-- Partitioning and inheritance: modelled by NOBODY in the spike, so they must be
-- reported rather than converge silently as plain tables (design/06 §2.2).

CREATE TABLE public.events (
  id       bigint NOT NULL,
  at       timestamptz NOT NULL,
  payload  text
) PARTITION BY RANGE (at);

CREATE TABLE public.events_2026 PARTITION OF public.events
  FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');

CREATE INDEX events_2026_at_idx ON public.events_2026 (at);

CREATE TABLE public.animals (
  id    bigint NOT NULL,
  name  text
);

CREATE TABLE public.dogs (
  breed text
) INHERITS (public.animals);

-- an ordinary table, which must still be extracted normally
CREATE TABLE public.plain (
  id bigint PRIMARY KEY
);

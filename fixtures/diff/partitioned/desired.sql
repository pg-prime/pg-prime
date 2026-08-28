-- DESIRED: a new partition is declared and the parent gains an index, which PostgreSQL
-- propagates to every partition. `events_2024` is simply absent — the adopt case: the
-- plan must contain no DROP for it and the proof must still converge.

CREATE TABLE public.events (
  id       bigint      NOT NULL,
  at       timestamptz NOT NULL,
  payload  text
) PARTITION BY RANGE (at);

CREATE TABLE public.events_2025 PARTITION OF public.events
  FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');

CREATE TABLE public.events_2026 PARTITION OF public.events
  FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');

CREATE INDEX events_at_idx ON public.events (at);

CREATE TABLE public.plain (
  id bigint PRIMARY KEY
);

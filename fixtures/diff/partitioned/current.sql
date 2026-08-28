-- Partitioning — Tier M since K3 (design/06 §2.2, "incl. partitioned parents &
-- partitions"; design/05 §7.2's `partitions({ unknown: 'adopt' })`).
--
-- CURRENT holds the parent and one declared partition; DESIRED adds a second partition
-- and an index on the parent, which PostgreSQL propagates to every partition.
--
-- The ADOPT case (a partition the desired state never mentions) is deliberately NOT here:
-- the D10 witness would correctly report the surviving partition as a difference, and a
-- fixture in the `strict` corpus is one that must dump identically. `test/kinds/
-- partition.test.ts` covers adoption directly instead, which is also where the assertion
-- belongs — "no DROP was planned" is a statement about the plan, not about a dump.

CREATE TABLE public.events (
  id       bigint      NOT NULL,
  at       timestamptz NOT NULL,
  payload  text
) PARTITION BY RANGE (at);

CREATE TABLE public.events_2025 PARTITION OF public.events
  FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');

-- an ordinary table in the same schema, which must be extracted normally
CREATE TABLE public.plain (
  id bigint PRIMARY KEY
);

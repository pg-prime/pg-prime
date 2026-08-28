-- `pg_index.indisclustered`, as `TablePayload.clusterOn` (`06` §2.2 Tier M).
--
-- The corpus found this one: AdventureWorks clusters all 68 of its tables on their primary
-- keys, `pg_dump` writes that as `ALTER TABLE … CLUSTER ON …`, and the IR modelled none of
-- it — so a baseline of AdventureWorks produced a database that dumped 68 statements short
-- while our own proof reported convergence. It lives on the TABLE rather than on the index
-- because the clustered index is usually a constraint's backing index, and `Q_INDEXES`
-- filters those out: an `IndexPayload.clustered` would have been blind to the common case.
--
-- `orders` starts clustered on its primary key and `events` on nothing.

CREATE TABLE public.orders (
  id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at     timestamptz NOT NULL,
  status text NOT NULL
);
CREATE INDEX orders_at_idx ON public.orders (at);
ALTER TABLE public.orders CLUSTER ON orders_pkey;

CREATE TABLE public.events (
  id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL
);
CREATE INDEX events_kind_idx ON public.events (kind);

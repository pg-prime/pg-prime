-- `default` as a fact of its own (`05` §7.2, `06` §2.2 Tier M).
--
-- A default change is not a column change: the four columns below each move exactly one
-- axis, so the deltas have to be `default` deltas and not `column` ones. The last is the
-- LK109 case — a VOLATILE default, which is the only kind that rewrites the table when
-- the column is added with it (`06` §3.4: `provolatile <> 'i'`, and a constant default
-- has used `attmissingval` since PG 11).

CREATE TABLE public.settings (
  id        bigint NOT NULL PRIMARY KEY,
  added     text   DEFAULT 'old',
  removed   text   DEFAULT 'going away',
  unchanged text   DEFAULT 'stable',
  generated integer GENERATED ALWAYS AS (id * 2) STORED
);

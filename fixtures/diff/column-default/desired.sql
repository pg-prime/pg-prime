-- vs current:
--   added      'old' -> 'new'        (SET DEFAULT — an `alter` on the `default` fact)
--   removed    dropped               (DROP DEFAULT — a `drop` of the `default` fact)
--   unchanged  untouched             (no delta at all: the near-miss control)
--   generated  untouched             (a GENERATION expression is NOT a default; it stays
--                                     on the column, because PostgreSQL cannot alter it)
--   fresh      new column, volatile default  (ADD COLUMN … DEFAULT, LK109 + rewrite)

CREATE TABLE public.settings (
  id        bigint NOT NULL PRIMARY KEY,
  added     text   DEFAULT 'new',
  removed   text,
  unchanged text   DEFAULT 'stable',
  generated integer GENERATED ALWAYS AS (id * 2) STORED
);

ALTER TABLE public.settings ADD COLUMN fresh double precision DEFAULT random();

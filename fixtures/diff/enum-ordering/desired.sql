-- Regression fixture #1 — DESIRED state.
--
-- The new label 'refunded' is used by FOUR different DDL forms, each of which
-- must land in a LATER transaction segment than the ALTER TYPE … ADD VALUE:
--   1. a changed column DEFAULT
--   2. a NEW column's DEFAULT
--   3. a partial index predicate
--   4. a CHECK constraint
-- pg_depend records a dependency on the TYPE, not on the label, so a plan that
-- orders on catalog edges alone has nothing to sort by — that is the bug.

CREATE TYPE public.order_status AS ENUM ('pending', 'paid', 'refunded');

CREATE TABLE public.orders (
  id          bigint              GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  status      public.order_status NOT NULL DEFAULT 'refunded',
  prev_status public.order_status NOT NULL DEFAULT 'refunded',
  CONSTRAINT orders_refund_ck CHECK (status <> 'refunded' OR prev_status <> 'refunded')
);

CREATE INDEX orders_refunded_idx ON public.orders (id) WHERE status = 'refunded';

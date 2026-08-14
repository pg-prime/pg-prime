-- Regression fixture #1 — the pg-delta enum-ordering bug (design/06 §1.3).
-- CURRENT state: the enum exists without the new label.

CREATE TYPE public.order_status AS ENUM ('pending', 'paid');

CREATE TABLE public.orders (
  id     bigint              GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  status public.order_status NOT NULL DEFAULT 'pending'
);

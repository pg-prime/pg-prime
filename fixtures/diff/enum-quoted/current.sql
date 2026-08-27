-- The §1.3 enum-ordering bug, spelled the way `pg_get_expr` actually spells it when
-- the type name needs quoting: `'refunded'::public."OrderStatus"`. The `evaluates`
-- edge used to be found only for all-bare or all-quoted spellings, so this variant
-- lost its commit boundary and applied as 55P04 "unsafe use of new value".

CREATE TYPE public."OrderStatus" AS ENUM ('pending', 'paid');

CREATE TABLE public.orders (
  id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  status public."OrderStatus" NOT NULL DEFAULT 'pending'
);

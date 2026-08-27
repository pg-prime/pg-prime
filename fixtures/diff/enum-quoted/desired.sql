CREATE TYPE public."OrderStatus" AS ENUM ('pending', 'paid', 'refunded');

CREATE TABLE public.orders (
  id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  status public."OrderStatus" NOT NULL DEFAULT 'refunded'
);

CREATE INDEX orders_refunded_idx ON public.orders (id)
  WHERE status = 'refunded'::public."OrderStatus";

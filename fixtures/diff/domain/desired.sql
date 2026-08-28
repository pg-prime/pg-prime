-- vs current:
--   email        gains a DEFAULT, a second CHECK, and drops nothing   (ALTER DOMAIN x3)
--   positive_qty is new, NOT NULL, with a CHECK                       (CREATE DOMAIN)
--   people.qty   is a new column of the new domain                    (ordering: the
--                domain must exist before the column that uses it)

CREATE DOMAIN public.email AS text
  DEFAULT 'nobody@example.com'
  CONSTRAINT email_has_at CHECK (VALUE LIKE '%@%')
  CONSTRAINT email_is_lower CHECK (VALUE = lower(VALUE));

CREATE DOMAIN public.positive_qty AS integer
  NOT NULL
  CONSTRAINT positive_qty_gt0 CHECK (VALUE > 0);

CREATE TABLE public.people (
  id      bigint NOT NULL PRIMARY KEY,
  address public.email,
  qty     public.positive_qty
);

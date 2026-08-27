-- `serial` / `bigserial`: the ordering trap.
--
-- A serial column is THREE catalog objects that reference each other in a cycle if you
-- model ownership as part of CREATE SEQUENCE: the sequence, the column's DEFAULT
-- nextval() (which needs the sequence to exist) and `OWNED BY` (which needs the column
-- to exist). Emitting `CREATE SEQUENCE … OWNED BY t.id` orders the table first and the
-- plan dies with `relation "tickets_id_seq" does not exist`.

CREATE TABLE public.tickets (
  id      serial PRIMARY KEY,
  code    text NOT NULL
);

CREATE TABLE public.audits (
  id      bigserial PRIMARY KEY,
  ticket  integer NOT NULL REFERENCES public.tickets (id),
  note    text
);

CREATE INDEX audits_ticket_idx ON public.audits (ticket);

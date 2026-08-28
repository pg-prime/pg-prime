-- Classic table INHERITANCE — the one relation shape that is still NOT modelled
-- (design/06 §2.2 lists partitioning as Tier M; `INHERITS` is on no tier at all).
--
-- Its own fixture, and deliberately NOT in the corpus sweep: extraction must report an
-- error diagnostic for it, and the corpus's first assertion is that there are none.
-- `test/catalog.test.ts` is what reads this file.

CREATE TABLE public.animals (
  id    bigint NOT NULL,
  name  text
);

CREATE TABLE public.dogs (
  breed text
) INHERITS (public.animals);

-- an ordinary table, which must still be extracted normally
CREATE TABLE public.plain (
  id bigint PRIMARY KEY
);

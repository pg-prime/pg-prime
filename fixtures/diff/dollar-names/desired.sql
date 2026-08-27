-- `$` is a legal identifier character, and `$&`, `$'`, `` $` `` and `$$` are all
-- JS String.replace REPLACEMENT patterns. The index emitter used a replacement
-- STRING, so these names expanded instead of being inserted.

CREATE TABLE public.t (
  a integer NOT NULL,
  b integer NOT NULL
);

CREATE INDEX "idx$&x"   ON public.t (a);
CREATE INDEX "idx$$z"   ON public.t (b);
CREATE INDEX "idx$'q"   ON public.t (a, b);
CREATE INDEX "x%ID%y"   ON public.t (b, a);

-- Index storage parameters and expression keys — design/01 row 50, design/14 G.
--
-- `IndexPayload.definition` is `pg_get_indexdef`, and `ruleutils.c` prints BOTH of these
-- into it (`WITH (fillfactor='70')` from `flatten_reloptions`, the deparsed expression from
-- `deparse_expression`). So the differ has always been able to see them and the DSL could
-- not say either — a fact that is diffed and cannot be declared is a fact the first
-- generated migration drops, which is the rule design/12 K4 states for `clusterOn`.
--
-- Note the contrast with `fixtures/diff/unmodeled`, which is the negative control: a TABLE's
-- storage parameter is not modelled and must stay that way, so this fixture moves an INDEX's
-- and the blind-spot fixture keeps moving a table's.

CREATE TABLE public.docs (
  id    bigint NOT NULL PRIMARY KEY,
  email text   NOT NULL,
  body  text   NOT NULL
);

CREATE INDEX docs_body_idx  ON public.docs (body) WITH (fillfactor = 70);
CREATE INDEX docs_email_idx ON public.docs (email);

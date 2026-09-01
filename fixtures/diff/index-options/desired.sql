-- vs current: `docs_body_idx` changes only its `fillfactor` — an index PostgreSQL cannot
-- ALTER, so the plan is DROP + CREATE and the fixture proves the differ noticed at all —
-- and `docs_email_idx` is replaced by a UNIQUE partial index over an EXPRESSION.

CREATE TABLE public.docs (
  id    bigint NOT NULL PRIMARY KEY,
  email text   NOT NULL,
  body  text   NOT NULL
);

CREATE INDEX docs_body_idx ON public.docs (body) WITH (fillfactor = 90);
CREATE UNIQUE INDEX docs_email_lower_idx ON public.docs (lower(email)) WHERE (body <> '');

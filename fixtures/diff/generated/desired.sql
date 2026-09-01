-- vs current: `legacy_total` is dropped and `total` added, so `ADD COLUMN … GENERATED
-- ALWAYS AS (…) STORED` and `DROP COLUMN` on a generated one are both on the wire; and a
-- second table arrives WITH a generated column already in it, which is the other branch —
-- `columnClause` inside `CREATE TABLE` rather than inside `ALTER TABLE ADD COLUMN`.
--
-- One added column per table, deliberately. Two would also converge, but sibling `add`
-- deltas are ordered by NAME (`diff/diff.ts` sorts on the encoded id) rather than by the
-- desired `attnum`, so the migrated table's column order would differ from the desired
-- one and the D10 witness would classify it as `reordered` — a difference this fixture is
-- not about. Recorded in design/14 §G's RESULT.

CREATE TABLE public.invoices (
  id       bigint         NOT NULL PRIMARY KEY,
  price    numeric(12,2)  NOT NULL,
  quantity integer        NOT NULL,
  total    numeric(14,2)  GENERATED ALWAYS AS (price * quantity) STORED
);

CREATE TABLE public.tags (
  id   bigint NOT NULL PRIMARY KEY,
  name text   NOT NULL,
  slug text   GENERATED ALWAYS AS (lower(name)) STORED,
  CONSTRAINT tags_slug_key UNIQUE (slug)
);

-- Stored generated columns — design/01 row 51, design/14 G.
--
-- `ColumnPayload.generationExpr` has been modelled since design/11 K3, but nothing could
-- DECLARE one, so no fixture reached `columnClause`'s `GENERATED ALWAYS AS (…) STORED`
-- branch. This pair does, in both directions: `legacy_total` is dropped and two are added.
--
-- Deliberately not an in-place CONVERSION. PostgreSQL offers `DROP EXPRESSION` (stored →
-- plain) and nothing at all for plain → stored, so `alterColumn` refuses an `attgenerated`
-- transition with an `unsupported_alter` error — and the corpus sweep asserts there are no
-- error diagnostics, which is exactly how that refusal stays visible.
--
-- Every expression here is IMMUTABLE, which PostgreSQL requires of a generation
-- expression: `numeric * integer` and `int8out` both are, while a `timestamptz::date` cast
-- reads the session's TimeZone and is not.

CREATE TABLE public.invoices (
  id           bigint         NOT NULL PRIMARY KEY,
  price        numeric(12,2)  NOT NULL,
  quantity     integer        NOT NULL,
  legacy_total numeric(14,2)  GENERATED ALWAYS AS (price * quantity) STORED
);

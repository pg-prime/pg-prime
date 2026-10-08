---
'pg-prime': minor
'@pg-prime/kit': minor
---

**Column collations: `.collate(name)`.**

`t.text().collate('C')` declares `position text COLLATE "C"`, the byte-order collation a
fractional-index `position` column needs. `.collate()` is available on `text`, `varchar`, `citext`,
their arrays and `t.raw()` columns. On any other type it is a compile error that says why. On an
enum column it throws a `SchemaError` when the schema is declared. The collation is recorded as
`ColumnDdl.collation`.

`migrate generate` now handles a collation change on an existing column as its own case. Adding,
changing or removing a collation plans `ALTER TABLE … ALTER COLUMN … TYPE <same type> [COLLATE "…"]`
with the new warning **`LK113`**: the column's indexes are rebuilt under `ACCESS EXCLUSIVE`, but the
table is not rewritten. Before this release, a collation-only change was reported as a narrowing
type change (`MF105`, an error) together with `LK108` and `BC103`. A change of type keeps those
three hazards.

`pull` now emits `.collate("C")` for a column with a non-default collation. Before, it listed the
column under `-- pull: unsupported`.

The collation name is a single identifier. A collation in a schema other than `pg_catalog` cannot be
named yet.

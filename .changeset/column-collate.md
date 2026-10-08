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

When a unique index, a primary key, a unique or exclusion constraint, or a `CHECK` covers the column,
the statement also carries the new error **`MF107`**: rebuilding the index or re-checking the
constraint under the new collation can fail on existing rows, such as `'a'` and `'A'` under a
case-insensitive collation. It is not raised on a table proven empty.

`pull` now emits `.collate("C")` for a column with a `pg_catalog` collation. Before, it listed the
column under `-- pull: unsupported`. A column whose collation lives in another schema stays listed
there.

The collation name is a single identifier and must name a `pg_catalog` collation: migrations run
under `search_path = pg_catalog`, so a collation created in another schema does not resolve.

**Upgrading a 0.1.0 migration history:** the catalog extractor now records a collation outside
`pg_catalog` as `"schema"."name"`, so a managed column that already uses one fingerprints
differently and the next `migrate apply` stops with `fingerprint_mismatch`. If your managed schemas
use such a collation, re-baseline once after upgrading (`pg-prime migrate baseline --force`).
Columns with `pg_catalog` collations, or none, are unaffected.

---
'pg-prime': minor
---

The DDL close-out — design/01 §3 rows **49** (`EXCLUDE` constraints), **50** (index expression
keys, `WITH`, `TABLESPACE`, `.concurrently()`), **51** (generated columns) and **54** (`COMMENT ON`
for types). Four spellings the feature table promised for v1 and the DSL could not say:

- `exclude('no_overlap').using('gist').where(sql\`…\`).on([t.during, '&&'])`, with
  `.deferrable()` / `.initiallyDeferred()` and `.requires(extension)`. `.on(...)` is terminal, as
  it is for `index` and `unique`.
- `.generatedAlwaysAs(expr, { stored })` — a fragment or a `(cols) => fragment` callback, resolved
  by `pgTable` once the column names are known. `ro: true`, so the key is **erased** from
  `Insertable` and `Updateable` exactly as `.generatedAlways()` erases an identity column's;
  `metaOf().insertableKeys` is the runtime half, so `copyFrom`'s default column list drops it too.
  `STORED` only: `{ stored: false }` (PostgreSQL 18's `VIRTUAL`) is a compile error carrying the
  reason, because a generated column cannot be converted in place in either direction.
- `index('i').on(sql\`lower(email)\`)` expression keys, `.with({ … })`, `.fillfactor(n)`,
  `.tablespace(name)` and `.concurrently(false)` — the per-index opt-out from the lock-safe
  `CREATE INDEX CONCURRENTLY` rewrite.
- a `comment` option on `pgEnum` and `pgDomain`.

Two smaller behaviour changes fall out. `copyFrom` refuses an explicit `{ columns }` naming a
stored generated column with a `UsageError` carrying `42P10` — the same refusal PostgreSQL makes,
one round trip earlier and with the column named; an identity column may still be named, because
`COPY` writes the value you give it and that is what makes a restore possible. And `IndexItem`
gains `expression` beside `column`, which widens `column` to `string | undefined`.

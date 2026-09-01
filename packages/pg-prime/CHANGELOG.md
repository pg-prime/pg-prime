# pg-prime

## 0.1.0

### Minor Changes

- [`2655664`](https://github.com/pg-prime/pg-prime/commit/2655664ba433821176d790d4baf2608fb3f26fb3) Thanks [@YohoCX](https://github.com/YohoCX)! - Extension types — `definePgType()`, `citext`, `vector(n)` and pgvector's six distance operators
  (design/01 §3 rows 44-`citext`, 61 and 62).
  
  An extension type differs from a built-in in exactly one way: `CREATE EXTENSION` allocates its OID
  per database, so no codec may bake the number in. That is the same fact that makes an enum's OID
  per-database, and it now takes the same mechanism —
  `registry.resolveDynamic(conn, [{ name: 'vector', kind: 'base' }])` reads it out of `pg_type` once
  per physical database, pending-codec window included.
  
  - **`definePgType({ name, schema?, encode, decode, typeClass?, arrayOf? })`** builds the codec. A
    third party adds `hstore` or `postgis.geometry` with three lines and no fork. Everything a codec
    needs and the descriptor does not carry is derived: `oid`/`paramOid` are `undefined` until
    resolution, and `jsonEncode` is `'text'` so the value five relations deep is by construction the
    same string `decode` reads at the top level.
  - **`t.citext()`** and **`t.vector(n)`** ship as its reference users, in the core package.
    `citext` reads as `string` and gates on every text operator; `vector` reads as `number[]`, and the
    dimension is DDL exactly as `varchar(n)`'s length is. `vector[]` works, and is two vectors rather
    than a two-dimensional array of numbers.
  - **`l2` `<->`, `cosine` `<=>`, `innerProduct` `<#>`, `l1` `<+>`, `hamming` `<~>`, `jaccard` `<%>`**
    come off design/03 §2.9's deferred list. All six return `float8`, confirmed against a live
    `RowDescription`; the first four take a `vector` and the last two a `bit`, which is what pgvector
    0.8 declares. `orderBy(asc(cosine(t.embedding, query)))` over an HNSW index is asserted end to end.
  - A **typmod is not a type**: a column declared `vector(1536)` — or `t.raw('varchar(50)')`, which
    used to have no codec at all — now resolves to the `vector` and `varchar` codecs.
  
  PGlite has no pgvector and neither do the CI images, so the suites that need it guard on
  `PG_PRIME_TEST_VECTOR_URL` and on `pg_available_extensions`, and say what is unverified when they
  skip.

- [`21d2e66`](https://github.com/pg-prime/pg-prime/commit/21d2e66a332ffa47aba3fce5f8530706af673615) Thanks [@YohoCX](https://github.com/YohoCX)! - The DDL close-out — design/01 §3 rows **49** (`EXCLUDE` constraints), **50** (index expression
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

- [`36dff23`](https://github.com/pg-prime/pg-prime/commit/36dff2302e3747dd1c6a46b96fcb20cfe37263a6) Thanks [@YohoCX](https://github.com/YohoCX)! - First release of the fixed `pg-prime` / `@pg-prime/kit` pair: a PostgreSQL-only, zero-dependency,
  ESM-only TypeScript ORM — schema DSL, `sql` tag, typed query builder with relations, codec
  registry and a structural driver seam — together with the migration engine behind the `pg-prime`
  CLI, which diffs a live catalog against the schema you wrote, proves the plan on a shadow clone
  and applies it under an advisory lock.
  
  Pre-alpha, and the API will change: this is `0.x`, breaking changes land in a minor and never in a
  patch, and the closed 1.0 checklist is `design/08-architecture.md` §6.2.

- [`c530947`](https://github.com/pg-prime/pg-prime/commit/c530947c9c0317560bac4754119930ff7689e8e7) Thanks [@YohoCX](https://github.com/YohoCX)! - **Views and materialized views as typed read-only entities** — design/01 §3 row 58.
  
  `pgView('active_users').columns((t) => ({ id: t.bigint(), email: t.text() })).as(sql`…`)` declares a
  view; `.existing()` declares one the database already has and you do not manage;
  `pgMaterializedView(...)` adds `.withNoData()` and `.refreshable({ concurrently })`. Options are
  `.with({ securityInvoker, securityBarrier, checkOption })` — **`securityInvoker` is `true` by
  default**, so a view reads with the caller's privileges and RLS policies unless the declaration
  deliberately says otherwise — plus `.comment()`, `.renamedFrom()` and `.dependsOn(…)`.
  
  The declared columns are the entity's type. `db.from(activeUsers)` is a FROM source with exact
  column types, exact codecs and the full operator vocabulary, and it joins a table in either
  direction — a subquery or a CTE cannot do that, because neither carries a declared PostgreSQL type
  per column. The value a builder returns **is** a handle, so there is no `db.h.activeUsers` and a
  view does not go into `defineSchema(...)`: a view has no relations for the registry to add and no
  insert shape to offer.
  
  `insertInto(view)`, `update(view)` and `deleteFrom(view)` are compile errors, and the diagnostic is
  one line that names the view and says what to do instead:
  
  ```
  Property 'values' does not exist on type 'OrmTypeError<"insertInto() takes a table:
    \"active_users\" is a view and is read-only — write to the table it selects from, or add an
    INSTEAD OF trigger through the sql/ lane">'.
  ```
  
  `db.refreshMaterializedView(mv, { concurrently? })` is on every handle, next to `copyFrom` and for
  the same reason: `REFRESH MATERIALIZED VIEW` is transaction-safe (`CONCURRENTLY` included), so the
  common shape is a refresh inside the transaction that also writes the audit row. It goes through the
  statement path, so it appears in the query log with the exact text that reached the server, and
  `concurrently` without the unique index PostgreSQL requires is the server's `55000`, mapped and
  rethrown — never a quiet downgrade to a blocking refresh.
  
  Not built, deliberately: `pgView('v').as((q) => …)` with columns inferred from a builder query, and
  structured diffing of a view definition. A view body is a hashed repeatable in the `sql/` lane in
  v1 — that is design/01 §3's lane decision, and it is why pg-prime has no phantom view diffs.
  
  Pre-alpha, and the API will change: this is `0.x`, breaking changes land in a minor and never in a
  patch.

### Patch Changes

- [`faf2f01`](https://github.com/pg-prime/pg-prime/commit/faf2f013fde077c2ff819c5d5ecbf61a7069e691) Thanks [@YohoCX](https://github.com/YohoCX)! - Five error classes now declare the literal `code` types the reference always documented:
  `UniqueViolationError` `'23505'`, `QueryCanceledError` `'57014'`, `InFailedTransactionError`
  `'25P02'`, `IndeterminateCommitError` `'INDETERMINATE_COMMIT'`, `CodecMismatchError`
  `'CODEC_MISMATCH'`. Type-level only (`declare`); nothing changes at runtime.

# pg-prime

## 0.2.6

## 0.2.5

### Patch Changes

- [#19](https://github.com/pg-prime/pg-prime/pull/19) [`2993a2b`](https://github.com/pg-prime/pg-prime/commit/2993a2b2552aba0837d23f731a231a364f1254bc) Thanks [@YohoCX](https://github.com/YohoCX)! - - **`char(n)` columns no longer truncate to one character.** `t.raw('char(10)')`, `t.raw('char')` and `t.raw('character(n)')` resolved to the one-byte internal `"char"` codec (OID 18), so every bound value was cut to its first character with no error; `bpcharCodec` also cast as `::char` (= `char(1)`) on the first row of `valuesMany`, in `unnest` bulk inserts and in policy DDL binds. They now resolve to `bpchar` and cast as `::bpchar`. `t.raw()` also understands the other `format_type` spellings (`character varying(n)`, `bit varying(n)`, `double precision`, `timestamp with time zone`, …). Only `t.raw('"char"')` is the one-byte type.
  - A relation or `nest()` with more than 50 members executes instead of failing with `54023 cannot pass more than 100 arguments to a function`: the object is built in chunks of 50 — `json_build_object` pieces spliced as text for the default `json` variant (key order, duplicate keys and `\u0000` survive), `jsonb_build_object || …` for `jsonb`.
  - An invalid escape in a `sql` template (`'\xZZ'`) is refused with `InvalidFragmentError` naming the hole, instead of silently deleting the rest of the statement.
  - A top-level projection key over 63 UTF-8 bytes compiles with a generated alias, like a nested one already did, instead of being rejected as an over-long identifier; the decoded key is unchanged.
  - `timestamptz` decoding no longer runs a regex and allocates two `Date`s per cell; same accepted spellings, same values.

- [#14](https://github.com/pg-prime/pg-prime/pull/14) [`680ae09`](https://github.com/pg-prime/pg-prime/commit/680ae0944dc001e12d5779bfb8f03edd71e9db62) Thanks [@YohoCX](https://github.com/YohoCX)! - - A backend that goes away mid-statement is a `ConnectionTerminatedError` as documented: a class `08` SQLSTATE from the server (PgBouncer's `08P01`, `08006`) or a fatal `57P01` that took the socket with it. Before, those mapped to `UnknownQueryError` and `OperatorInterventionError`, so `instanceof ConnectionError` was false for a dead backend. A `57P01` on a connection that survived is still `OperatorInterventionError`.
  - A `log.sink` that throws no longer rejects the statement it was logging; it is disabled and reported once on `console.error`, the same policy hooks have.
  - An `async` hook that rejects is disabled and reported instead of becoming an unhandled rejection.
  - `hooks: {}` registers nothing, so statements skip the event path.
  - A constraint violation resolves against the table the server named, so two tables sharing a constraint name (`email_key` on both, or a `CHECK` with the same name) no longer resolve to whichever table was declared first. `constraint.referencedTable` is now set for foreign keys.
  - `errors.captureCallSite` no longer elides frames from an application whose own files live under `src/query/`, `src/session/` and the like: only pg-prime's own frames are skipped.
  - `db.diagnose()` is one round trip, as documented, and `connections.inUse` counts client backends only (background workers never occupy a `max_connections` slot).
  - `PgPrimeErrorCode` includes `'TIMEOUT'`, `'ABORT'` and `'INDETERMINATE_COMMIT'`, the codes `QueryTimeoutError`, `AbortError` and `IndeterminateCommitError` carry.

- [#15](https://github.com/pg-prime/pg-prime/pull/15) [`577fca6`](https://github.com/pg-prime/pg-prime/commit/577fca6c5706c01b43e4ea7dfa0912fe0a2ded08) Thanks [@YohoCX](https://github.com/YohoCX)! - Bulk insert, prepared queries and `db.sql` hardening:
  
  - `valuesMany` with the `values` strategy now caps each chunk so `rows × columns` (plus any binds in `ON CONFLICT`/`RETURNING`) stays under the 65 535-parameter wire ceiling. A wide table — or one with an array column, where `unnest` is unavailable — chunks below 5 000 rows instead of failing with `TooManyParametersError`.
  - `PreparedQuery.execute()` refuses an `undefined` placeholder value the same way it refuses a missing key, instead of binding SQL NULL and silently matching nothing. `null` still binds NULL.
  - `onConflict().doUpdate()` throws when the patch leaves nothing to set (every key `undefined`) instead of compiling to invalid `do update set` SQL; use `doNothing()`.
  - `` db.sql`…` `` refuses a `placeholder()` at the tag instead of binding it as NULL.
  - Insert rows are snapshotted at `.values()`/`.valuesMany()` time; mutating the row object afterwards no longer changes what is inserted.
  - `InsertQuery.toSQL()` and `.explain()` no longer throw on a chunked batch; they describe its first chunk (`compileAll()` has the rest).
  - Relation `some()`/`none()` evaluate a declared `where` once per use rather than twice.

- [#18](https://github.com/pg-prime/pg-prime/pull/18) [`c5aa0c4`](https://github.com/pg-prime/pg-prime/commit/c5aa0c43043cb995cf528ae6028f26b00c4b000a) Thanks [@YohoCX](https://github.com/YohoCX)! - Session, savepoint, LISTEN and timeout fixes.
  
  - `Session.transaction()` now honours every `TxOptions` field (`retry`, `timeoutMs`, `lockTimeoutMs`, `localSettings`, `signal`) and emits the transaction hooks, exactly like `db.transaction()`. Before, `localSettings` was silently dropped, so an RLS tenant set this way never reached the server.
  - Savepoint `timeoutMs` / `lockTimeoutMs` / `localSettings` end with the savepoint: the previous values are put back after `RELEASE SAVEPOINT` instead of leaking to the rest of the transaction, and a timeout changed inside a savepoint is restored by the parent.
  - `copyFrom` / `copyTo` are exempt from the session `statement_timeout` as documented, on `db`, `Tx` and `Session` handles; a stream on a `Session` gets a transaction of its own as well.
  - `BEGIN` / `COMMIT` / `SAVEPOINT` / `set_config` failures are mapped like any other statement: a deferred FK violation raised at a chunked insert's `COMMIT` is a `ForeignKeyViolationError`, a `SAVEPOINT` refused with `25P02` is an `InFailedTransactionError` naming the poison.
  - A chunked batch under `timeoutStrategy: 'transaction'` sets `statement_timeout` once after `BEGIN` instead of losing the timeout.
  - A transaction's `signal` composes with `pgPrime({ signal })` at checkout, and an abort landing between the last statement and `COMMIT` rolls back with `AbortError`.
  - `tx.rollbackWith(v)` on the outer handle inside a savepoint resolves the transaction with `v` instead of being swallowed by the savepoint.
  - `timeoutMs` must be a positive integer; `0` and non-integers are a `UsageError` on every handle (`lockTimeoutMs: 0` stays valid).
  - An already-aborted `signal` combined with `timeoutMs` no longer runs the statement.
  - `Session.set()` and a session advisory lock still held at exit dispose the connection so the state cannot reach the next borrower; a callback that throws on a healthy connection returns it to the pool.
  - `db.listen()`: two concurrent first subscriptions attach one set of listeners (handlers fired twice per NOTIFY before); a `subscribe()` landing during a reconnect shares the reopen instead of producing a second live connection; a `LISTEN` failing during reconnect closes that connection; a `LISTEN` that fails in `subscribe()` is mapped and leaves no half-registered channel; `db.end()` during a reconnect closes the late socket; the pg adapter's `connect()` refuses after `destroy()`.
  - A stream, COPY or `timeoutStrategy: 'transaction'` statement on a `Session` inside a transaction the caller opened by hand joins it, honours `statementTimeoutMs`, and puts the previous `statement_timeout` back afterwards instead of leaving a `SET LOCAL` on the caller's block. An adapter that cannot report `transactionStatus` gets no `BEGIN`/`COMMIT` from pg-prime at all.
  - A chunked insert on a `Session` runs in one transaction, like on `db`.
  - COPY opens a transaction only when there is a session `statement_timeout` to lift; otherwise it is the one statement it was.
  - A `Session` callback that throws while a statement is still in flight, or whose connection status cannot be read, disposes the connection; `tx.copyFrom` on an escaped or abandoned `Tx` throws before touching the connection.

## 0.2.4

## 0.2.3

### Patch Changes

- [#9](https://github.com/pg-prime/pg-prime/pull/9) [`ae10bcb`](https://github.com/pg-prime/pg-prime/commit/ae10bcb575712c41afbc5831ddac66ec2da6d105) Thanks [@YohoCX](https://github.com/YohoCX)! - - `t.jsonb().nullable().$type<T>()` keeps its `| null` on read, insert and update, the same as `t.jsonb().$type<T>().nullable()`. `unknown | null` collapses to `unknown`, so `.nullable()` on a `jsonb` column now records the null in the column meta, and `$type` and `array` read it from there.
  - `.values([...])` with an array throws `.values() takes one row; pass an array of rows to .valuesMany().` instead of `names column(s) [0, 1]`.

## 0.2.2

### Patch Changes

- [#7](https://github.com/pg-prime/pg-prime/pull/7) [`820c13e`](https://github.com/pg-prime/pg-prime/commit/820c13e80fff4e7e010dcde70af06edabaab82db) Thanks [@YohoCX](https://github.com/YohoCX)! - A key whose value is `undefined` now counts as absent in every `.values()`, `.valuesMany()` and `.set()`, as the docs say. Before, only a column with a `$default` got that treatment: anywhere else, `undefined` reached the codec and threw `PgEncodeError`, for example `cannot encode a UUID string as uuid (got undefined)` on a nullable uuid. A bulk insert where `undefined` makes the rows set different columns is refused, and the message suggests `null`.

## 0.2.1

## 0.2.0

### Minor Changes

- [#3](https://github.com/pg-prime/pg-prime/pull/3) [`a75e3a1`](https://github.com/pg-prime/pg-prime/commit/a75e3a19a2e9f615acdbc1d9e240bfc81bf9e9dd) Thanks [@YohoCX](https://github.com/YohoCX)! - **Column collations: `.collate(name)`.**
  
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

- [#3](https://github.com/pg-prime/pg-prime/pull/3) [`6a7ed8e`](https://github.com/pg-prime/pg-prime/commit/6a7ed8e4f9e63e3437400848c0b743dad71a9708) Thanks [@YohoCX](https://github.com/YohoCX)! - **`migrateOwnedSchema()` and `ownedSchemaSql()`: versioned DDL for a schema a package owns.**
  
  `migrateOwnedSchema(db, { schema, migrations })` applies each missing version in its own
  transaction under `pg_advisory_xact_lock`, so concurrent migrators and transaction poolers are
  safe. It keeps a ledger in `<schema>.migrations` and refuses a checksum mismatch or a schema whose
  `min_client` is newer than the client. It returns `{ from, to }`; `apply: false` only reads and
  checks. `ownedSchemaSql()` emits the same versions as SQL files, ending in an idempotent ledger
  insert, for vendoring into kit migrations. The `@pg-prime/*` add-ons build their schemas on it.
  
  **`db.listen()`: every subscription gets its own `gap`, `reconnect` and `error`.** Before this
  release a second subscription on the same channel replaced the first one's handlers, so only the
  latest subscriber heard about a reconnect. Each subscription now has its own handlers, a throwing
  notification handler reports to its own subscription's `error`, and closing one subscription
  removes only its handlers.

- [#3](https://github.com/pg-prime/pg-prime/pull/3) [`60b99c8`](https://github.com/pg-prime/pg-prime/commit/60b99c86c94d5a720682e775f32913e0a1c7ce31) Thanks [@YohoCX](https://github.com/YohoCX)! - **Typed row-level security policies, setting keys and an `updated_at` trigger.**
  
  - `definePolicy(name, { on, for, as, to, using, withCheck })` declares a `CREATE POLICY`. The
    predicates are thunks over the table's columns, typed like query predicates. Every column renders
    qualified by its table name, so a subquery cannot capture it, and values render as typed literals.
    `@pg-prime/kit` writes declared policies into the `sql/` repeatable lane.
  - `rls.enable()` / `rls.force()` table extras turn row-level security on, and `force` applies it to
    the table owner too.
  - `updatedAtTrigger(t.updatedAt)` asks for a `BEFORE UPDATE` trigger that sets the column to `now()`.
  - `setting(name, codec?)` returns a `SettingKey`: `.set(value)` gives the record for
    `tx.setLocal(...)`, and `.current()` is the SQL expression
    `nullif(current_setting(name, true), '')::<type>`, typed `T | null`, usable in queries and policies.
  - Binary operators now accept a nullable expression on the right, as they already did on the left:
    `eq(t.orgId, orgId.current())` compiles. The literal `null` is still refused.
  - `inTransactionFrame(tx, fn)` runs `fn` under `tx`'s development guard frame, so a captured root
    `Db` throws `HandleMisuseError` when a transaction is held open across callbacks.

- [#3](https://github.com/pg-prime/pg-prime/pull/3) [`7667362`](https://github.com/pg-prime/pg-prime/commit/7667362fd19a099f294d79901e2e487efb58455e) Thanks [@YohoCX](https://github.com/YohoCX)! - Row counts and optimistic locking for `update` and `delete`.
  
  - `executeRowCount()` resolves with the command tag's row count (`UPDATE n` / `DELETE n`), with or
    without `RETURNING`.
  - `.ifVersion((t) => t.blocks.rev, 7)` ANDs `rev = $n` into the `WHERE` and throws the new
    `VersionConflictError` (`code: 'VERSION_CONFLICT'`, `table`, and `expected` under
    `errors.includeParams`) when no row matched — from `execute()`, `executeTakeFirst()`,
    `executeRowCount()`, `db.run(q)`, `db.run(q.compile())` and `prepare().execute()` alike, so inside
    `db.transaction()` a conflict rolls the batch back. You still write the bump (`rev: add(t.blocks.rev, 1)`)
    and still need `.where()` or `.allRows()`. `stream()`, `streamBatches()`,
    `explain({ analyze: true, rollback: false })`, CTE bodies and `fromValues` refuse an `.ifVersion()`
    statement.

- [#3](https://github.com/pg-prime/pg-prime/pull/3) [`7e93af3`](https://github.com/pg-prime/pg-prime/commit/7e93af378387d69d2d736276527def3d63fc9e63) Thanks [@YohoCX](https://github.com/YohoCX)! - Typed helpers for things that previously needed a raw `` sql`…`.as(codec) `` fragment:
  
  - `tsHeadline([config, ]doc, query, options?)` — `ts_headline`, with `HeadlineOptions`
    (`startSel`, `maxWords`, `highlightAll`, …) bound as one option string.
  - `similarity`, `wordSimilarity` and `trgmSimilar` (`%`) — pg_trgm on text operands; the two
    similarity scores are nullable when an operand is.
  - `jsonbSet(target, path, value, createMissing?)` — `jsonb_set` with the path as one `text[]` bind and
    the value as `jsonb`; a JS `null` writes the JSON `null`. The result is `unknown` jsonb, so writing
    it back into a `$type<T>()` column takes a cast.
  - `tupleGt`, `tupleLt`, `tupleGte`, `tupleLte` — keyset pagination as one row comparison,
    `row(a, b) > row($1, $2)`, each value bound with its column's codec and the arity checked by the
    compiler.

### Patch Changes

- [#3](https://github.com/pg-prime/pg-prime/pull/3) [`98ad069`](https://github.com/pg-prime/pg-prime/commit/98ad069d689b69d4ad76a3c159bda5820341bf80) Thanks [@YohoCX](https://github.com/YohoCX)! - The package READMEs no longer claim `0.0.0` or "nothing is usable yet". `@pg-prime/testing`'s README now lists what it ships — `createMockPool`, `expectSql`, `startPglite`, `startPostgres`, `scratchDatabase` and the skip guards — with a minimal `startPglite` example, and `pg-prime`'s README names `pg` as the optional peer the `connection:` form needs.

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

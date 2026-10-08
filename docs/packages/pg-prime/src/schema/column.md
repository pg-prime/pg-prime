# packages/pg-prime/src/schema/column.ts

## Purpose
The column DSL: typed column factories, the immutable `ColumnBuilder` behind every `Col<M>`, `pgEnum`, the `kit` passed to `pgTable(name, (t) => …)`, and the runtime column IR (`ColumnDdl` / `ColumnTsMeta`).
Called by `table.ts` and `view.ts` (columns, `kit`, `checkName`), `extras.ts` and `objects.ts` (`checkName`); `ColumnDdl` is read by `packages/pg-prime/src/query/meta.ts:28` (`metaOf`) and by the kit's `packages/pg-prime-kit/src/schema/emit.ts`. Calls `fragmentDdlText` / `checkFkAction` from `ddl.ts` and `quoteIdentPart` from `packages/pg-prime/src/sql/ident.ts`.

## Public API
- `DefaultSpec` — `{ kind: 'value', value }` or `{ kind: 'expr', expr }`.
- `ColumnDdl` — DDL facts: `pgType`, `dbName`, `notNull`, `default`, `identity`, `generatedAs`, `generatedAsFrom`, `primaryKey`, `unique`, `uniqueSpec`, enum fields, `arrayDim`, `references`, `checks`, `comment`, `collation`, `renamedFrom`.
- `ColumnTsMeta` — TS-only: `defaultFn`, `onUpdateFn`, `narrowed`; never reaches DDL.
- `ColumnRuntime` — `{ ddl, ts }`, the runtime shape behind every column.
- `AnyCol` — `{ [META]: any }`, O(1) constraint supertype.
- `Col<M>` — the column builder type; every modifier returns a new `Col` whose meta reflects the modifier.
- `.collate(name)` — sets `ColumnDdl.collation`; typed as `CollateFn<M>`, an `OrmTypeError` unless `pg` is a `CollatablePg` (`text`, `varchar`, `citext`, `bpchar`, `name`), an array of one, or `t.raw()`'s `string` (`packages/pg-prime/src/schema/column.ts:152`–`:160`).
- `GeneratedAlwaysAsOptions` — `{ stored?: true }`; any other value is an `OrmTypeError`.
- `PgEnum<N, V>` / `AnyPgEnum` / `PgEnumOptions<V>` — enum type: `name`, `values`, `schema`, `renamedFrom`, `renamedValues`, `comment`.
- `pgEnum(name, values, options?)` — validates and returns a `PgEnum`; throws `SchemaError` on bad names, duplicate labels, bad `renamedValues`.
- `Infer<E>` — union of an enum's labels.
- `checkName(value, what)` — runs `quoteIdentPart`, rethrowing `InvalidIdentifierError` as a `SchemaError` naming `what`. Not on the barrel.
- `uuid`, `text`, `varchar`, `integer` (`int4`), `smallint` (`int2`), `bigint` (`int8` → `bigint`), `boolean` (`bool`), `timestamptz` (→ `Date`), `date` (→ `DateString`), `numeric` (→ `string`), `jsonb` (→ `unknown`), `citext` — `(name?) => Col`.
- `vector(dimensions?, name?)` — pgvector `number[]` column; throws on a non-positive or over-limit dimension.
- `VECTOR_MAX_DIMENSIONS` — `16_000`.
- `raw(pgType, name?)` — any PostgreSQL type by name, read type `unknown`; throws on a blank type.
- `enumColumn(e, name?)` — column of a `PgEnum`, read type is the label union.
- `ColumnKit` / `kit` — record of the factories (`enum` maps to `enumColumn`).

## Flow
1. A factory calls `make` → `new ColumnBuilder(baseDdl(pgType, name), EMPTY_TS)` and casts to `Col<{ t, pg, opt: false, ro: false, pk: false }>` (`packages/pg-prime/src/schema/column.ts:519`).
2. `baseDdl` sets `notNull: true`; columns are NOT NULL by default (`packages/pg-prime/src/schema/column.ts:494`).
3. Every modifier returns a new builder via `#next`, spreading the old `ddl` / `ts` (`packages/pg-prime/src/schema/column.ts:318`).
4. Non-`$` modifiers write `ddl`; `$type`, `$default`, `$onUpdate` write only `ts` (`packages/pg-prime/src/schema/column.ts:478`–`:487`).
5. `#reject` and `#noDefaultAfterGenerated` throw `SchemaError` for contradictory chains in either order (`packages/pg-prime/src/schema/column.ts:329`, `:353`).
6. `.references(thunk)` stores `{ target: () => [thunk()], … }` with validated actions (`packages/pg-prime/src/schema/column.ts:428`–`:447`).
7. `.check()` / `.generatedAlwaysAs(fragment)` render text through `fragmentDdlText` at once; the callback form is stored in `generatedAsFrom` for `pgTable` to resolve (`packages/pg-prime/src/schema/column.ts:403`–`:410`).
8. `.collate(name)` runs `checkName` and throws `SchemaError` on an enum column (`packages/pg-prime/src/schema/column.ts:463`).
9. `.array()` appends `[]` to `pgType` and increments `arrayDim` (`packages/pg-prime/src/schema/column.ts:473`).

## Gotchas
- Type-level gates only see the forward order: `NullableFn` / `DefaultableFn` resolve to `OrmTypeError` after `.primaryKey()` / `.generatedAlways()` (`packages/pg-prime/src/schema/column.ts:127`, `:163`); the reverse order is a runtime `SchemaError` on import.
- `.generatedAlwaysAs()` sets `ro: true`, which closes `.nullable()` and defaults afterwards; write `.nullable()` before it.
- `.generatedByDefault()` has no runtime checks (`packages/pg-prime/src/schema/column.ts:376`), so it is not refused after `.generatedAlwaysAs()`.
- `.references()` requires a function; `.references(orgs.cols.id)` throws (`packages/pg-prime/src/schema/column.ts:429`). Its error text suggests `() => orgs.id`, but tables expose columns only under `.cols` / `[REFS]`.
- A self-reference cannot be written with `.references()` (TS7022); use the `foreignKey` extra. A mutual pair needs `(): RefLike =>` on the thunk (`packages/pg-prime/src/schema/column.ts:231`–`:239`).
- `.check()` accumulates; `.unique()`, `.references()`, `.comment()`, `.collate()`, `.renamedFrom()` overwrite.
- `.collate()` takes one unqualified identifier; a collation in a non-`pg_catalog` schema cannot be named, and the kit's extractor reads only `collname`. The runtime refuses only enums: a JS caller can still put a collation on, say, `integer`, which PostgreSQL rejects at migrate time.
- `.array()` on a nullable column yields `T[] | null`, never `(T | null)[]` (`packages/pg-prime/src/schema/column.ts:254`).
- `$type<T>()` only narrows the non-null part and re-attaches `| null` (`packages/pg-prime/src/schema/column.ts:273`).
- `vector(n)` stores `vector(n)` in `pgType` but the type-level `pg` is `'vector'`; `codecFor` strips the typmod (`packages/pg-prime/src/schema/column.ts:807`–`:810`).
- `raw()` has `pg: string`, so type-level operator gates cannot classify it; `pgEnum` labels may be `''` (only the empty-name check is skipped) (`packages/pg-prime/src/schema/column.ts:619`).
- `pgEnum({ schema })` unset means the emitter's default schema, not the first using table's schema (`packages/pg-prime/src/schema/column.ts:531`).

## Tests
- `packages/pg-prime/test/schema/columns.test.ts` — row shapes per modifier, identity, the `$` law, NOT NULL default.
- `packages/pg-prime/test/schema/ddl.test.ts` — `.references()`, `.check()`, `.unique()`, `.comment()`, `.collate()`, `.renamedFrom()`, type stability.
- `packages/pg-prime/test/schema/ts-expect-error.probe.ts` — compile-time negatives, incl. `.collate()` on `integer` / `jsonb`.
- `packages/pg-prime/test/schema/audit.test.ts` — `$type` / `array` nullability, contradictory chains, enum labels, identifier errors.
- `packages/pg-prime/test/schema/g14-ddl-closeout.test.ts` (`generatedAlwaysAs`), `k4-additions.test.ts` (`raw`, `renamedValues`).
- `packages/pg-prime/test/query/meta.test.ts`, `test/query/extension-types.test.ts`; `test/pg/vector.test.ts` needs a pgvector server (`PG_PRIME_TEST_URL`).
- Run: `pnpm --filter pg-prime exec vitest run test/schema`.

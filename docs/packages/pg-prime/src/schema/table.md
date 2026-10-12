# packages/pg-prime/src/schema/table.ts

## Purpose
Builds table entities: `pgTable` turns a column record into a frozen `Table<N, C>` with pre-computed refs and row shapes plus a `TableRuntime` the emitter and query layer read; `pgSchema` binds a PostgreSQL schema to `table` / `enum`.
Uses `column.ts` (`kit`, `checkName`, `pgEnum`) and `ddl.ts` (`fragmentDdlText`). `view.ts` reuses `buildColumnRefs`, `TableImpl` and `snakeCase`; `relations.ts` registers tables; `packages/pg-prime/src/query/meta.ts:29` and `packages/pg-prime/src/errors/refs.ts:26` read `TableRuntime`; the kit reads it via `packages/pg-prime-kit/src/schema/types.ts`.

## Public API
- `ColsOf<B>` — maps a column-builder record to its `Cols` by indexed access on `[META]`.
- `TableRuntime` — `name`, `schema`, `columns: RefRuntime[]`, `extras: TableExtra[]`, optional `view: ViewInfo`, `column(key)`.
- `Table<N, C, R = {}>` — `[NAME]`, `[COLS]`, `[REFS]`, `cols`, `[SEL]`, `[INS]`, `[UPD]`, `[RELS]`, `$`.
- `AnyTable` — `any`-membered supertype for O(1) checks.
- `Selectable<T>` / `Row<T>`, `Insertable<T>` / `Insert<T>`, `Updateable<T>` / `Update<T>` — the three row shapes, two spellings each.
- `Refs<T>` — `T[REFS]`, the parameter type of column callbacks.
- `snakeCase(key)` — default casing: `createdAt` → `created_at`, `HTMLParser` → `html_parser`.
- `TableOptions` — `{ schema?, casing? }`.
- `TableImpl` — class implementing `TableRuntime` with a key → ref map. Not on the barrel.
- `buildColumnRefs(source, schema, record, casing, what, casingLabel, resolve?)` — record → frozen refs + `RefRuntime[]`; throws `SchemaError`. Not on the barrel.
- `pgTable(name, columns, extras?, options?)` / `table` — returns a frozen `Table`; columns are a record or `(t: ColumnKit) => record`.
- `PgSchemaOptions` (`renamedFrom?`) / `PgSchema` / `pgSchema(name, options?)` — frozen `{ kind: 'schema', name, renamedFrom, table, enum }`.

## Flow
1. `pgTable` validates the table and schema names, then evaluates the column callback with `kit` (`packages/pg-prime/src/schema/table.ts:319`–`:322`).
2. `lateGenerationRefs` builds a names-only `{ key: { $: { table, schema, dbName } } }` record only if some column used `.generatedAlwaysAs((c) => …)` (`packages/pg-prime/src/schema/table.ts:176`–`:200`).
3. `buildColumnRefs` rejects a non-standard prototype, `$`-prefixed keys, `__proto__`, non-column values, invalid and duplicate DB names (`packages/pg-prime/src/schema/table.ts:251`–`:291`).
4. Per column it calls the `resolve` hook; for `pgTable` that is `resolveGeneration`, which renders the callback and replaces the column runtime with `generatedAs` set (`packages/pg-prime/src/schema/table.ts:211`–`:223`, `:294`).
5. It freezes a `RefRuntime` and a ref `{ [SRC], [NAME], [META], $ }` per key into a null-prototype record (`packages/pg-prime/src/schema/table.ts:262`, `:295`–`:297`).
6. `pgTable` freezes the refs, calls `extras(refs)` once and freezes the array (`packages/pg-prime/src/schema/table.ts:347`–`:348`).
7. It returns a frozen object with `[REFS]` and `cols` pointing at the same record and `$: new TableImpl(...)` (`packages/pg-prime/src/schema/table.ts:350`–`:362`).
8. `pgSchema(name).table(...)` calls `pgTable` with `{ ...options, schema: name }`; `.enum(...)` calls `pgEnum(..., { schema: name })` (`packages/pg-prime/src/schema/table.ts:416`, `:422`).

## Gotchas
- `[COLS]`, `[SEL]`, `[INS]`, `[UPD]` are `undefined` at runtime and `[RELS]` is always an empty frozen object; relations live on the schema registry (`packages/pg-prime/src/schema/table.ts:352`–`:360`).
- Columns are not properties of the table: use `t.cols.x` or `t[REFS].x`.
- A `$`-prefixed column key throws a plain `Error`, not a `SchemaError` (`packages/pg-prime/src/schema/table.ts:267`).
- A late-bound generation callback receives only DB names, keyed by TS key; a key that does not exist is caught when the expression renders, not by the compiler (`packages/pg-prime/src/schema/column.ts:190`–`:193`).
- The duplicate-name error labels the casing `custom` whenever `options.casing` is passed, even if it is `snakeCase` (`packages/pg-prime/src/schema/table.ts:339`).
- `pgSchema(...).enum` accepts no `renamedFrom` / `renamedValues` / `comment`; call `pgEnum` with `{ schema }` for those.
- Everything is frozen; mutation after declaration throws in strict mode.
- `CREATE TABLE t ()` is allowed: `pgTable` accepts an empty column record, unlike views.

## Tests
- `packages/pg-prime/test/schema/columns.test.ts` (describe "table runtime"), `schema.test.ts` (`pgTable` forms, `$` keys).
- `packages/pg-prime/test/schema/audit.test.ts` — duplicate DB names (E8), identifier errors (E9), `__proto__` (E11), freezing and non-column values (E17).
- `packages/pg-prime/test/schema/ddl.test.ts` (describe "pgSchema"), `g14-ddl-closeout.test.ts` (late-bound `generatedAlwaysAs`), `k4-additions.test.ts` (`pgSchema` `renamedFrom`).
- Run: `pnpm --filter pg-prime exec vitest run test/schema`.

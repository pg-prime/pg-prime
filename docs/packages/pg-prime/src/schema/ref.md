# packages/pg-prime/src/schema/ref.ts

## Purpose
Type-only module declaring the column-reference shape: the typed `Ref` that `[REFS]` / `.cols` hold and the non-generic `RefRuntime` behind its `$`.
Values are built by `buildColumnRefs` in `packages/pg-prime/src/schema/table.ts:238`; consumers are `packages/pg-prime/src/schema/extras.ts` and `relations.ts` (`AnyRef`), `packages/pg-prime/src/query/ref.ts:39`, `packages/pg-prime/src/errors/refs.ts:25`, and the kit's `packages/pg-prime-kit/src/schema/types.ts` (`RefRuntime`).

## Public API
- `Projectable` — anything with a phantom `[OUT]` slot; the common supertype of refs and typed fragments.
- `RefRuntime` — runtime metadata: `table` (source alias / table name), `schema` (or `undefined` for the emitter default), `key` (TS key), `dbName` (resolved column name), `column` (`ColumnRuntime`).
- `Ref<A, K, M>` — reference to column `K` of source alias `A` with meta `M`: `[SRC]`, `[NAME]`, `[OUT]: M['t']`, `[META]`, `$: RefRuntime`.
- `AnyRef` — `any`-membered supertype for O(1) constraint checks.
- `RefsOfCols<N, C>` — `{ [K in keyof C]: Ref<N, K, C[K]> }`, the type of a table's `[REFS]` and `cols`.

## Flow
1. `pgTable` / `pgView` resolve each column's DB name, then build one frozen `RefRuntime` per column (`packages/pg-prime/src/schema/table.ts:295`).
2. The same loop builds the frozen ref `{ [SRC], [NAME], [META], $ }` and stores it under the TS key (`packages/pg-prime/src/schema/table.ts:297`).
3. The ref record becomes both `[REFS]` and `cols` on the table (`packages/pg-prime/src/schema/table.ts:355`–`:356`), and is the parameter of every extras / query callback.

## Gotchas
- `Ref` keeps `[NAME]: K` so refs of two different columns are not mutually assignable (`packages/pg-prime/src/schema/ref.ts:36`).
- `RefRuntime.schema` is carried on every ref because `.references(() => other.cols.id)` hands the emitter a ref and nothing else; FK inference compares it schema-first (`packages/pg-prime/src/schema/relations.ts:618`).
- `[OUT]` exists only in the type; runtime refs carry no `[OUT]` property (`packages/pg-prime/src/schema/table.ts:297`).
- `ddl.ts` declares a structural `RefLike` (`$.table`, `$.schema`, `$.dbName`) instead of importing `AnyRef`, to avoid an import cycle (`packages/pg-prime/src/schema/ddl.ts:68`).

## Tests
- `packages/pg-prime/test/schema/columns.test.ts` (describe "column refs") checks source alias, key and meta on refs.
- `packages/pg-prime/test/schema/ddl.test.ts` checks that a ref carries its table schema for cross-schema FKs.
- `packages/pg-prime/test/schema/audit.test.ts` (E11) checks the refs record is null-prototype.
- Run: `pnpm --filter pg-prime exec vitest run test/schema/columns.test.ts test/schema/ddl.test.ts`.

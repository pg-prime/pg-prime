# packages/pg-prime/src/schema/symbols.ts

## Purpose
Defines the phantom slot keys (`unique symbol`s) that every schema, ref and query type is keyed on.
Imported by every sibling in `packages/pg-prime/src/schema/`, by `packages/pg-prime/src/sql/fragment.ts:50` (type-only), and by the query layer through the `packages/pg-prime/src/schema/index.ts` barrel; re-exported publicly from `packages/pg-prime/src/index.ts`.

## Public API
- `META` — slot carrying a column's `ColMeta` on `Col<M>` and on `Ref`.
- `NAME` — table / column name literal on `Table`, `Ref`, `Handle`, `View`.
- `COLS` — table column-meta record (`Table[COLS]`, type-only; `undefined` at runtime).
- `REFS` — pre-computed per-column `Ref` objects of a table or view.
- `SEL`, `INS`, `UPD` — pre-flattened select / insert / update row shapes (type-only slots).
- `RELS` — relation record on a table (always `{}`) and on a schema registry.
- `TABLES` — table record of a schema registry; `SCHEMA` — schema back-reference on a handle.
- `OUT` — output type of anything projectable (`Projectable`, typed fragments).
- `SRC` — source alias of a column reference.
- `ERR` — message carrier of the `OrmTypeError<M>` sentinel type.
- `READONLY` — present only on `pgView` / `pgMaterializedView` handles; marks "no write surface".
- `DATE_BRAND` — reserved; read by nothing in the package.

## Flow
1. Each key is created once with `Symbol.for('pg-prime.<NAME>')` (`packages/pg-prime/src/schema/symbols.ts:12`–`:49`).
2. Runtime objects populate only the slots the runtime reads: refs get `[SRC]`/`[NAME]`/`[META]` (`packages/pg-prime/src/schema/table.ts:297`); tables set `[COLS]`/`[SEL]`/`[INS]`/`[UPD]` to `undefined` (`packages/pg-prime/src/schema/table.ts:352`).
3. The query layer reads `[READONLY]` in return position of the write entry points to produce a sentinel type (`packages/pg-prime/src/query/types.ts:1096`).

## Gotchas
- `Symbol.for`, not `Symbol`: duplicate copies of the package in one dependency tree agree on the keys at runtime (`packages/pg-prime/src/schema/symbols.ts:7`).
- Every key used in a public type position must stay exported, or a consumer's `declaration: true` build fails with TS2527 (`packages/pg-prime/src/schema/symbols.ts:4`). Removing one is a breaking change; that is why `DATE_BRAND` stays (`packages/pg-prime/src/schema/symbols.ts:43`).
- Most slots are phantom: `[COLS]`, `[SEL]`, `[INS]`, `[UPD]` and a handle's `[SCHEMA]` are `undefined` at runtime (`packages/pg-prime/src/schema/relations.ts:179`, `packages/pg-prime/src/schema/view.ts:382`). Never read them as values.

## Tests
- `packages/pg-prime/test/schema/typecheck.test.ts` compiles the probe suite on TS 5.9.3 and 7.0.2 and runs a `declaration: true` emit, the TS2527 canary for the exported-symbol rule.
- Slot contents are asserted indirectly in `packages/pg-prime/test/schema/columns.test.ts` (refs carry `[SRC]`/`[NAME]`/`[META]`) and `packages/pg-prime/test/schema/view.test.ts`.
- Run: `pnpm --filter pg-prime exec vitest run test/schema/typecheck.test.ts`.
- Uncovered: no test asserts `Symbol.for` identity across two loaded copies of the package.

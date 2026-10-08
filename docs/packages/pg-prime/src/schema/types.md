# packages/pg-prime/src/schema/types.ts

## Purpose
Type-only core of the schema layer: the five-field `ColMeta` every column carries, the relation meta, the three row shapes computed from them, and shared utility types.
Used by `column.ts`, `table.ts`, `relations.ts`, `view.ts` and `ref.ts`, and by the query layer through the `packages/pg-prime/src/schema/index.ts` barrel. It imports only `PgDateString` from `packages/pg-prime/src/codec/types.ts` and `ERR` from `symbols.ts`.

## Public API
- `Simplify<T>` — collapses an intersection into one object type; used at declaration time only.
- `Defer<T>` — `[T] extends [unknown] ? T : never`; keeps an alias unresolved in emitted declarations.
- `OrmTypeError<M>` — sentinel type `{ [ERR]: M }` whose message string appears in compiler diagnostics.
- `DateString` — alias of the codec layer's `PgDateString`, the branded `'YYYY-MM-DD'` string.
- `ColMeta` — `{ t, pg, opt, ro, pk }`: read type (already including `| null`), pg type name, optional-at-insert, never-writable, primary-key-per-column.
- `Cols` — `Record<string, ColMeta>`, the payload a `Table` carries.
- `RelMeta<N>` / `Rels` — `{ kind: 'one' | 'many', opt, to }` where `to` is a registry key; record of them.
- `SelectRow<C>` — `$inferSelect`: `C[K]['t']` per key.
- `InsertRow<C>` — `$inferInsert`: drops `ro` keys; `opt` keys optional, the rest required.
- `UpdateRow<C>` — `$inferUpdate`: every non-`ro` key, all optional.

## Flow
1. Column builders produce `Col<M>` with `M extends ColMeta` (`packages/pg-prime/src/schema/column.ts:154`).
2. `pgTable` maps the column record to `Cols` via `ColsOf` (`packages/pg-prime/src/schema/table.ts:21`).
3. `Table<N, C>` stores `SelectRow<C>`, `InsertRow<C>`, `UpdateRow<C>` as interface properties so TypeScript computes each once per table (`packages/pg-prime/src/schema/table.ts:75`–`:77`).
4. `InsertRow` splits required and optional keys with two key-remapping filters on `ro` and `opt` (`packages/pg-prime/src/schema/types.ts:94`).

## Gotchas
- `t` already contains `| null` for nullable columns, so `SelectRow` needs no conditional (`packages/pg-prime/src/schema/types.ts:47`).
- `pk` is set only by the column-level `.primaryKey()`; a table-level `primaryKey(t.a, t.b)` extra leaves every `pk` false (`packages/pg-prime/src/schema/types.ts:54`–`:59`). Consumers must treat `pk: false` as "unknown", not "not a key".
- `DateString` is the codec brand, not a separate one, so codec-produced date values are assignable to `date()` columns (`packages/pg-prime/src/schema/types.ts:38`).
- `RelMeta.to` is a registry key, never an inlined `Table` type; this keeps cyclic relation graphs free of thunks (`packages/pg-prime/src/schema/types.ts:73`).

## Tests
- `packages/pg-prime/test/schema/columns.test.ts` — `SelectRow` / `InsertRow` / `UpdateRow` per modifier, both spellings of the row aliases.
- `packages/pg-prime/test/schema/audit.test.ts` (E5) — `DateString` is the codec brand.
- `packages/pg-prime/test/schema/typecheck.test.ts` compiles `test/schema/ts-expect-error.probe.ts` on TS 5.9.3 and 7.0.2.
- Run: `pnpm --filter pg-prime exec vitest run test/schema/columns.test.ts test/schema/audit.test.ts`.

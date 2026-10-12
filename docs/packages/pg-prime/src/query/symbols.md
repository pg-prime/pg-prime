# packages/pg-prime/src/query/symbols.ts

## Purpose
Defines the query layer's phantom-slot symbol keys used in public type positions. Imported as types by `src/query/types.ts` (`packages/pg-prime/src/query/types.ts:89`) to key `Query`, `SetQuery` and sub-select phantom members; no other runtime callers.

## Public API
- `INV` — `Symbol.for('pg-prime.INV')`; the invariance marker `readonly [INV]: (o: O) => O` on `Query<S, O>`.
- `ROW` — `Symbol.for('pg-prime.ROW')`; the row type a query yields, read by `RowOf<Q>`.
- `PRJ` — `Symbol.for('pg-prime.PRJ')`; the projection record a sub-select carries so a relation picker can infer it.

## Flow
1. The module evaluates three `Symbol.for` calls (`packages/pg-prime/src/query/symbols.ts:10`).
2. `src/query/types.ts` uses them as computed keys of phantom members (`packages/pg-prime/src/query/types.ts:439`, `packages/pg-prime/src/query/types.ts:669`).

## Gotchas
- Each `unique symbol` used in a public type must be exported, or a consumer build with `declaration: true` fails with TS2527.
- `Symbol.for` makes duplicate copies of the package in one dependency tree agree at runtime.
- The keys are phantom: no runtime object carries `[INV]`, `[ROW]` or `[PRJ]` values.

## Tests
- `packages/pg-prime/test/query/typecheck.test.ts` compiles the type probes on both TypeScript versions and runs a `declaration: true` emit, which is the TS2527 canary for these symbols.
- `packages/pg-prime/test/query/types/invariance.probe.ts` imports `INV` and `ROW` and pins `Query` invariance.
- Run: `pnpm --filter pg-prime exec vitest run test/query/typecheck.test.ts`.

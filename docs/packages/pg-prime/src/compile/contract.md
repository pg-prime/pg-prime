# packages/pg-prime/src/compile/contract.ts

## Purpose
Declares the compiler's output contract, `compile(ast) -> { sql, binds, shape, meta }`, and the decode-plan types. Produced by `compile()` in `packages/pg-prime/src/compile/compiler.ts` and `planSelect` / `planReturning` in `hoist.ts`; consumed by `decode.ts`, the query layer (`packages/pg-prime/src/query/executor.ts`, `raw.ts`, `prepared.ts`, `terminals.ts`, `errors.ts`, `scope.ts`, `cte.ts`, `types.ts`), and `packages/pg-prime/src/session/runner.ts`, `handles.ts`, `types.ts`.

## Public API
- `Compiled<Row>` — frozen `{ sql, binds, shape, meta, origins? }`; `__row` is a phantom member that keeps `Row` invariant.
- `FieldOrigin` — `{ column? , site? }`: the qualified schema column or the `.as(codec)` call site behind a result column; re-exported from `packages/pg-prime/src/index.ts:309`.
- `CompiledMeta` — `kind` (`select | insert | update | delete | setop`), `reads`, `writes`, `placeholders`, `usedUnsafeRaw`, and `versionCheck?: { table, expected }` iff the statement came from `.ifVersion()` (the runner enforces it).
- `Bind` — `{ k: 'value', encoded, oid }` (already encoded by the codec) or `{ k: 'slot', name, codec }` (filled at `execute()` on a prepared query).
- `paramTypesOf(binds): readonly number[]` — the `Parse` `paramTypes` array, positional with `binds`; `0` where no OID is declared.
- `ResultShape` — `{ k: 'row', fields }`, `{ k: 'scalar', idx, codec }`, or `{ k: 'void' }`.
- `FieldPlan` — `col` (`idx`, `codec`), `json` (`idx`, `plan`, `nullable`), or `group` (`fields`, `nullable`, `sentinel`, `witnesses?`).
- `JsonPlan` — `obj` (`fields`, `nullable`), `arr` (`item`), or `leaf` (`codec`, decoded with `codec.decodeJson`).

## Flow
1. `compile()` fills `sql`, `binds`, `meta` from its emitter and `shape` / `origins` from the planner (`packages/pg-prime/src/compile/compiler.ts:1467`).
2. The executor turns `binds` into wire parameters and calls `paramTypesOf` for the `Parse` message (`packages/pg-prime/src/query/executor.ts:733`, `packages/pg-prime/src/session/runner.ts:161`).
3. `buildDecoder(shape, …)` in `decode.ts` turns `shape` into a row decoder; `origins` is read only by dev-mode `assertShape`.

## Gotchas
- Every `idx` is a position in the driver's array row (`rowMode: 'array'`), not a position in `fields` (`packages/pg-prime/src/compile/contract.ts:84`).
- A `group` field owns no column index; its children carry their own `idx`, and `sentinel` / `witnesses` are row indexes (`packages/pg-prime/src/compile/contract.ts:99`).
- `witnesses: []` means "never null"; `undefined` defers to `sentinel`, then to every leaf column (`packages/pg-prime/src/compile/contract.ts:112`).
- `paramTypesOf` returns `0` (protocol "unspecified") rather than 705 for a bind with no declared type (`packages/pg-prime/src/compile/contract.ts:80`).
- `compile()` never produces a `scalar` shape; the executor rewrites a single dynamic column into one (`packages/pg-prime/src/query/executor.ts:365`).
- `origins` sits beside `shape`, not inside `FieldPlan`, so plan comparisons in the compiler suite ignore it (`packages/pg-prime/src/compile/contract.ts:31`).

## Tests
- `packages/pg-prime/test/compile/contract.test.ts` covers frozen output, encoded bind values, `paramTypesOf` positional `0`, slot binds and `meta.placeholders`, `meta.reads`/`writes`, positional decoding, and the void shape.
- Run: `pnpm --filter pg-prime exec vitest run test/compile/contract.test.ts`.
- `origins` is exercised indirectly by `packages/pg-prime/test/query/assert-shape.test.ts`.

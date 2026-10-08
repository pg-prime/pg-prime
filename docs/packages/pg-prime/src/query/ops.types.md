# packages/pg-prime/src/query/ops.types.ts

## Purpose
Type-only operand tables for the operator vocabulary: which PostgreSQL type class each operator
accepts, the `ORDER BY` item types, and the result-type maps for `sum`, `avg` and range bounds.
Imported by `packages/pg-prime/src/query/ops.ts`, `packages/pg-prime/src/query/fn.ts`,
`packages/pg-prime/src/query/types.ts` (re-exported there and from `packages/pg-prime/src/index.ts`)
and `packages/pg-prime/src/query/window.ts` (`OrderBy`). It imports only `META`/`OUT` from the
schema, `PgDateString` from the codecs and `ExprOf` from `packages/pg-prime/src/query/types.ts`.

## Public API
- `ClassOperand<T, P>` — `{ [OUT]: T; [META]: { pg: P } }`: "a `T` that PostgreSQL calls `P`"; satisfied
  by column refs, builder expressions and typed `sql` fragments, never a hand-written literal.
- `AnyOperand<T = unknown>` — `ClassOperand<T, string>`; operand of `min`/`max`/`cast`/`asc`/`desc`/`eq`.
- `NonNullOperand<T>` — `(T | ExprOf<T | null>) & {}`: right operand that may not be the literal `null`/`undefined`; a nullable expression (`setting(...).current()`) is accepted, as on the left.
- `Order` — opaque `{ dir: 'asc' | 'desc' }` returned by `asc`/`desc`; not `Projectable`.
- `OrderArg`, `OrderBy` — what `orderBy` accepts: an `Order` or any `[OUT]`-bearing expression, or an array.
- `TextPg`, `NumPg`, `JsonPg`, `NetPg`, `RangePg` — the PG type-name unions of each class
  (`TextPg` includes `citext`, `bpchar`, `name`; `NumPg` includes `money`).
- `BoolOperand`, `TextOperand`, `NumOperand<T, P>`, `JsonOperand`, `JsonbOperand`, `NetOperand`,
  `TsvectorOperand`, `TsqueryOperand` — per-class gates built on `ClassOperand`.
- `VectorOperand` — `pg: 'vector'` only; `BitOperand` — `pg: 'bit'` only.
- `RangeOperand<P extends RangePg>` — range gate, `[OUT]` is `string | null`.
- `ArrayOperand<E>` — `pg` is `` `${string}[]` ``; `E` is inferred from `readonly E[] | null`.
- `JsonValue` — a JS value `JSON.stringify` encodes as-is; `jsonbSet`'s literal operand. An interface
  without an index signature is not assignable to it.
- `HeadlineOptions` — `tsHeadline`'s options (`startSel`, `stopSel`, `maxWords`, `minWords`, `shortWord`,
  `highlightAll`, `maxFragments`, `fragmentDelimiter`).
- `SumPg<P>`, `SumOut<P>` — `sum` result: `int2`/`int4` → `int8`/`bigint`; `int8`/`numeric` →
  `numeric`/`string`; floats keep `P`/`number`; `money` keeps `P`/`string`.
- `AvgPg<P>`, `AvgOut<P>` — `avg` result: `float4`/`float8` → `float8`/`number`, else `numeric`/`string`.
- `RangeElemPg<P>`, `RangeElem<P>` — range subtype: `int4`/`number`, `int8`/`bigint`, `numeric`/`string`,
  `timestamp`/`string`, `timestamptz`/`Date`, `date`/`PgDateString` (in `RangePg` order).

## Flow
1. A class-gated operator in `packages/pg-prime/src/query/ops.ts` declares its left operand as one of
   the `*Operand` types, so the argument must carry `[META].pg` within the class union
   (`packages/pg-prime/src/query/ops.types.ts:49`).
2. A schema `Ref` supplies `pg` from the column's declared PG type; a `` sql`…`.as(codec) `` fragment
   supplies the codec's `name` (`TypedFragment` in `packages/pg-prime/src/sql/fragment.ts`).
3. Builder results are `Expr<T, P>` (`packages/pg-prime/src/query/types.ts:169`), so an operator's
   output can feed another gated operator.
4. Aggregates and range bounds compute their declared result through `SumPg`/`AvgPg`/`RangeElemPg`
   (`packages/pg-prime/src/query/ops.types.ts:173`, `:191`, `:195`); the runtime codecs come from the
   twin tables `SUM_RESULT`/`AVG_RESULT` (`packages/pg-prime/src/query/fn.ts:151`, `:161`) and
   `RANGE_ELEMENT` (`packages/pg-prime/src/query/ops.ts:697`).

## Gotchas
- `JsonOperand` admits `json` and `jsonb` but only the four accessors use it; every other JSON
  operator takes `JsonbOperand`, so a `json` column there is a compile error
  (`packages/pg-prime/src/query/ops.types.ts:107`).
- `halfvec`, `sparsevec` and `varbit` are deliberately not members of `VectorOperand`/`BitOperand`:
  no codec exists for them (`packages/pg-prime/src/query/ops.types.ts:121`, `:132`).
- `hamming`/`jaccard` take `BitOperand`, not `VectorOperand` (`packages/pg-prime/src/query/ops.types.ts:132`).
- The pg slot uses codec `name` (`int4`, `int8`), never `sqlName` (`integer`, `bigint`); a fragment
  typed with a codec whose `name` is not in a class union fails the gate.
- `NonNullOperand` blocks only the literal; a nullable *expression* is still accepted
  (`packages/pg-prime/src/query/ops.types.ts:64`), including one typed `T | null` such as `eq(t.orgId, orgId.current())`.
- `NumPg` includes `money`, but `SumPg`/`AvgPg` have no `money` branch: `sum` keeps `money`,
  `avg` claims `numeric` (`packages/pg-prime/src/query/ops.types.ts:173`, `:191`).
- The type maps and the runtime codec tables in `ops.ts`/`fn.ts` are two copies; only
  `RANGE_ELEMENT_NAMES` is pinned row for row by a test.
- CTE columns carry `pg: any` (`packages/pg-prime/src/query/types.ts:1021`), so every gate accepts them.

## Tests
- Type probes: `packages/pg-prime/test/query/types/ops.probe.ts` and `search.probe.ts` (gates, `NonNullOperand`,
  `sum`/`avg` result types via `expectTypeOf` and `@ts-expect-error`). Run with
  `pnpm --filter pg-prime typecheck` (includes `tsc -p test/query/tsconfig.json`).
- Runtime twins: `packages/pg-prime/test/query/ops.test.ts` pins `RANGE_ELEMENT_NAMES` against the
  `RangeElemPg` table and spot-checks `sum`/`avg` result codecs; run
  `pnpm --filter pg-prime exec vitest run test/query/ops.test.ts`.
- Server confirmation of `sum`/`avg` per operand type: `packages/pg-prime/test/live-query/ops.test.ts`
  (`pnpm --filter pg-prime exec vitest run test/live-query/ops.test.ts`).
- Uncovered: no row-for-row test ties `SumPg`/`AvgPg` to `SUM_RESULT`/`AVG_RESULT`; `money` operands.

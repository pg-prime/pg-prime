# packages/pg-prime/src/query/fn.ts

## Purpose
Boolean combinators (`and`/`or`/`not`/`exists`), `ORDER BY` items (`asc`/`desc`) and the `fn`
namespace of aggregates, ranking window functions, `now()` and full-text helpers. Re-exported by
`packages/pg-prime/src/query/types.ts:1688` and `packages/pg-prime/src/index.ts`; `fn` is also
used by `packages/pg-prime/src/query/relations.ts` for relation aggregates. It builds AST nodes
with `packages/pg-prime/src/compile/nodes.ts`, reads codecs via `codecOf`
(`packages/pg-prime/src/compile/hoist.ts`) and coerces operands with `toExprNode`
(`packages/pg-prime/src/query/projection.ts`) and `queryAstOf` (`packages/pg-prime/src/query/nominal.ts`).

## Public API
- `and(...xs)` / `or(...xs)` — n-ary `(a and b …)` / `(a or b …)`; `Expr<boolean, 'bool'>`. Zero
  arguments emit `true` / `false`. Throws `BuilderError` on a non-expression argument.
- `not(x)` — `not x`; throws `BuilderError` on a non-expression.
- `exists(q)` / `notExists(q)` — `[not] exists (select …)`; `q` is a select builder, set operation
  or registered select/setop node; anything else throws `BuilderError`.
- `asc(a, nulls?)` / `desc(a, nulls?)` — `Order` item; `nulls` must be `'first'`, `'last'` or
  `undefined`, otherwise `BuilderError`. `a` must be an expression.
- `toOrderItem(o)` — casts an `Order` to the compiler's `OrderItem`; no runtime work.
- `Fn` — interface of the `fn` namespace (14 members).
- `fn.count(a?)` — `count(*)` with no argument, `count(a)` with one; `Expr<bigint, 'int8'>`.
- `fn.sum(a)` / `fn.avg(a)` — numeric operands only; result type via `SumPg`/`SumOut`,
  `AvgPg`/`AvgOut` (`packages/pg-prime/src/query/ops.types.ts`), always `| null`.
- `fn.min(a)` / `fn.max(a)` — operand's own type and codec, `| null`.
- `fn.rank()` / `fn.denseRank()` / `fn.rowNumber()` — `Expr<bigint, 'int8'>`; meaningful only
  wrapped in `over(...)` (`packages/pg-prime/src/query/window.ts`).
- `fn.now()` — `now()`, `Expr<Date, 'timestamptz'>`.
- `fn.toTsvector(config, a)` — `to_tsvector($n::regconfig, a)`, `tsvector`.
- `fn.toTsquery` / `plaintoTsquery` / `phrasetoTsquery` / `websearchToTsquery(config, q)` —
  `<name>($n::regconfig, $n)`, `tsquery`; both `config` and `q` are text binds.

## Flow
1. Every operand goes through `node()` (`packages/pg-prime/src/query/fn.ts:71`), which delegates to
   `toExprNode`: AST nodes and fragments pass, anything else throws `BuilderError`.
2. `and`/`or` label each argument (`and() argument N`) and build one `bool` node
   (`packages/pg-prime/src/query/fn.ts:90`); the compiler emits `true`/`false` for zero args and
   collapses a single arg (`packages/pg-prime/src/compile/compiler.ts:411`).
3. `exists`/`notExists` resolve `q` with `queryAstOf` (`packages/pg-prime/src/query/fn.ts:106`).
4. `asc`/`desc` validate `nulls` with `nullsOf` (`packages/pg-prime/src/query/fn.ts:122`) and
   build an `order` node.
5. `fn.count` branches on argument count, not value (`packages/pg-prime/src/query/fn.ts:218`).
6. `fn.sum`/`fn.avg` read the operand codec (`codecOfOperand`, `packages/pg-prime/src/query/fn.ts:75`)
   and map it through `SUM_RESULT` (`:151`) / `AVG_RESULT` (`:161`) to the aggregate's result codec.
7. Full-text helpers cast the config bind to `regconfig` (`regconfig`, `packages/pg-prime/src/query/fn.ts:203`).

## Gotchas
- Unlike `packages/pg-prime/src/query/ops.ts`, nothing here binds a bare value: `and(x, undefined)`
  and `desc('id')` throw rather than compile to a `$1` bind.
- `fn.count(undefined)` is not `count(*)`: it has one argument and throws (`packages/pg-prime/src/query/fn.ts:218`).
- `nulls` is emitted as SQL keywords, so it is checked against the closed set at runtime
  (`packages/pg-prime/src/query/fn.ts:122`).
- `sum`/`avg` codecs for operand names outside the tables fall back: `sum` keeps the operand
  codec, `avg` uses `numeric` (`packages/pg-prime/src/query/fn.ts:228`, `:232`). `money` takes these paths.
- An untyped operand (bare fragment) has `unknownCodec`, so `sum`/`avg`/`min`/`max` over it decode
  with that fallback.
- `SUM_RESULT`/`AVG_RESULT` duplicate `SumPg`/`AvgPg` in `packages/pg-prime/src/query/ops.types.ts`;
  tests spot-check them, not row for row.
- `fn.rank`/`denseRank`/`rowNumber` outside `over(...)` compile but PostgreSQL rejects them.
- The regconfig cast avoids `to_tsvector(text, text)` (42883) and never splices the config name.

## Tests
- `packages/pg-prime/test/query/ops.test.ts` — goldens for every `fn.*` and boolean/order row in the
  manifest, and `sum`/`avg`/`min` result codecs. Run
  `pnpm --filter pg-prime exec vitest run test/query/ops.test.ts`.
- `packages/pg-prime/test/query/guards.test.ts` — `asc`/`desc` refusing an unknown NULLS position,
  `and`/`or`/`not` refusing non-expressions, `desc("id")`, `fn.count()` vs `fn.count(undefined)`.
  Run `pnpm --filter pg-prime exec vitest run test/query/guards.test.ts`.
- `packages/pg-prime/test/live-query/ops.test.ts` — server OIDs for aggregates per operand type,
  `fn.rank` under `rank() over ()`; `packages/pg-prime/test/live-query/setop-window.test.ts` covers
  `rowNumber`/`denseRank`. Run `pnpm --filter pg-prime exec vitest run test/live-query`.
- Type probes: `packages/pg-prime/test/query/types/ops.probe.ts` (`pnpm --filter pg-prime typecheck`).
- Uncovered: `fn.now`, `fn.denseRank`, `fn.rowNumber` have no manifest row or OID differential.

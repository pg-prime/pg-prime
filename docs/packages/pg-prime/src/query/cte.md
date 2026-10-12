# packages/pg-prime/src/query/cte.ts

## Purpose
The executor surface behind `db` and `tx`: `from`, `fromRaw`, `fromCte`, `with`, `withRecursive`, `insertInto`, `update`, `deleteFrom` and the `sql` tag. A CTE is registered as a table-like handle built from the statement's result shape, so it joins and filters like any table. Created by `makeExecutor` in `packages/pg-prime/src/query/run.ts:378` and `packages/pg-prime/src/session/handles.ts:269`; delegates to `makeSelect` (`select.ts`), `makeInsert`, `makeUpdate`, `makeDelete`, `makeRaw` (`raw.ts`) and `registerCte` / `registerRawFrom` (`scope.ts`).

## Public API
- `WithOpts` — `{ materialized?: boolean }`; `true` → `materialized`, `false` → `not materialized`, absent → planner decides.
- `RecursiveOpts` — `WithOpts` plus `unionAll?: boolean` (default `union all`; `false` → `union`).
- `FromRawOpts` — `{ alias?: string, columnTypes?: boolean }`.
- `ExecutorImpl` — immutable executor with `ctx`, `ctes`, `cte` (CTE handles by name), `h` (schema table handles), `registry` getter, and the methods below.
- `from(t, alias?)`, `fromCte(name, alias?)` — a `SelectBuilder`; `fromCte` throws listing declared CTEs when `name` is unknown.
- `fromRaw(frag, shape, opts?)` — a `SelectBuilder` over a hand-written FROM item; `shape` maps column key → codec.
- `with(name, f, opts?)`, `withRecursive(name, base, step, opts?)` — a new `ExecutorImpl` carrying one more CTE.
- `insertInto` / `update` / `deleteFrom(t, alias?)` — write builders carrying the declared CTEs; `` sql`…` `` — a `RawQuery`.
- `makeExecutor(ctx, handles)` — an executor with no CTEs.

## Flow
1. `with` refuses a duplicate name via `Object.hasOwn(this.cte, name)` (`packages/pg-prime/src/query/cte.ts:233`).
2. It runs `f(this)` once and requires a builder (`statementAstOf`), so writable CTEs (insert/update/delete) are accepted (`packages/pg-prime/src/query/cte.ts:237`).
3. `withoutDeclared` strips from the body's own `WITH` every CTE node the enclosing executor already declares, compared by identity (`packages/pg-prime/src/query/cte.ts:105`).
4. `fieldsOfStatement` reads the body's result shape: select projection, set-op left-most branch, or a write's `RETURNING` (`packages/pg-prime/src/query/cte.ts:72`).
5. A handle `{ [NAME]: name, $: derivedRuntime(name) }` is registered with those fields and a new executor is returned with the node appended (`packages/pg-prime/src/query/cte.ts:250`).
6. `withRecursive` runs `base`, registers the handle from the base's shape, then runs `step(this, handle)` and emits `base union [all] step` as a recursive CTE (`packages/pg-prime/src/query/cte.ts:277`).
7. `fromRaw` validates the shape and fragment, builds a `rawFrom` node once with the column alias list (plus types from `codec.sqlName` when `columnTypes`), registers it, and selects from it (`packages/pg-prime/src/query/cte.ts:184`).
8. Statement builders receive `this.ctes`, so a chain started by `.with()` emits the `WITH` list in whatever statement it ends in.

## Gotchas
- `` db.sql`…` `` does not prefix the declared CTEs; raw statements stay raw (`packages/pg-prime/src/query/cte.ts:321`).
- `withRecursive` callbacks must return a SELECT (`queryAstOf`); `with` accepts any statement builder.
- The recursive row type and codecs come from the base term only (`packages/pg-prime/src/query/cte.ts:260`).
- `fromRaw` requires a non-empty shape and a `sql` fragment; default alias is `raw`, checked by `checkAlias` against compiler-reserved `_rN` names; `__proto__` keys are refused (`packages/pg-prime/src/query/cte.ts:198`).
- `withoutDeclared` only removes nodes by identity; a CTE the callback declared itself stays nested (`packages/pg-prime/src/query/cte.ts:102`).
- CTE names are not checked by `checkAlias`; only aliases given to `from`/`fromCte` are.
- `insertInto` passes `this` as `owner` so `InsertBuilder.fromSelect(d => …)` sees the same CTEs (`packages/pg-prime/src/query/cte.ts:310`).

## Tests
- `packages/pg-prime/test/query/cte.test.ts` — `$n` ordering, codec flow, joins on a CTE, materialized flag, duplicates/unknown names, archive-and-move writable CTE, hoisted CTE list, `withRecursive`, `fromRaw`, chained `.with()` not re-declaring.
- `packages/pg-prime/test/query/guards.test.ts` — non-builder returned from `with`, CTE named `toString`.
- Live: `packages/pg-prime/test/live-query/cte.test.ts` (writable CTEs, recursion, `fromRaw` with `jsonb_to_recordset`).
- Run: `pnpm --filter pg-prime exec vitest run test/query/cte.test.ts`; live: `pnpm --filter pg-prime exec vitest run test/live-query/cte.test.ts`.

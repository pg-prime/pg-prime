# packages/pg-prime/src/query/terminals.ts

## Purpose
Shared implementations of the terminal operations (`toSQL`, `executeTakeFirst`, `stream`, `explain`, option folding) so the select, set-op, insert, update, delete, raw and prepared builders keep one-line methods. Called from `select.ts`, `insert.ts`, `update.ts`, `delete.ts`, `raw.ts`, `prepared.ts` and `src/session/handles.ts`; calls into `executor.ts` (`streamOn`, `explainOn`, `needsRollbackRail`, `bindsToParams`) and the `Runner` from `builder-state.ts`.

## Public API
- `PlaceholderRef` — `{ placeholder: string }`, an unfilled `.prepare()` hole in a snapshot.
- `SqlSnapshot` — frozen `{ sql, params, placeholders, meta }`; `params` are encoded wire values or `PlaceholderRef`.
- `toSQLOf(compiled, values?)` — builds a `SqlSnapshot`; fills placeholders from `values` when present, else reports them.
- `takeFirst(rows)` — `rows[0]`, or `undefined`.
- `withRunOption(base, patch)` — merges a builder option; returns `patch` itself when `base` is undefined.
- `mergeRun(run, opts)` — builder options under call options (call wins); no copy when either side is absent.
- `runnerOf(ctx)` — returns `ctx.runner`; throws `BuilderError` for a `compileOnly(schema)` builder.
- `streamWith(ctx, compiled, opts?)` — `AsyncIterable` over `runner.scope(conn => streamOn(...))`.
- `explainWith(ctx, compiled, opts?, run?)` — `EXPLAIN`, wrapped in a rollback rail for mutating `analyze` runs; rejects an `.ifVersion()` statement under `analyze: true, rollback: false`.
- `paramsOf(compiled, values?)` — encoded bind values via `bindsToParams`.

## Flow
1. `toSQLOf` maps each bind: value binds return `encoded`; placeholder binds use `values[name]` (null/undefined become `null`, else `codec.encode`), or `{ placeholder }` (`packages/pg-prime/src/query/terminals.ts:50`).
2. `streamWith` resolves the runner and hands `Runner.scope` a generator; consumer `break` runs `scope`'s `finally`, closing cursor and transaction (`packages/pg-prime/src/query/terminals.ts:129`).
3. `explainWith` refuses `analyze: true, rollback: false` on a statement with `meta.versionCheck` (`packages/pg-prime/src/query/terminals.ts:154`), then asks `needsRollbackRail(compiled, opts)`; if false it runs `explainOn` on a `runner.use` connection (`packages/pg-prime/src/query/terminals.ts:156`).
4. Otherwise it opens `begin`, or `savepoint pgprime_explain` inside a transaction, runs `explainOn`, then rolls back (and releases the savepoint) (`packages/pg-prime/src/query/terminals.ts:159`).
5. The result is rebuilt by `makeResult(..., true, ...)` to mark it rolled back; on error the undo runs best-effort and the error is rethrown (`packages/pg-prime/src/query/terminals.ts:173`).

## Gotchas
- `takeFirst` is deliberately not a portal `maxRows: 1` cap: a chunked insert compiles to several statements and `executeTakeFirst` must run them all; the cap would also misreport the command tag that `executeRowCount()` / `.ifVersion()` read (`packages/pg-prime/src/query/terminals.ts:66`).
- `toSQLOf` never throws on unfilled placeholders, but callers' `compile()` can still throw first (an unprojected select, a chunked insert, an update/delete with no `where`).
- The rollback rail statements are sent in `simple` mode; inside a transaction the rail is a savepoint, never a nested `BEGIN` (`packages/pg-prime/src/query/terminals.ts:160`).
- `mergeRun` / `withRunOption` return the input object by reference when the other side is absent; callers must not mutate the result.
- `paramsOf` has no caller in `src/` or `test/`.

## Tests
- `packages/pg-prime/test/query/executor.test.ts` — `toSQL()` (encoded binds, unfilled placeholder, write builders), `executeTakeFirst` (byte-identical SQL, no portal cap, chunked insert runs every chunk).
- `packages/pg-prime/test/query/explain.test.ts` — wire options and the ANALYZE rail (begin/rollback, savepoint in a transaction, `rollback: false`, failure undo).
- `packages/pg-prime/test/query/stream.test.ts` — begin/declare/fetch/close/commit, `break` and throw unwinding, joining a caller transaction.
- `packages/pg-prime/test/query/prepared.test.ts` — `toSQL()` with and without values.
- `packages/pg-prime/test/query/version.test.ts` — the explain refusal through the builder, `db.explain` and `prepare().explain`.
- Live: `packages/pg-prime/test/live-query/executor.test.ts` (`executeTakeFirst`, `stream()`, `explain()` against a server).
- Run: `pnpm --filter pg-prime exec vitest run test/query/executor.test.ts test/query/explain.test.ts test/query/stream.test.ts`; live: `pnpm --filter pg-prime exec vitest run test/live-query/executor.test.ts`.

# packages/pg-prime/src/query/builder-state.ts

## Purpose
Type-only module declaring the frozen state records every query builder wraps, the `Runner` seam between builders and the session layer, and the builder-level run-option bag. Imported (as types) by `select.ts`, `insert.ts`, `update.ts`, `delete.ts`, `cte.ts`, `scope.ts`, `terminals.ts`, `raw.ts`, `prepared.ts`, `relations.ts`, `run.ts`, `src/session/handles.ts`, and `src/session/runner.ts`, which implements `Runner`.

## Public API
- `Runner` — `run`, `runCounted` (rows plus the command tag's `rowCount`), `runChunked` (atomic multi-statement, opens a transaction unless `inTransaction`), `use` (one connection), `scope` (one connection plus one transaction for an async iteration), `env: ExecEnv`, `inTransaction`.
- `QueryRunOptions` — `RunOptions` plus `timeoutMs` and `outsideTransaction`; what `.signal()` / `.timeout()` / `.outsideTransaction()` / `.withExecMode()` accumulate.
- `BuilderCtx` — `registry`, `runner` (`undefined` for `compileOnly()` builders), `tables`, `rels`.
- `Scopes` — `{ byAlias }` record of `RefScope`s.
- `SelectState`, `SetOpState` — select clauses (ctes, distinct, projection, from, joins, where, groupBy, having, windows, orderBy, limit, offset, locking) plus `sources`, `scope`, `run`; set-op node plus `resultRefs`.
- `InsertState`, `BulkOpts` — insert target, columns, source, `castFirstRow`, `onConflict`, `returning`, unencoded `rows`, `bulk`, `owner`; `BulkOpts` is `{ strategy?: 'values'|'unnest'|'auto', chunkSize? }`.
- `UpdateState`, `DeleteState` — target/from, `set`/`using`, `where`, `returning`, `sources`, `scope`, `allRows`, `version`, `run`; update also carries `from`, `valuesAlias`, `handle`.
- `VersionState` — `{ expr, expected }`, `.ifVersion()`'s check, kept out of `where`.

## Flow
1. A `make*` factory (`select.ts`, `insert.ts`, `update.ts`, `delete.ts`) builds the initial state; the builder constructor freezes it.
2. Every builder method returns a new builder over `{ ...state, ...patch }`; AST nodes are shared by reference, never cloned.
3. Terminals read `ctx.runner` through `runnerOf` in `terminals.ts` and pass `state.run` into `Runner.run`, the same bag the handle path folds via `BaseRunner.merged`.

## Gotchas
- The module must export no runtime value: the tree-shake goldens under `fixtures/treeshake/*/expected-modules.json` assume `builder-state.js` is absent from bundles (`packages/pg-prime/src/query/builder-state.ts:105`). Helpers that fold options live in `terminals.ts`.
- The compiled artifact is deliberately not part of the state; builders memoise `compile()` on the instance so a copied state cannot carry a stale memo (`packages/pg-prime/src/query/builder-state.ts:20`).
- `QueryRunOptions` is declared here rather than imported from `src/session/types.ts` because the builder layer must not depend on the session layer (`packages/pg-prime/src/query/builder-state.ts:95`).
- `InsertState.owner` is typed `unknown` to avoid an import cycle with `cte.ts` (`packages/pg-prime/src/query/builder-state.ts:181`).
- `SelectState.sources` keeps alias → handle so every scope can be re-derived when the alias set grows (`packages/pg-prime/src/query/builder-state.ts:142`).
- `PoolRunner` and `ConnRunner` (both `packages/pg-prime/src/session/runner.ts:279`, `:512`, over `BaseRunner` at `:202`) are the implementations; the `db` vs `tx` difference lives entirely behind `Runner`.

## Tests
- No dedicated spec; the shapes are exercised through every builder spec in `packages/pg-prime/test/query/` (unit) and `packages/pg-prime/test/live-query/` (live).
- The runtime-free property is checked by `pnpm treeshake` at the repo root (`tools/treeshake-check.mjs`).
- Run: `pnpm --filter pg-prime exec vitest run test/query`.

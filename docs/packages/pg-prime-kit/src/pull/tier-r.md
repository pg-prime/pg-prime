# packages/pg-prime-kit/src/pull/tier-r.ts

## Purpose
Reads Tier-R objects (functions, procedures, views, materialized views, aggregates, triggers) straight from `pg_catalog` and renders each as an idempotent `sql/` repeatable file for `pg-prime pull`. These objects are not IR facts, so `extractCatalog` does not carry them. Called only by `pullSchema` in `packages/pg-prime-kit/src/pull/pull.ts:49`.

## Public API
- `TierRObject` — `{ kind, schema, identity, path, sql }`; `kind` is `prelude`, `function`, `view`, `matview`, `aggregate` or `trigger`; `path` is POSIX and starts with `prefix`.
- `TierRResult` — `{ objects, unsupported }`; `unsupported` is `{ kind, name, reason }[]`.
- `readTierR(client, schemas, prefix = "sql")` — runs the Tier-R queries and returns `TierRResult`. Query errors propagate.

## Flow
1. Functions and procedures (aggregates and extension members excluded) via `pg_get_functiondef`; if any exist, a `prelude` object `000_prelude.sql` with `SET check_function_bodies = false` is emitted first (`packages/pg-prime-kit/src/pull/tier-r.ts:163`).
2. Each function goes to `010_functions/<schema>__<name>__<args>.sql` with a `-- pg-prime:object function <identity>` header (`packages/pg-prime-kit/src/pull/tier-r.ts:177`).
3. Views become `CREATE OR REPLACE VIEW … WITH (security_invoker = <real value>[, security_barrier = true])` in `020_views/`, with a comment explaining the value (`packages/pg-prime-kit/src/pull/tier-r.ts:190`).
4. Matview indexes are collected and rewritten to `CREATE [UNIQUE] INDEX IF NOT EXISTS` (`packages/pg-prime-kit/src/pull/tier-r.ts:221`).
5. Matviews become `CREATE MATERIALIZED VIEW IF NOT EXISTS` followed by their indexes, in `030_matviews/` (`packages/pg-prime-kit/src/pull/tier-r.ts:225`).
6. Aggregates become `DROP AGGREGATE IF EXISTS` + `CREATE AGGREGATE (SFUNC, STYPE[, FINALFUNC][, INITCOND])` in `015_aggregates/` (`packages/pg-prime-kit/src/pull/tier-r.ts:250`).
7. Triggers become `DROP TRIGGER IF EXISTS` + `pg_get_triggerdef` in `070_triggers/` (`packages/pg-prime-kit/src/pull/tier-r.ts:277`).

## Gotchas
- RLS flags and policies are not read here: `pull` writes them as DSL (`rls.*()`, `definePolicy`) from `readLaneState` (design/20 D18). `pullSchema` filters the converted `pgprime_set_<col>` trigger and function out of this module's result.
- Every file must be idempotent because `checkIdempotence` (TX201) rejects repeatables that are not; hence `OR REPLACE`, `IF NOT EXISTS` and drop-then-create.
- Apply order is the directory prefix (`000` < `010` < `015` < `020` < … < `070`), not the order objects are pushed: aggregates are read after matviews but filed as `015` so views can call them.
- `security_invoker` is written as found (PostgreSQL default `false`), never upgraded to `true` (`packages/pg-prime-kit/src/pull/tier-r.ts:200`).
- A changed matview is never replaced: `IF NOT EXISTS` means a re-apply with a new query is a no-op until someone drops it.
- Extension-owned functions, views, matviews and aggregates are excluded via `pg_depend deptype = 'e'` (`packages/pg-prime-kit/src/pull/tier-r.ts:61`); triggers and matview indexes have no such filter.
- `stmt()` normalizes trailing semicolons to exactly one (`packages/pg-prime-kit/src/pull/tier-r.ts:46`); `fileSlug` folds identifiers to `[A-Za-z0-9_]`, max 80 chars, so distinct objects can in principle share a slug.
- Aggregate support covers only SFUNC/STYPE/FINALFUNC/INITCOND; other aggregate options (combine functions, moving-aggregate state, sort operators) are not read.
- `unsupported` is always returned empty by the current code.

## Tests
- Exercised end to end by `packages/pg-prime-kit/test/pull/roundtrip.test.ts` (third-party corpora, including pagila's views, aggregates and triggers) and `packages/pg-prime-kit/test/pull/ddl-closeout.test.ts`.
- Run: `pnpm --filter @pg-prime/kit exec vitest run test/pull` (needs a real PostgreSQL server, `PG_PRIME_TEST_URL`).
- No unit test imports `readTierR` directly; the `security_invoker` note text and matview-index rewriting have no dedicated assertions.

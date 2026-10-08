# packages/pg-prime-kit/src/pull/tier-r.ts

## Purpose
Reads Tier-R objects (functions, procedures, views, materialized views, RLS enablement, policies, aggregates, triggers) straight from `pg_catalog` and renders each as an idempotent `sql/` repeatable file for `pg-prime pull`. These objects are not IR facts, so `extractCatalog` does not carry them. Called only by `pullSchema` in `packages/pg-prime-kit/src/pull/pull.ts:48`.

## Public API
- `TierRObject` — `{ kind, schema, identity, path, sql }`; `kind` is `prelude`, `function`, `view`, `matview`, `rls`, `policy`, `aggregate` or `trigger`; `path` is POSIX and starts with `prefix`.
- `TierRResult` — `{ objects, unsupported }`; `unsupported` is `{ kind, name, reason }[]`.
- `readTierR(client, schemas, prefix = "sql")` — runs the Tier-R queries and returns `TierRResult`. Query errors propagate.

## Flow
1. Functions and procedures (aggregates and extension members excluded) via `pg_get_functiondef`; if any exist, a `prelude` object `000_prelude.sql` with `SET check_function_bodies = false` is emitted first (`packages/pg-prime-kit/src/pull/tier-r.ts:185`).
2. Each function goes to `010_functions/<schema>__<name>__<args>.sql` with a `-- pg-prime:object function <identity>` header (`packages/pg-prime-kit/src/pull/tier-r.ts:199`).
3. Views become `CREATE OR REPLACE VIEW … WITH (security_invoker = <real value>[, security_barrier = true])` in `020_views/`, with a comment explaining the value (`packages/pg-prime-kit/src/pull/tier-r.ts:212`).
4. Matview indexes are collected and rewritten to `CREATE [UNIQUE] INDEX IF NOT EXISTS` (`packages/pg-prime-kit/src/pull/tier-r.ts:243`).
5. Matviews become `CREATE MATERIALIZED VIEW IF NOT EXISTS` followed by their indexes, in `030_matviews/` (`packages/pg-prime-kit/src/pull/tier-r.ts:247`).
6. RLS-enabled tables get `ENABLE` (and `FORCE` when set) ROW LEVEL SECURITY in `040_rls/` (`packages/pg-prime-kit/src/pull/tier-r.ts:271`).
7. Policies become `DROP POLICY IF EXISTS` + `CREATE POLICY` in `050_policies/` (`packages/pg-prime-kit/src/pull/tier-r.ts:288`).
8. Aggregates become `DROP AGGREGATE IF EXISTS` + `CREATE AGGREGATE (SFUNC, STYPE[, FINALFUNC][, INITCOND])` in `015_aggregates/` (`packages/pg-prime-kit/src/pull/tier-r.ts:317`).
9. Triggers become `DROP TRIGGER IF EXISTS` + `pg_get_triggerdef` in `070_triggers/` (`packages/pg-prime-kit/src/pull/tier-r.ts:344`).

## Gotchas
- Every file must be idempotent because `checkIdempotence` (TX201) rejects repeatables that are not; hence `OR REPLACE`, `IF NOT EXISTS` and drop-then-create.
- Apply order is the directory prefix (`000` < `010` < `015` < `020` < … < `070`), not the order objects are pushed: aggregates are read after policies but filed as `015` so views can call them.
- `security_invoker` is written as found (PostgreSQL default `false`), never upgraded to `true` (`packages/pg-prime-kit/src/pull/tier-r.ts:222`).
- A changed matview is never replaced: `IF NOT EXISTS` means a re-apply with a new query is a no-op until someone drops it.
- Extension-owned functions, views, matviews and aggregates are excluded via `pg_depend deptype = 'e'` (`packages/pg-prime-kit/src/pull/tier-r.ts:61`); triggers, policies and matview indexes have no such filter.
- `stmt()` normalizes trailing semicolons to exactly one (`packages/pg-prime-kit/src/pull/tier-r.ts:46`); `fileSlug` folds identifiers to `[A-Za-z0-9_]`, max 80 chars, so distinct objects can in principle share a slug.
- Aggregate support covers only SFUNC/STYPE/FINALFUNC/INITCOND; other aggregate options (combine functions, moving-aggregate state, sort operators) are not read.
- `unsupported` is always returned empty by the current code.

## Tests
- Exercised end to end by `packages/pg-prime-kit/test/pull/roundtrip.test.ts` (third-party corpora, including pagila's views, aggregates and triggers) and `packages/pg-prime-kit/test/pull/ddl-closeout.test.ts`.
- Run: `pnpm --filter @pg-prime/kit exec vitest run test/pull` (needs a real PostgreSQL server, `PG_PRIME_TEST_URL`).
- No unit test imports `readTierR` directly; the `security_invoker` note text, `FORCE ROW LEVEL SECURITY` and matview-index rewriting have no dedicated assertions.

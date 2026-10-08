# packages/pg-prime-kit/src/pull/pull.ts

## Purpose
Implements `pg-prime pull`: reads a live database and produces a deterministic TypeScript schema file, Tier-R `sql/` repeatables and a `pull.report.json`. Called only by `packages/pg-prime-kit/src/cli/commands/pull.ts`; calls `extractCatalog` and `readLaneState` (`catalog/extract.ts`), `readTierR` (`pull/tier-r.ts`), `emitTypeScript` (`pull/emit-ts.ts`) and `withClient` (`db/pg.ts`).

## Public API
- `PullInput` — `{ connection, schemas, out, sqlDir? }`; `out` is the `.ts` path, `sqlDir` the repeatables root (absent means Tier-R objects become residue).
- `PullResult` — `{ ts, repeatables, unsupported, counts, observed, diagnostics, fingerprint }`.
- `pullSchema(input)` — reads the database and returns a `PullResult`; writes nothing.
- `WrittenPull` — `{ out, report, repeatables }` absolute paths written.
- `writePull(input, result)` — writes the `.ts`, each repeatable under `sqlDir` and `pull.report.json` beside `out`; overwrites existing files. Throws if a repeatable path resolves outside `sqlDir`.

## Flow
1. Dedupe and sort `schemas`, open one connection with `withClient` (`packages/pg-prime-kit/src/pull/pull.ts:44`).
2. `extractCatalog(client, { schemas, observe: true })` builds the IR and Tier-O observations (`packages/pg-prime-kit/src/pull/pull.ts:46`).
3. `readLaneState` reads RLS flags, policies and marked `pgprime_set_<col>` triggers; those on a `timestamp with time zone` column become `updatedAtTrigger`s (`packages/pg-prime-kit/src/pull/pull.ts:47`, `:51`).
4. `readTierR(client, schemas, prefix)` reads functions, views, matviews, aggregates, triggers, minus the converted triggers and their `pgprime_set_<col>()` functions; `prefix` is the basename of `sqlDir`, else `"sql"` (`packages/pg-prime-kit/src/pull/pull.ts:63`).
5. Without `sqlDir`, every Tier-R object becomes an `UnsupportedItem` with a "--sql-dir was not given" reason (`packages/pg-prime-kit/src/pull/pull.ts:66`).
6. `emitTypeScript(ir, { schemas, sqlDir: prefix, repeatableCount, extraUnsupported, lane })` renders the file (`packages/pg-prime-kit/src/pull/pull.ts:75`).
7. Return the TS text, repeatables (empty when no `sqlDir`), unsupported items, counts, `observedCounts(observed)`, diagnostics and the IR fingerprint.
8. `writePull` writes `out`, strips the first path segment of each repeatable's `path` and joins it onto `sqlDir` (`packages/pg-prime-kit/src/pull/pull.ts:120`).
9. Writes `pull.report.json` (`formatVersion: 1`, `generatedAt`, database, schemas, fingerprint, counts, repeatables, sorted unsupported, observed, non-info diagnostics) (`packages/pg-prime-kit/src/pull/pull.ts:134`).

## Gotchas
- Database access is one `REPEATABLE READ READ ONLY` extraction plus the Tier-R catalog queries, which run outside that snapshot on the same connection.
- `TierRObject.path` begins with the sql dir's own basename; `writePull` drops that segment before joining, or the tree would nest (`packages/pg-prime-kit/src/pull/pull.ts:118`).
- `writePull` overwrites by design so a second pull can be compared byte-for-byte; unlike `writePlan` it treats output as a re-takeable snapshot.
- The report omits `info` diagnostics, so `unmodeled_kind`, `volatile_default` and `observation_unavailable` never reach it (`packages/pg-prime-kit/src/pull/pull.ts:147`).
- `generatedAt` makes `pull.report.json` non-deterministic; only the `.ts` is byte-stable.
- `writePull` never deletes repeatable files for objects that no longer exist.

## Tests
- `packages/pg-prime-kit/test/pull/roundtrip.test.ts` — pulls the third-party corpora through the CLI, requires `migrate generate` against the same DB to be `up_to_date`, a second pull to be byte-identical, and residue to match a per-corpus expectation.
- `packages/pg-prime-kit/test/pull/ddl-closeout.test.ts` — EXCLUDE, generated columns, expression indexes, `WITH` options and comments round-trip with empty residue; repeats as a `NOCREATEDB` role.
- `packages/pg-prime-kit/test/pull/rls.test.ts` — RLS flags, policies and `updatedAtTrigger` as DSL, what leaves `sql/`, and the emitted policies re-created identically on a fresh database (needs `CREATE ROLE`).
- `packages/pg-prime-kit/test/cli/golden/pull.written.json` — CLI envelope golden.
- Run: `pnpm --filter @pg-prime/kit exec vitest run test/pull` (needs a real PostgreSQL server, `PG_PRIME_TEST_URL`; CLI tests use the built `dist/` from `test/globalSetup.ts`).
- Uncovered: the path-escape guard in `writePull` and the no-`sqlDir` residue path have no direct test found.

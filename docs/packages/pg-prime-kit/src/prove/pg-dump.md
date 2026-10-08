# packages/pg-prime-kit/src/prove/pg-dump.ts

## Purpose
The `pg_dump` equality oracle: spawns PostgreSQL's own `pg_dump` against two databases and compares the schema-only dumps as statement multisets, catching attributes the kit's extractor does not model. Called by `runDumpOracle` in `packages/pg-prime-kit/src/prove/prove.ts:306` and by `packages/pg-prime-kit/src/prove/temp-schema.ts`; `DumpOracleVerdict` is stored on `.plan.json` via `plan/plan.ts`. Uses `splitStatements`/`codeMask` from `sql/statements.ts` and `connectionString`/`withDatabase` from `db/pg.ts`.

## Public API
- `DumpOracleMode` — `"off" | "warn" | "strict"`.
- `DumpOracleVerdict` — `{ status: "passed"|"failed"|"skipped", mode, reason?, pgDumpVersion?, statementCount?, missingCount?, extraCount?, reordered?, missing?, extra? }`.
- `DUMP_SAMPLE_CAP` — `20`, max sampled statements per direction. `DUMP_TIMEOUT_MS` — `120_000`, per-dump kill timeout.
- `PgDumpLauncher` — `{ argv, uri? }`; `uri(database)` builds the conninfo, default is a password-less URI.
- `ResolvedPgDump` — `{ argv, version, major, uri? }`.
- `parseLauncherEnv(raw)` — parses `PG_PRIME_PG_DUMP` as a JSON string array or whitespace-split argv; returns `null` when malformed or empty.
- `SpawnFailure` — error (code `PG_PRIME_PG_DUMP_SPAWN_FAILED`) for a launcher that cannot start; callers map it to `skipped`.
- `resolvePgDump(explicit?)` — returns `ResolvedPgDump` or `{ unavailable: reason }`; never throws.
- `DumpRequest` — `{ pgDump, conn, database, schemas, timeoutMs?, signal? }`.
- `schemaPattern(schema)` — double-quotes a schema name so `--schema` matches it literally.
- `dumpSchema(req)` — runs a schema-only dump and returns stdout; throws on non-zero exit, timeout or abort.
- `normalizeDump(raw)` — splits into statements, drops session preamble, sorts.
- `tableReorderKey(statement)` — `CREATE TABLE` with its element list sorted, plus the table name; `null` for other statements.
- `DumpComparison` / `compareDumps(cloneDump, desiredDump)` — multiset diff into `missing`, `extra`, `reordered`, `statementCount`, `equal`.

## Flow
1. `resolvePgDump` picks argv: explicit launcher, else `PG_PRIME_PG_DUMP`, else `["pg_dump"]`; `PG_PRIME_PG_DUMP_URI` (with `{db}`) supplies `uri` (`packages/pg-prime-kit/src/prove/pg-dump.ts:176`).
2. It runs `--version`, parses the major from the first number, and returns `unavailable` on spawn failure, non-zero exit or unparseable output (`packages/pg-prime-kit/src/prove/pg-dump.ts:194`).
3. `dumpSchema` builds the target conninfo (custom `uri`, or `connectionString` with an empty password) (`packages/pg-prime-kit/src/prove/pg-dump.ts:234`).
4. Runs `--schema-only --no-owner --no-privileges --no-password` plus one quoted `--schema` per managed schema, passing the password only via `PGPASSWORD` (`packages/pg-prime-kit/src/prove/pg-dump.ts:240`).
5. `run` spawns the child, collects stdout/stderr, kills it with `SIGKILL` on timeout or abort signal (`packages/pg-prime-kit/src/prove/pg-dump.ts:115`).
6. `compareDumps` normalizes both dumps and computes `missing` (desired-only) and `extra` (clone-only) as multisets (`packages/pg-prime-kit/src/prove/pg-dump.ts:360`).
7. Missing/extra `CREATE TABLE` pairs with the same `tableReorderKey` are moved to `reordered`; `equal` ignores `reordered` (`packages/pg-prime-kit/src/prove/pg-dump.ts:376`).

## Gotchas
- `--schema` takes a pattern; without `schemaPattern` quoting, mixed-case names match nothing (`packages/pg-prime-kit/src/prove/pg-dump.ts:228`).
- `PREAMBLE` is an allowlist of session `SET`s; any other `SET` (e.g. `default_table_access_method`) is kept as schema-bearing (`packages/pg-prime-kit/src/prove/pg-dump.ts:262`). `set_config('search_path', …)` is also dropped.
- `normalizeDump` sorts statements, so emission order is ignored; duplicates still count.
- `pg_dump` 17.6+ `\restrict <token>` meta-commands must not survive normalization or every run differs; this is handled by `splitStatements` (asserted in `test/dump-oracle.test.ts`).
- Column-order-only differences are reported in `reordered` and never fail, since PostgreSQL cannot reorder columns (`packages/pg-prime-kit/src/prove/pg-dump.ts:312`).
- `skipped` is reserved for environment gaps (no launcher, spawn failure, version unreadable); a dump that ran and failed is `failed` (classification is done in `prove.ts`).
- The default URI omits the password so it never appears in the process table; a custom `uri` from `PG_PRIME_PG_DUMP_URI` is URL-encoded per database name (`packages/pg-prime-kit/src/prove/pg-dump.ts:190`).
- A malformed `PG_PRIME_PG_DUMP` yields `unavailable` rather than falling back to `pg_dump` on PATH (`packages/pg-prime-kit/src/prove/pg-dump.ts:182`).
- `packages/pg-prime-kit/test/setup.ts` sets `PG_PRIME_PG_DUMP`/`PG_PRIME_PG_DUMP_URI` to a `docker exec` launcher for all kit tests when no local `pg_dump` resolves.

## Tests
- `packages/pg-prime-kit/test/dump-oracle.test.ts` — normalization, preamble stripping, multiset direction, NOT NULL names kept, `tableReorderKey`, `parseLauncherEnv`; live: converged plan dumps identically, column order on a live migration, an IR blind spot caught by the oracle.
- `packages/pg-prime-kit/test/oracle-strict.test.ts` — `schemaPattern` quoting, malformed `PG_PRIME_PG_DUMP`, strict gating on failed/skipped verdicts.
- Also used by `test/corpus-thirdparty.test.ts` and `test/schema-emit/roundtrip.test.ts`.
- Run: `pnpm --filter @pg-prime/kit exec vitest run test/dump-oracle.test.ts test/oracle-strict.test.ts`; the live cases need a real server (`PG_PRIME_TEST_URL`) and a `pg_dump` at least as new as it.
- Uncovered: timeout kill and sibling abort paths of `run` have no direct test found.

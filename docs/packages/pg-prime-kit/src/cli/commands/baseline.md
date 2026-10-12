# packages/pg-prime-kit/src/cli/commands/baseline.ts

## Purpose
`pg-prime migrate baseline`: adopts an existing database. Without `--at` it introspects the live catalog, writes `0000_baseline.sql` + `.plan.json` through the ordinary create path, and records the row as `baselined` without executing anything; with `--at <id>` it marks existing migration files as baselined. Registered at `packages/pg-prime-kit/src/cli/main.ts:129`; callees are `extractCatalog`, `diffIR`, `buildStatements`, `orderStatements`, `buildPlan`, `writePlan`, `readMigrationsDir` and the history helpers `ensureHistory`, `readMigrationRows`, `beginRow`, `markApplied`.

## Public API
- `BASELINE_OPTIONS: readonly OptionSpec[]` — `--at <id>`, `--force`, `--by <name>`.
- `runBaseline(config: ResolvedConfig, argv: ParseResult): Promise<CommandOutput>` — status `baselined`, `marked` (exit 0) or `refused` (exit 1, error code `baseline_refused`).

## Flow
1. Open one client; `ensureHistory` then `readMigrationRows` (`packages/pg-prime-kit/src/cli/commands/baseline.ts:47`).
2. Any existing row without `--force` is a refusal naming up to three ids (`packages/pg-prime-kit/src/cli/commands/baseline.ts:49`).
3. `appliedFrom` is `config.env ?? null`; `engineVersion` is `ENGINE.version` (`packages/pg-prime-kit/src/cli/commands/baseline.ts:61`).
4. `--at`: find the file by `id`, zero-padded `seq`, or `name`; refuse when none matches (`packages/pg-prime-kit/src/cli/commands/baseline.ts:66`).
5. Adopt every file ordered at or before the target (`seq`, then `name`), not only the target (`packages/pg-prime-kit/src/cli/commands/baseline.ts:71`).
6. For each: `beginRow` with all statements counted applied, `markApplied`, then `UPDATE … SET status = 'baselined'` (`packages/pg-prime-kit/src/cli/commands/baseline.ts:73`). Returns status `marked`.
7. No `--at`: `extractCatalog` on the managed schemas, then `freshDatabaseIR` as the "from" IR (`packages/pg-prime-kit/src/cli/commands/baseline.ts:120`).
8. `diffIR(empty, current)` → `buildStatements` → `orderStatements`; diagnostics from all three are collected (`packages/pg-prime-kit/src/cli/commands/baseline.ts:122`).
9. `buildPlan` with seq 0, name `baseline`, and `proof: { status: "skipped", reason: "baseline" }` (`packages/pg-prime-kit/src/cli/commands/baseline.ts:127`).
10. `writePlan(..., { allowUnproven: true })`; a `WriteRefusedError` becomes a refusal (`packages/pg-prime-kit/src/cli/commands/baseline.ts:146`).
11. Record `0000_baseline` the same way as step 6 (`packages/pg-prime-kit/src/cli/commands/baseline.ts:152`); non-`info` diagnostics become `warnings`.

## Gotchas
- `freshDatabaseIR` keeps only facts `initdb` created: managed schemas and extensions with OID below `FirstNormalObjectId` (16384), plus comments on those schemas (`packages/pg-prime-kit/src/cli/commands/baseline.ts:216`). Using the null IR instead would make the baseline's `from.fingerprint` unreachable on replay, breaking `verify`.
- `ensureHistory` runs before the refusal check, so even a refused baseline creates the `pgprime` schema (`packages/pg-prime-kit/src/cli/commands/baseline.ts:47`).
- History is written row-by-row on the open client with no explicit transaction; a mid-loop failure leaves earlier rows recorded.
- The `--at` path records each file's plan fingerprints (or `null` for hand-written SQL) and does not touch the catalog.
- `--force` does not delete existing rows; it only skips the refusal. `beginRow` upserts (`ON CONFLICT (id) DO UPDATE`, `packages/pg-prime-kit/src/history/store.ts:177`), but an existing `0000_baseline.sql` on disk makes `writePlan` throw `UnsafePlanPathError` (a `WriteRefusedError`), which is reported as a refusal (`packages/pg-prime-kit/src/plan/emit.ts:116`).
- The `--at` envelope reports `written: null` and `migration: null` (`packages/pg-prime-kit/src/cli/commands/baseline.ts:105`).

## Tests
- `packages/pg-prime-kit/test/cli/envelope.test.ts` — baseline writes `0000_baseline` and records it unexecuted; `--by` defaults to the OS user; goldens `test/cli/golden/baseline.{baselined,refused}.json`.
- `packages/pg-prime-kit/test/runner/baseline.test.ts` — the written baseline reproduces the schema on an empty database; refusal without `--force`; `--at` adopts up to and including the named file.
- `packages/pg-prime-kit/test/corpus-thirdparty.test.ts` — baseline → verify → `pg_dump` witness over a third-party corpus.
- Run: `pnpm --filter @pg-prime/kit exec vitest run test/runner/baseline.test.ts`. Needs a real server (`PG_PRIME_TEST_URL`).
- Uncovered at this layer: the `WriteRefusedError` refusal path.

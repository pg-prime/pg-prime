# packages/pg-prime-kit/src/cli/commands/doctor.ts

## Purpose
`pg-prime migrate doctor`: a read-only health report over the catalog and the `pgprime` history — INVALID indexes, `_ccnew` leftovers, NOT VALID constraints, fingerprint drift, missing files, partially applied rows, stale leases, orphaned repeatables, plus the Tier-O and Tier-U census. Registered at `packages/pg-prime-kit/src/cli/main.ts:172`; callees are `historyPresent`, `readMigrationRows`, `readRepeatableRows`, `currentFingerprint`, `inspectLease`, `extractCatalog`, `observedCounts`, `planRepeatables` and `readMigrationsDir`.

## Public API
- `DOCTOR_OPTIONS: readonly OptionSpec[]` — `--stale-lock-after <duration>`.
- `runDoctor(config: ResolvedConfig, argv: ParseResult): Promise<CommandOutput>` — status `healthy` (exit 0) or `findings` (exit 4).

## Flow
1. `staleAfter` is the flag, else `config.config.staleLockAfterMs` (`packages/pg-prime-kit/src/cli/commands/doctor.ts:68`).
2. On one client: `historyPresent`, migration rows only if present, `inspectLease`, the catalog queries, and `extractCatalog` with `observe: true` (`packages/pg-prime-kit/src/cli/commands/doctor.ts:71`).
3. `catalogFindings` runs three queries scoped to the managed schemas: `NOT indisvalid` indexes, indexes named `%\_ccnew%`, and `NOT convalidated` constraints (`packages/pg-prime-kit/src/cli/commands/doctor.ts:38`).
4. Fingerprint drift: `currentFingerprint(rows)` is non-null and differs from the live IR fingerprint (`packages/pg-prime-kit/src/cli/commands/doctor.ts:78`).
5. Missing files are recorded ids with no file on disk; partial rows are `running`, or `failed` with `statementsApplied > 0` (`packages/pg-prime-kit/src/cli/commands/doctor.ts:85`).
6. `planRepeatables` against tracked checksums yields `orphaned` paths (recorded but gone from disk) and `toApply` drift (`packages/pg-prime-kit/src/cli/commands/doctor.ts:91`).
7. Tier O census via `observedCounts`; Tier U census from `unmodeled_kind` diagnostics (`packages/pg-prime-kit/src/cli/commands/doctor.ts:95`).
8. Each finding becomes one human sentence with a fix; any finding means exit 4 (`packages/pg-prime-kit/src/cli/commands/doctor.ts:100`).

## Gotchas
- Never calls `ensureHistory`: a database pg-prime never touched reports `history.present: false` instead of acquiring a `pgprime` schema (`packages/pg-prime-kit/src/cli/commands/doctor.ts:8`). `inspectLease` also returns a null lease when history is absent (`packages/pg-prime-kit/src/runner/run.ts:1238`).
- Exit 4 is `EXIT.drift`, reused for every finding kind, not only drift (`packages/pg-prime-kit/src/cli/commands/doctor.ts:130`).
- Only a STALE lease is a finding; a live lease shows as `held` in text and `lock.held` in the envelope without affecting the exit code.
- Repeatable drift (`repeatables.drift`), Tier-O and Tier-U counts are reported but never findings.
- The fingerprint values stay in `history` rather than in the finding sentence, keeping terminal output and goldens stable (`packages/pg-prime-kit/src/cli/commands/doctor.ts:109`).
- An orphaned repeatable's objects remain in the database; removal is never auto-detected or dropped.

## Tests
- `packages/pg-prime-kit/test/cli/authoring.test.ts` — healthy on a clean database; then an INVALID index plus fingerprint drift in one report (exit 4); goldens `test/cli/golden/doctor.{healthy,findings}.json`.
- `packages/pg-prime-kit/test/cli/repeatables.test.ts` — names a repeatable recorded but gone from disk.
- Run: `pnpm --filter @pg-prime/kit exec vitest run test/cli/authoring.test.ts`. Needs a real server (`PG_PRIME_TEST_URL`).
- Uncovered: `_ccnew` and NOT VALID findings, the stale-lease finding, partially applied rows.

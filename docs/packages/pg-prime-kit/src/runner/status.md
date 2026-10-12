# packages/pg-prime-kit/src/runner/status.ts

## Purpose
`migrate status`: a read-only report of applied vs pending migrations, the fingerprint of record, partial and orphaned rows, checksum drift, the lease, repeatable drift and batched data-migration progress. Never creates the history schema.
Callers: `src/cli/commands/status.ts`, `src/cli/commands/check.ts`; re-exported from `src/index.ts`.
Callees: `runner/files.ts` (`readMigrationsDir`), `history/schema.ts` (`historyPresent`, `historyVersion`), `history/store.ts` (row, repeatable and data-progress reads), `runner/run.ts` (`inspectLease`, `NO_REPEATABLES`), `checkpoint/checkpoint.ts` (`describeDrift`), `catalog/extract.ts` (`extractCatalog`).

## Public API
- `migrationStatus(conn, migrationsDir, options?)` — opens a connection with `withClient` and runs `migrationStatusOn`.
- `migrationStatusOn(client, migrationsDir, options?)` → `StatusReport` — the same report on a caller-owned client.
- `StatusOptions` — `schemas` (default `["public"]`), `verifyFingerprint`, `staleLockAfterMs`, `repeatables` (a `RepeatablesPass`), `repeatablesDir`.
- `StatusReport` — `status` (`up_to_date` | `pending` | `drift`), `exitCode`, `historyPresent`, `historyVersion`, `fingerprint`, `fingerprintSource` (`history` | `catalog` | null), `fingerprintDrift`, `drift` (`DriftReport`), `recordedFingerprint`, `migrations`, `pending`, `partial`, `missingFiles`, `checksumDrift`, `lock`, `repeatables` (`drift`, `tracked`, `passImplemented`), `data`, `diagnostics`, `durationMs`.
- `StatusEntry` — one migration: `id`, `state`, `txmode`, statement counters, `appliedAt`, `appliedBy`, `checksumOk` (null when unrecorded).
- `EntryState` — `applied`, `baselined`, `superseded`, `running`, `failed`, `pending`, `orphaned`.
- `DataProgressEntry` — a `DataProgress` row plus `migrationState` (`orphaned` when no migration matches).

## Flow
1. Read the directory and collect file diagnostics (`packages/pg-prime-kit/src/runner/status.ts:120-121`).
2. If `pgprime.migrations` exists, read rows and `history_version` (`:123-125`).
3. Rows without a file become `orphaned` entries and `missingFiles` (`:133-148`).
4. Each file becomes an entry with its row's state or `pending`; a settled row with a different checksum goes to `checksumDrift` (`:150-166`). Entries sort by id (`:167`).
5. `pending` = `pending`, `running` or `failed`; `partial` = `running`, or `failed` with statements applied (`:169-172`).
6. Fingerprint: `fingerprint_to` of the last applied row; under `verifyFingerprint`, re-extract the catalog, set `fingerprintDrift`, and on drift call `describeDrift` and add a `fingerprint_drift` error diagnostic (`:174-204`).
7. `inspectLease` for the lock (`:206`); repeatable drift is the pass's `toApply` paths (`:208-215`); data progress rows are tagged with their migration state (`:217-221`).
8. Status: drift if missing files, checksum drift or fingerprint drift; else pending; else up to date. Exit codes `EXIT.drift` (4), `EXIT.pending` (5), `EXIT.ok` (`:223-232`).

## Gotchas
- Without `verifyFingerprint`, catalog drift is invisible: the fingerprint is read from history only (`packages/pg-prime-kit/src/runner/status.ts:177-180`).
- Repeatable drift needs both `repeatablesDir` and a real pass; with the default `NO_REPEATABLES` it is always empty and `passImplemented` is false (`:208`, `:246`).
- `superseded` and `baselined` count as settled; `running` and `failed` count as pending (`:170`).
- An orphaned row does not make `checksumDrift` but does make the status `drift` through `missingFiles`.
- `describeDrift` errors are swallowed and leave `drift: null` (`:198`).
- The repeatables pass still reads the `sql/` directory even when history is absent.

## Tests
- `packages/pg-prime-kit/test/runner/fingerprint.test.ts` — fast path vs `verifyFingerprint`, missing file → `missingFiles`.
- `packages/pg-prime-kit/test/runner/apply.test.ts:139`, `test/runner/baseline.test.ts` — status after apply and baseline.
- `packages/pg-prime-kit/test/cli/repeatables.test.ts` — repeatable drift through the CLI; `test/data/batch.test.ts` — `data` entries through the CLI envelope; `test/checkpoint/checkpoint.test.ts` — drift naming; `test/cli/golden/status.*.json` — envelope shape.
- All need a server (`PG_PRIME_TEST_URL` or localhost port 54329 (`packages/pg-prime-kit/test/support/db.ts:42`)). Run: `pnpm --filter @pg-prime/kit exec vitest run test/runner/fingerprint.test.ts`.
- Uncovered: `partial` entries for `failed` rows, `orphaned` data-progress rows.

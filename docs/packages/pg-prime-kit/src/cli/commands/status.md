# packages/pg-prime-kit/src/cli/commands/status.ts

## Purpose
`pg-prime migrate status`: a read-only report of applied vs pending migrations, the current fingerprint, lock state, partially applied rows, checksum drift, repeatable drift and data-migration progress. Pure rendering over `migrationStatus` (`packages/pg-prime-kit/src/runner/status.ts:105`), which computes the report and exit code. Registered at `packages/pg-prime-kit/src/cli/main.ts:121`; also calls `createRepeatablesPass`.

## Public API
- `STATUS_OPTIONS: readonly OptionSpec[]` — `--verify-fingerprint`, `--stale-lock-after <duration>`.
- `runStatus(config: ResolvedConfig, argv: ParseResult): Promise<CommandOutput>` — status `up_to_date` (exit 0), `pending` (exit 5) or `drift` (exit 4), taken from the report.

## Flow
1. Call `migrationStatus` with schemas, a repeatables pass and `config.repeatablesDir` (`packages/pg-prime-kit/src/cli/commands/status.ts:25`).
2. Pass `verifyFingerprint` when the flag is set; `staleLockAfterMs` is the flag, else `config.config.staleLockAfterMs`, else omitted (`packages/pg-prime-kit/src/cli/commands/status.ts:31`).
3. `envelope` maps the report: history presence/version, fingerprint and its source, drift flags, per-migration rows, pending, partial rows, missing files, checksum drift, lock, repeatables, data-migration progress, diagnostics (`packages/pg-prime-kit/src/cli/commands/status.ts:43`).
4. `text` prints a header with host and port, a summary block, one line per migration (with `applied/total` and any uncertain statement for `running`/`failed`), then data migrations, missing files, checksum drift and repeatable drift (`packages/pg-prime-kit/src/cli/commands/status.ts:110`).

## Gotchas
- Exit code and status come from `migrationStatus`: drift (missing files, checksum drift or fingerprint drift) beats pending (`packages/pg-prime-kit/src/runner/status.ts:223`). Repeatable drift is reported but does not change the exit code.
- Read-only in the strong sense: `migrationStatus` never calls `ensureHistory`, so an untouched database reports history `absent` (`packages/pg-prime-kit/src/runner/status.ts:3`).
- Without `createRepeatablesPass` the runner's stub would report empty repeatable drift; `repeatables.passImplemented` says which one ran (`packages/pg-prime-kit/src/cli/commands/status.ts:27`).
- The data-migration `watermark` in the envelope is the whole `values` map; the text shows only the in-flight statement's entry (`packages/pg-prime-kit/src/cli/commands/status.ts:154`).
- A `--stale-lock-after` of `0` is treated as absent (truthiness check) (`packages/pg-prime-kit/src/cli/commands/status.ts:32`).
- "N pending" is never pluralized; `plural` is used only for the file count (`packages/pg-prime-kit/src/cli/commands/status.ts:128`).

## Tests
- `packages/pg-prime-kit/test/cli/envelope.test.ts` — empty database with no migrations (exit 0), two pending (exit 5), apply then status; goldens `test/cli/golden/status.{empty,pending,applied}.json`.
- `packages/pg-prime-kit/test/cli/repeatables.test.ts` — repeatable drift before apply.
- `packages/pg-prime-kit/test/data/batch.test.ts` — data-migration progress after a killed backfill.
- `packages/pg-prime-kit/test/e2e/loop.test.ts` — `--verify-fingerprint` catches a tampered database.
- Run: `pnpm --filter @pg-prime/kit exec vitest run test/cli/envelope.test.ts`. Needs a real server (`PG_PRIME_TEST_URL`).
- Uncovered: the stale-lease and partially applied text lines.

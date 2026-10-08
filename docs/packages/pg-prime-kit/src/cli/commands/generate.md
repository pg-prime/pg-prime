# packages/pg-prime-kit/src/cli/commands/generate.ts

## Purpose
`pg-prime migrate generate`: parses flags, loads the TypeScript schema, calls the engine's `generate` (diff, order, lock-safe rewrite, hazards, prove, write), and maps its status onto exit codes and a JSON envelope. Also writes the file-only `--empty`/`--data` skeletons and owns the `--shadow` flag parser that `check.ts` and `push.ts` import. Registered at `packages/pg-prime-kit/src/cli/main.ts:104`; callees are `generate`, `readHintsFile`, `emptyMigrationSql`, `dataMigrationSql` (`src/generate.ts`), `loadSchema`, `parseShadowStrategy` and `renameDiff` (`packages/pg-prime-kit/src/cli/interactive.ts:69`).

## Public API
- `GENERATE_OPTIONS: readonly OptionSpec[]` — `--name`, `--seq`, `--interactive`, `--hints-file`, `--allow-data-loss`, `--reason`, `--by`, `--shadow`, `--offline`, `--no-safe-rewrite`, `--no-prove`, `--strict-unmodeled`, `--dump-oracle`, `--dry-run`, `--empty`, `--data`.
- `shadowStrategy(raw: string | undefined, offline: boolean): ShadowStrategy | undefined` — `"offline"` when `offline`, `undefined` when no flag, else `parseShadowStrategy(raw)`; parse errors rethrown as `GenerateRefusedError`.
- `runGenerate(config: ResolvedConfig, argv: ParseResult): Promise<CommandOutput>` — exit 0 `generated`/`up_to_date`/`dry_run`, 1 `refused`, 2 `missing_hints`/`lane_refused`, 3 `hazards`, 7 `proof_failed`.

## Flow
1. `--name` (default `auto`) must match `/^[a-z0-9_]+$/`; `--seq` defaults to one past the highest `NNNN` on disk and must be a non-negative integer (`packages/pg-prime-kit/src/cli/commands/generate.ts:143`).
2. `--empty`/`--data`: render the skeleton, print it on `--dry-run`, else write `NNNN_name.sql` with flag `wx` and refuse on `EEXIST` (`packages/pg-prime-kit/src/cli/commands/generate.ts:154`).
3. Refuse when there is no connection or the config names no `schema` (`packages/pg-prime-kit/src/cli/commands/generate.ts:186`).
4. Load the schema, read `--hints-file`, and call `generate`; `outDir` is omitted on `--dry-run` so nothing is written (`packages/pg-prime-kit/src/cli/commands/generate.ts:206`).
5. `--shadow`/`--offline` win over `config.config.shadow`; `--dump-oracle` must be `off|warn|strict` (`packages/pg-prime-kit/src/cli/commands/generate.ts:223`).
6. `--allow-data-loss` builds `acknowledge` with `by` and `reason` (`packages/pg-prime-kit/src/cli/commands/generate.ts:235`).
7. Errors: `LaneRefusedError` → `lane_refused`, exit 2, with the lane's hazards and diagnostics (`packages/pg-prime-kit/src/cli/commands/generate.ts:247`); `OfflineShadowError`/`GenerateRefusedError`/`ConfigError` → `refused`; `DesiredLoadError` → `desired_load`; `RepeatableApplyError` → `repeatable_failed`; others rethrow (`packages/pg-prime-kit/src/cli/commands/generate.ts:245`).
8. `missing_hints`, or `--interactive` with unresolved items: on a TTY prompt per rename and return a unified diff as `patch`; always exit 2 (`packages/pg-prime-kit/src/cli/commands/generate.ts:288`).
9. Otherwise map status to an exit code and emit files, shadow, proof, renames, candidates, hazards (plan hazards plus acknowledged `laneHazards`), diagnostics and `writeRefusal`; `--dry-run` + `generated` reports `dry_run` and includes each file's SQL (`packages/pg-prime-kit/src/cli/commands/generate.ts:309`).

## Gotchas
- Nothing is written on a non-zero exit; that is enforced by `writePlan`, not here (`packages/pg-prime-kit/src/cli/commands/generate.ts:11`).
- `--interactive` never edits source files: confirmed renames produce a diff on stdout for `patch -p0`, and the exit is still 2 (`packages/pg-prime-kit/src/cli/commands/generate.ts:442`). Without a TTY on both stdin and stdout it falls back to the text report.
- `--empty`/`--data` open no database, but `main` still resolves a connection for every command except `lint`, so a URL must be configured (`packages/pg-prime-kit/src/cli/main.ts:417`).
- The non-refused envelope always has `error: null`, even for `hazards`/`proof_failed`/`refused` statuses from the engine; the reason is in `writeRefusal`, `proof` or `hazards` (`packages/pg-prime-kit/src/cli/commands/generate.ts:372`).
- The `up_to_date` text still lists warning diagnostics, so `--dry-run` reports a stale declared lane there (`packages/pg-prime-kit/src/cli/commands/generate.ts:401`).
- `refusal` error codes are `usage`, `exists`, `config`, `refused`, `desired_load`, `repeatable_failed`.
- `--by` is passed both as the plan author and inside the data-loss acknowledgement (`packages/pg-prime-kit/src/cli/commands/generate.ts:234`).
- `nextSeq` treats a missing migrations dir as empty (seq 0); duplicate numbers are legal.

## Tests
- `packages/pg-prime-kit/test/cli/authoring.test.ts` — write then `up_to_date`, `--dry-run`, `--empty`/`--data`, refused drop (exit 2), rename proposal vs annotation, `--offline` refusal; goldens `test/cli/golden/generate.*.json`.
- `packages/pg-prime-kit/test/cli/interactive.test.ts` — `renameDiff` patch locating declarations (not the TTY prompt).
- `packages/pg-prime-kit/test/cli/repeatables.test.ts` — a repeatable referencing a dropped column fails at generate time.
- Also via the binary: `test/e2e/loop.test.ts`, `test/pull/*.test.ts`.
- Run: `pnpm --filter @pg-prime/kit exec vitest run test/cli/authoring.test.ts`. Needs a real server (`PG_PRIME_TEST_URL`).
- Uncovered: the TTY prompt path, `--hints-file`, invalid `--dump-oracle`/`--name`/`--seq`, exit 7.

# packages/pg-prime-kit/src/cli/exit.ts

## Purpose
The single table of process exit codes shared by every CLI command, plus the mapping from the runner's terminal states to those codes.
Imported by `packages/pg-prime-kit/src/cli/main.ts`, most `cli/commands/*.ts`, `packages/pg-prime-kit/src/runner/run.ts` and `packages/pg-prime-kit/src/runner/status.ts`; re-exported publicly from `packages/pg-prime-kit/src/index.ts:208`.

## Public API
- `EXIT` — const object: `ok` 0, `error` 1, `missingHints` 2, `lint` 3, `drift` 4, `pending` 5, `locked` 6, `proof` 7.
- `ExitCode` — the union of `EXIT`'s values (`0 | 1 | ... | 7`).
- `RunnerStatus` — `"applied" | "up_to_date" | "dry_run" | "drift" | "locked" | "failed" | "refused"`, the terminal states of `applyPending`.
- `RUNNER_EXIT` — `Record<RunnerStatus, ExitCode>` mapping each runner status to its exit code.

## Flow
1. Commands and the runner name codes through `EXIT` rather than numeric literals.
2. `applyPending` builds its result with `exitCode: RUNNER_EXIT[status]` (`packages/pg-prime-kit/src/runner/run.ts:454`).
3. `main` returns the command's `exitCode`, which `packages/pg-prime-kit/src/cli.ts:13` assigns to `process.exitCode`.

## Gotchas
- `applied`, `up_to_date` and `dry_run` all map to 0; `failed` and `refused` both map to 1 (`packages/pg-prime-kit/src/cli/exit.ts:34`).
- `refused` (e.g. a transaction-mode pooler that cannot hold a session lock) is exit 1, not 6: no lock is held, the connection is unusable (`packages/pg-prime-kit/src/cli/exit.ts:45`).
- The root `--help` exit-code table in `packages/pg-prime-kit/src/cli/main.ts:246` is a hand-written string, not generated from `EXIT`.
- `packages/pg-prime-kit/src/unsupported-typescript.d.ts` declares `RUNNER_EXIT` and `RunnerStatus` as `Unsupported` for TypeScript below 5.9.

## Tests
- No unit test of the table itself; the codes are asserted end to end via `EXIT` in `packages/pg-prime-kit/test/cli/usage.test.ts`, `envelope.test.ts`, `authoring.test.ts` and `repeatables.test.ts`.
- `RUNNER_EXIT` is covered through `applyPending` results in `packages/pg-prime-kit/test/runner/` and the `apply` goldens.
- Run: `pnpm --filter @pg-prime/kit exec vitest run test/cli` (envelope/authoring/repeatables need a server).

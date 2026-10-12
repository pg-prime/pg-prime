# packages/pg-prime-create/src/main.ts

## Purpose
The command body of `create-pg-prime`: parse argv, handle `--help`/`--version`, resolve the plan (prompting if allowed), write the project, then optionally `git init` and install, and print next steps. Called by `packages/pg-prime-create/src/cli.ts:22`; calls `parseArgs`/`HELP`/`VERSION` (`args.ts`), `resolveOptions` (`prompts.ts`), `scaffold` (`scaffold.ts`) and `spawnSync`. Not re-exported from `index.ts`.

## Public API
- `MainIo` — `PromptIo` (`ask`, `cwd`, `env`) plus `out(text)` and `err(text)` writers.
- `main(argv, io): Promise<number>` — runs the command and resolves to an exit code (0 or 1); never calls `process.exit`.

## Flow
1. `parseArgs(argv)`; if `help`, print `HELP` first (`packages/pg-prime-create/src/main.ts:50-52`).
2. Any parse error prints `create-pg-prime: <error>` lines (plus a `--help` hint unless help was printed) and returns 1 (`:53-57`).
3. `--help` returns 0; `--version` prints `VERSION` and returns 0 (`:58-62`).
4. `resolveOptions(options, io)` yields the `ProjectPlan` (`:64`).
5. `scaffold(plan)`; a thrown error prints `create-pg-prime: <message>` and returns 1 (`:66-72`).
6. Prints `wrote <n> files to <relative dir>` (`:74-77`).
7. If `plan.git`, runs `git init --quiet` in the target; failure only prints a warning (`:79-82`).
8. If `plan.install`, runs `<pm> install`; failure prints an error and returns 1 (`:83-89`).
9. Prints `Next:` with `cd`, an install line if not installed, `export DATABASE_URL=…localhost:5432/app`, `migrate generate --name init`, `migrate apply`, `build && start` (`nextSteps`, `:35-47`, `:91`).

## Gotchas
- `--help` wins over `--version` and is printed even when there are parse errors, but the exit code is then 1.
- `runCommand` uses `spawnSync` with stdin ignored and stdout/stderr inherited from the real process, not routed through `io.out`/`io.err` (`:25-33`); on Windows it uses `shell: true` so `.cmd` package managers run.
- A failed `git init` is non-fatal; a failed install is fatal, but the files stay written.
- `nextSteps` has its own `exec`/`run` command tables (`:37-38`) duplicating `PM_COMMANDS` in `packages/pg-prime-create/src/scaffold.ts:61-68`; change both together.
- The `DATABASE_URL` in the next steps is a fixed string (`:23`).
- An exception from `resolveOptions` (e.g. a rejected `ask`) is not caught here.

## Tests
- No unit spec calls `main` directly. Covered end to end by `packages/pg-prime-create/test/pg/scaffold.e2e.test.ts` (runs `dist/cli.js … --yes --no-install --no-git`, needs `PG_PRIME_TEST_URL`) and by `tools/create-smoke.mjs`.
- Run: `PG_PRIME_TEST_URL=postgres://… pnpm --filter @pg-prime/create exec vitest run --project pg`.
- Uncovered: the git/install branches, error exit codes and `nextSteps` output have no assertions.

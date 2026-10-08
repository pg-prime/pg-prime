# packages/pg-prime-create/src/cli.ts

## Purpose
The `create-pg-prime` executable (`bin` → `dist/cli.js`), what `npm create @pg-prime` runs. It is the only file that touches real streams or a terminal: it builds the IO object, calls `main` (`packages/pg-prime-create/src/main.ts:49`) and sets the exit code. Exports nothing; not imported by any module.

## Public API
- none (side-effecting script; no exports).

## Flow
1. Opens a `node:readline/promises` interface on stdin/stdout only when `process.stdin.isTTY === true` (`packages/pg-prime-create/src/cli.ts:18-19`).
2. Awaits `main(process.argv.slice(2), io)` at top level, where `io.out`/`io.err` write to stdout/stderr, `ask` is `rl.question` or `undefined`, `cwd` is `process.cwd()` and `env` is `process.env` (`:22-28`).
3. Assigns the returned number to `process.exitCode` (`:22`).
4. Closes the readline interface in `finally` so stdin is released and the process can exit (`:29-32`).

## Gotchas
- Non-TTY stdin passes `ask: undefined`, which `resolveOptions` treats like `--yes`: CI, pipes and task runners never block on a prompt.
- `process.exitCode`, not `process.exit()`, so piped output is not truncated (`:11`).
- An exception thrown by `main` (other than a scaffold error, which `main` catches) propagates out of top-level `await` and crashes with a stack trace; only `finally` runs.
- The shebang must survive the build: `tsc` keeps it and `tools/build-package.mjs` sets the executable bit (`:5`); `tools/create-smoke.mjs` checks both from an installed tarball.
- Keeping all `node:readline`/stream use here keeps the published `.d.ts` free of external module names (see `PromptIo`, `packages/pg-prime-create/src/prompts.ts:27`).

## Tests
- No unit spec (it has top-level side effects). `packages/pg-prime-create/test/pg/scaffold.e2e.test.ts` runs the built `dist/cli.js app --yes --no-install --no-git [--no-testing]` with piped stdio (needs `PG_PRIME_TEST_URL`; `globalSetup` builds the packages). `tools/create-smoke.mjs` runs the bin from an installed tarball.
- Run: `PG_PRIME_TEST_URL=postgres://… pnpm --filter @pg-prime/create exec vitest run --project pg`.
- Uncovered: the TTY branch (interactive prompting through readline).

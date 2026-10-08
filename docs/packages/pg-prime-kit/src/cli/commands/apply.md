# packages/pg-prime-kit/src/cli/commands/apply.ts

## Purpose
CLI wrapper for `pg-prime migrate apply` (alias `deploy`): maps flags and config onto `ApplyPendingOptions`, calls the runner's `applyPending`, and renders the result as a JSON envelope plus text. Registered in the `COMMANDS` table of `packages/pg-prime-kit/src/cli/main.ts:113` and dispatched from `packages/pg-prime-kit/src/cli/main.ts:424`; callees are `applyPending` (`packages/pg-prime-kit/src/runner/run.ts:370`) and `createRepeatablesPass` from `src/repeatables/index.ts`.

## Public API
- `APPLY_OPTIONS: readonly OptionSpec[]` — command flags: `--to`, `--dry-run`, `--lock-timeout`, `--statement-timeout`, `--lock-wait`, `--stale-lock-after`, `--heartbeat`, `--verify-fingerprint`, `--dev`, `--yes`, `--applied-from`.
- `runApply(config: ResolvedConfig, argv: ParseResult): Promise<CommandOutput>` — applies pending migrations; exit code is the runner's `r.exitCode` (0 applied/up to date, 1 error/refused, 4 drift, 6 locked).

## Flow
1. Build `ApplyPendingOptions` from `config.schemas`, a fresh `createRepeatablesPass()` and `config.repeatablesDir` (`packages/pg-prime-kit/src/cli/commands/apply.ts:75`).
2. Add `replicas` only when the config names standbys (`packages/pg-prime-kit/src/cli/commands/apply.ts:84`).
3. Copy `--to`, `--applied-from`, `--dry-run`, `--dev`, `--verify-fingerprint` when given (`packages/pg-prime-kit/src/cli/commands/apply.ts:85`).
4. Resolve `lockTimeout`, `statementTimeout`, `lockWaitMs`, `staleLockAfterMs`: flag first, then `config.config.*`, omitted when both are absent (`packages/pg-prime-kit/src/cli/commands/apply.ts:90`).
5. `heartbeatMs` comes from the flag only (`packages/pg-prime-kit/src/cli/commands/apply.ts:102`).
6. Call `applyPending(config.connection, config.migrationsDir, options)` (`packages/pg-prime-kit/src/cli/commands/apply.ts:105`).
7. `envelope` copies lock, applied rows, pending, fingerprint, pre-flight findings, repeatables, warnings and diagnostics into the `migrate apply` envelope; `stream` is the dry-run query list or `null` (`packages/pg-prime-kit/src/cli/commands/apply.ts:109`).
8. `text` prints the dry-run statement stream verbatim and returns early, otherwise a per-status summary (`packages/pg-prime-kit/src/cli/commands/apply.ts:164`).

## Gotchas
- Does not import `generate`, the shadow ladder or any schema loader: apply needs only `migrations/` and a connection (`packages/pg-prime-kit/src/cli/commands/apply.ts:4`).
- `--yes` is declared but never read by `runApply` (`packages/pg-prime-kit/src/cli/commands/apply.ts:64`).
- `--heartbeat` has no config fallback, unlike the other timing flags (`packages/pg-prime-kit/src/cli/commands/apply.ts:102`).
- The option `defaultText` values (`3s`, `30s`, `60s`, `5s`) are help text only; when the flag and config are both absent the key is omitted and the runner picks the default.
- Uses `?:` truthiness, so a config value of `0` for `lockWaitMs`/`staleLockAfterMs` counts as absent (`packages/pg-prime-kit/src/cli/commands/apply.ts:96`).
- A missing `sql/` repeatables directory is an empty pass, not a failure (`packages/pg-prime-kit/src/cli/commands/apply.ts:79`).
- `up_to_date` text distinguishes "another deploy already applied everything" when the lock was not acquired (`packages/pg-prime-kit/src/cli/commands/apply.ts:194`).
- `locked`/`drift`/`failed`/`refused` text upper-cases the status and prints `r.error?.message` (`packages/pg-prime-kit/src/cli/commands/apply.ts:203`).

## Tests
- `packages/pg-prime-kit/test/cli/envelope.test.ts` — spawns `dist/cli.js`: `apply --dry-run` stream, apply/status/apply-again; goldens `test/cli/golden/apply.{applied,dry-run,up-to-date}.json`.
- `packages/pg-prime-kit/test/cli/usage.test.ts` — `deploy` alias, help page.
- Through the binary also: `test/runner/lock.test.ts` (exit 6), `test/runner/resume.test.ts`, `test/data/batch.test.ts`, `test/runner/pooler.test.ts`, `test/cli/repeatables.test.ts`, `test/e2e/loop.test.ts`.
- Run: `pnpm --filter @pg-prime/kit exec vitest run test/cli/envelope.test.ts`. Needs a real server (`PG_PRIME_TEST_URL`, else `127.0.0.1:54329`); `globalSetup` builds `dist/` first.
- Uncovered: `--yes`, config fallbacks for timing flags, `replicas` passthrough at this layer.

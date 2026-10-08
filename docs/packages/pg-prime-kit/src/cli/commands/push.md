# packages/pg-prime-kit/src/cli/commands/push.ts

## Purpose
`pg-prime migrate push --dev`: a dev-loop command that computes the diff from the TypeScript schema and applies it directly, writing no migration file and no history row. Fenced by refusals that all run before any statement is issued. Registered at `packages/pg-prime-kit/src/cli/main.ts:164`; callees are `loadSchema`, `generate`, `shadowStrategy` (from `./generate.ts`), `historyPresent`, `readMigrationRows` and `applySegments` (`src/runner/apply.ts`).

## Public API
- `PUSH_OPTIONS: readonly OptionSpec[]` — `--dev` (required), `--allow-data-loss`, `--prod-pattern <regex>`, `--dry-run`, `--shadow <url|temp-schema|createdb>`.
- `runPush(config: ResolvedConfig, argv: ParseResult): Promise<CommandOutput>` — status `pushed`/`up_to_date`/`dry_run` (exit 0), `refused` (exit 1, or 2 for a missing decision), `failed` (exit 1, error code `sql_error`).

## Flow
1. Refuse without the literal `--dev` (`packages/pg-prime-kit/src/cli/commands/push.ts:80`).
2. Refuse when `config.production` is set (`PG_PRIME_ENV=production` or `production: true`) (`packages/pg-prime-kit/src/cli/commands/push.ts:87`).
3. Compile `--prod-pattern` (default `prod|production|live`) case-insensitively and refuse when it matches `host:port/database` or is not a valid regex (`packages/pg-prime-kit/src/cli/commands/push.ts:93`).
4. Refuse when the config names no `schema` (`packages/pg-prime-kit/src/cli/commands/push.ts:107`).
5. Refuse when `pgprime.migrations` holds any row whose status is not `baselined` (`packages/pg-prime-kit/src/cli/commands/push.ts:111`).
6. Load the schema and call `generate` with `seq: 0`, `name: "push"`, `multiFile: false`, `prove: false`; `--allow-data-loss` adds an acknowledgement (`packages/pg-prime-kit/src/cli/commands/push.ts:128`).
7. `up_to_date` returns immediately; unresolved renames/data-loss decisions refuse with exit 2 (`packages/pg-prime-kit/src/cli/commands/push.ts:149`).
8. Unacknowledged error-severity hazards on the single plan refuse with exit 2 (`packages/pg-prime-kit/src/cli/commands/push.ts:176`).
9. `--dry-run` returns the statement SQL without applying (`packages/pg-prime-kit/src/cli/commands/push.ts:188`).
10. `applySegments` on a fresh client; a failure reports applied count and the failing statement index (`packages/pg-prime-kit/src/cli/commands/push.ts:207`).

## Gotchas
- `--dev` has no config key or default by design (`packages/pg-prime-kit/src/cli/commands/push.ts:7`).
- `--allow-data-loss` is never recorded, so it must be passed on every run (`packages/pg-prime-kit/src/cli/commands/push.ts:14`).
- A missing data-loss acknowledgement exits 2 (`EXIT.missingHints`), not 1, though the envelope status is still `refused` (`packages/pg-prime-kit/src/cli/commands/push.ts:185`).
- The prod pattern is tested against `host:port/database`, not the full URL (`packages/pg-prime-kit/src/cli/commands/push.ts:94`).
- No migration lock is taken and nothing is recorded; after a push the database is ahead of the repository.
- `generate` still provisions a shadow, even under `--dry-run`.
- The banner uses ANSI colour only when stdout is a TTY, else `!!! … !!!` (`packages/pg-prime-kit/src/cli/commands/push.ts:58`).
- `OfflineShadowError`, `GenerateRefusedError` and `ConfigError` become refusals; other throws propagate to `main` (`packages/pg-prime-kit/src/cli/commands/push.ts:261`).

## Tests
- `packages/pg-prime-kit/test/cli/authoring.test.ts` — refuses without `--dev`, under `PG_PRIME_ENV=production`, and on a `--prod-pattern` match; `push --dev` applies, is then `up_to_date`, and refuses once a non-baselined row exists (a `baselined` row alone is allowed); goldens `test/cli/golden/push.{pushed,refused}.json`.
- Run: `pnpm --filter @pg-prime/kit exec vitest run test/cli/authoring.test.ts`. Needs a real server (`PG_PRIME_TEST_URL`).
- Uncovered: `--dry-run`, the exit-2 refusals, the `failed` (`sql_error`) envelope, an invalid `--prod-pattern`.

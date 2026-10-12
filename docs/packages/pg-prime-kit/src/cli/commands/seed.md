# packages/pg-prime-kit/src/cli/commands/seed.ts

## Purpose
`pg-prime db seed`: runs `seeds/*.sql` and `seeds/*.ts` (plus named sets) against the database and reports them. Seeds are not migration history, so nothing here touches `pgprime`. Registered under the `db` noun at `packages/pg-prime-kit/src/cli/main.ts:197`; callees are `runSeeds`, `seedSets`, `scanSeeds` and `DEFAULT_PROD_PATTERN` from `packages/pg-prime-kit/src/seed/run.ts:217`.

## Public API
- `SEED_OPTIONS: readonly OptionSpec[]` — `--set <name>` (repeatable), `--force`, `--prod-pattern <regex>`, `--seeds <dir>`, `--list`.
- `runSeedCommand(config: ResolvedConfig, argv: ParseResult): Promise<CommandOutput>` — status `seeded`/`nothing_to_do`/`listed` (exit 0) or `refused`/`failed` (exit 1).

## Flow
1. `seedsDir` is `--seeds`, else `config.seedsDir` (`packages/pg-prime-kit/src/cli/commands/seed.ts:43`).
2. Refuse with error code `config` when there is no connection (`packages/pg-prime-kit/src/cli/commands/seed.ts:65`).
3. `--list`: `seedSets` for the sets on disk and `scanSeeds(seedsDir, sets)` for the files that would run; nothing is executed (`packages/pg-prime-kit/src/cli/commands/seed.ts:74`).
4. Otherwise `runSeeds` with the sets, `--force`, `config.production`, the prod pattern (default `prod|production|live`) and `config.schemaPaths` (`packages/pg-prime-kit/src/cli/commands/seed.ts:104`).
5. A `ConfigError` becomes a `refused` envelope; other throws propagate (`packages/pg-prime-kit/src/cli/commands/seed.ts:114`).
6. Exit 0 for `seeded`/`nothing_to_do`, else 1; the envelope status is `result.status` and `error` is the runner's (`packages/pg-prime-kit/src/cli/commands/seed.ts:130`).
7. Text lists each applied seed with kind, statement count and duration (`packages/pg-prime-kit/src/cli/commands/seed.ts:150`).

## Gotchas
- Never calls `ensureHistory` or takes the advisory lock: a seeded database that was never migrated must not gain a `pgprime` schema, or `migrate baseline` would refuse it (`packages/pg-prime-kit/src/cli/commands/seed.ts:5`).
- Production and `--prod-pattern` refusals are decided inside `runSeeds`, not here; `--force` overrides both.
- `--list` still requires a connection, because the connection check runs first (`packages/pg-prime-kit/src/cli/commands/seed.ts:65`).
- `scanSeeds` is loaded with a dynamic `import()` inside the `--list` branch (`packages/pg-prime-kit/src/cli/commands/seed.ts:76`).
- Through `main`, `seed` under the `migrate` noun is an unknown command; it is `db seed` only.

## Tests
- `packages/pg-prime-kit/test/seed/seed.test.ts` — `--list`; base set in filename order with a `.ts` seed; re-runnable and records nothing; `--set` and unknown sets; production refusal and `--force`; `--prod-pattern` match; failing seed stops the run; empty dir is `nothing_to_do`; `.ts` config and seed with `.js` specifiers; goldens `test/cli/golden/seed.{seeded,refused}.json`.
- `packages/pg-prime-kit/test/cli/usage.test.ts` — `db seed` help; `migrate seed` rejected.
- Run: `pnpm --filter @pg-prime/kit exec vitest run test/seed/seed.test.ts`. Needs a real server (`PG_PRIME_TEST_URL`).
- Uncovered: the `ConfigError` refusal branch.

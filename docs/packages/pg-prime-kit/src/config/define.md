# packages/pg-prime-kit/src/config/define.ts

## Purpose
Declares the shape of `pg-prime.config.ts` (`PgPrimeConfig`) and the typed identity helper `defineConfig` that a user's config file default-exports. The type lives in `@pg-prime/kit`, not in `pg-prime`, because it describes the kit's inputs. It is re-exported through `packages/pg-prime-kit/src/config/index.ts` and the package entry `packages/pg-prime-kit/src/index.ts:209`; `packages/pg-prime-kit/src/config/load.ts` validates and resolves it, and the CLI commands under `packages/pg-prime-kit/src/cli/commands/` read its fields. It imports only types (`ConnInfo` from `db/pg.ts`, `ShadowStrategy` from `shadow/ladder.ts`).

## Public API
- `PgPrimeConfig` — every key optional and `readonly`: `url`, `connection` (`ConnInfo`), `migrations`, `repeatables`, `schemas`, `shadow` (`ShadowStrategy`), `schema` (`string | readonly string[]`), `replicas`, `seeds`, `lockTimeout`, `statementTimeout`, `lockWaitMs`, `staleLockAfterMs`, `production`.
- `defineConfig(config: PgPrimeConfig): PgPrimeConfig` — returns its argument unchanged; exists for editor completion and compile-time key checking. Never throws.

## Flow
1. The user writes `export default defineConfig({ … })` in `pg-prime.config.ts` (or `.mts`/`.js`/`.mjs`).
2. `defineConfig` returns the same object reference (`packages/pg-prime-kit/src/config/define.ts:63`).
3. `loadConfig` imports the file, checks the default export is an object and type-checks known keys (`packages/pg-prime-kit/src/config/load.ts:157`, `:215`).
4. `resolveConfig` turns it into absolute paths, a `ConnInfo` and defaults (`packages/pg-prime-kit/src/config/load.ts:478`).
5. Commands read the remaining keys directly off `ResolvedConfig.config`, e.g. `lockTimeout`/`statementTimeout`/`lockWaitMs`/`staleLockAfterMs` in `packages/pg-prime-kit/src/cli/commands/apply.ts:90` and `shadow` in `packages/pg-prime-kit/src/cli/commands/generate.ts:226`.

## Gotchas
- Defaults are not encoded here; they are applied in `resolveConfig`: `migrations` → `migrations`, `repeatables` → `sql`, `seeds` → `seeds`, `schemas` → `["public"]` (`packages/pg-prime-kit/src/config/load.ts:513`–`:516`). Relative paths resolve against the config file's directory.
- Connection precedence is `--url` > `connection` > `url` > `PG_PRIME_DATABASE_URL` > `DATABASE_URL` (`packages/pg-prime-kit/src/config/load.ts:485`–`:488`); `connection` wins over `url` when both are set.
- `schemas` scopes the diff, the fingerprint and the advisory lock key; a runner given a different set computes a different fingerprint.
- `replicas` is the only place the kit connects to standbys; without it replica lag is read primary-side from `pg_stat_replication`.
- `production: true` forces the production tag regardless of `PG_PRIME_ENV` (`packages/pg-prime-kit/src/config/load.ts:519`).
- An unknown key is not a runtime error: `loadConfig` validates only known keys, so `defineConfig` is the only typo guard.
- The CLI spreads the timeout/lock keys with truthiness checks, so `lockWaitMs: 0`, `staleLockAfterMs: 0` or an empty `lockTimeout` are treated as unset (`packages/pg-prime-kit/src/cli/commands/apply.ts:96`).

## Tests
- `packages/pg-prime-kit/test/cli/config.test.ts` — "defineConfig is the identity" asserts the same reference is returned; the rest of the file covers loading and resolving the shape (see `load.md`).
- Run: `pnpm --filter @pg-prime/kit exec vitest run test/cli/config.test.ts`. The kit's vitest setup builds `dist/` once (`test/globalSetup.ts`) and expects a real PostgreSQL server (`PG_PRIME_TEST_URL`, see `packages/pg-prime-kit/test/support/db.ts`).
- Uncovered: no test asserts the truthiness-dropping of zero-valued timeout keys.

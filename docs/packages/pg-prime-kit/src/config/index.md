# packages/pg-prime-kit/src/config/index.ts

## Purpose
Barrel for the config subsystem: re-exports the public half of `packages/pg-prime-kit/src/config/define.ts` and `packages/pg-prime-kit/src/config/load.ts`. Its only importer is the package entry `packages/pg-prime-kit/src/index.ts:226`; CLI commands and the seed runner import `config/load.ts` and `config/ts-specifiers.ts` directly.

## Public API
- From `define.ts`: `defineConfig`, `PgPrimeConfig` (`packages/pg-prime-kit/src/config/index.ts:1`).
- From `load.ts`: `findConfigFile`, `loadConfig`, `loadSchema`, `parseDatabaseUrl`, `resolveConfig`, `ConfigError`, `CONFIG_FILENAMES`, `ENV_VAR`, `STRIP_TYPES_MARKER`, and types `LoadedConfig`, `LoadedSchema`, `ParsedUrl`, `ResolveInput`, `ResolvedConfig` (`packages/pg-prime-kit/src/config/index.ts:2`).

## Flow
1. Pure re-export; no runtime code of its own.

## Gotchas
- Not re-exported (internal to the kit): `tsSpecifierAdvice` from `load.ts` (used by `packages/pg-prime-kit/src/seed/run.ts:40` and `packages/pg-prime-kit/src/seed/db.ts:23`) and everything in `ts-specifiers.ts` (`enableTsSpecifiers`, `typeScriptSibling`, `typeScriptSiblingUrl`).
- Adding an export here changes the package's public surface; `tools/api-snapshot.mjs --check` and the `types@<5.9` stub `packages/pg-prime-kit/src/unsupported-typescript.d.ts` must be regenerated to match.

## Tests
- No dedicated spec; the re-exported symbols are tested in `packages/pg-prime-kit/test/cli/config.test.ts`, which imports from `src/config/load.ts` and `src/config/define.ts` directly rather than through this barrel.
- The public surface is checked by `pnpm api-snapshot:check` at the repo root (`tools/api-snapshot.mjs`).

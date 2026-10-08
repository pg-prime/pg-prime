# packages/pg-prime-kit/src/config/load.ts

## Purpose
Finds, imports and validates `pg-prime.config.*`, imports the user's TypeScript schema module(s) into one registry, parses `postgres://` URLs into `ConnInfo`, and resolves the config plus CLI flags and environment into a `ResolvedConfig`. Loading uses Node's own type stripping, with no loader dependency. Callers: `packages/pg-prime-kit/src/cli/main.ts:413` (`loadConfig` + `resolveConfig`), the `generate`/`check`/`push`/`verify` commands (`loadSchema`), the seed runner (`tsSpecifierAdvice`, `packages/pg-prime-kit/src/seed/run.ts:40`, `packages/pg-prime-kit/src/seed/db.ts:23`), and every command that takes a `ResolvedConfig`. Callees: `enableTsSpecifiers`/`typeScriptSiblingUrl` (`config/ts-specifiers.ts`) and `parseShadowStrategy` (`shadow/ladder.ts`).

## Public API
- `CONFIG_FILENAMES` — `pg-prime.config.ts`, `.mts`, `.js`, `.mjs`, searched in that order per directory.
- `ENV_VAR` — `"PG_PRIME_ENV"`, the production tag variable. `STRIP_TYPES_MARKER` — `"PG_PRIME_STRIP_TYPES_RETRY"`, set by the CLI before its one re-exec.
- `ConfigError` — `code = "PG_PRIME_CONFIG"`; `retryWithStripTypes` is true when a re-exec with `--experimental-strip-types` could fix it.
- `findConfigFile(from)` — first config file at or above `from`, or `null`.
- `loadConfig(path?, cwd?)` — `{ file, config }`; `{ file: null, config: {} }` when none is found. Throws `ConfigError` on a missing explicit path, a non-object default export, or a mistyped key.
- `tsSpecifierAdvice(file, err, hooksInstalled)` — turns a Node 22.12–22.14 `ERR_MODULE_NOT_FOUND` for a `.js` with a `.ts` sibling into a `ConfigError`, else `null`. Not in the package entry.
- `loadSchema(paths, base)` — imports schema module(s) and returns `LoadedSchema` (`tables` keyed `schema.name`, plus `enums`, `domains`, `sequences`, `extensions`, `schemas`, `views`, and `files`).
- `parseDatabaseUrl(url)` — `{ conn, warnings }`; throws `ConfigError` on a non-URL or non-postgres scheme.
- `resolveConfig(input: ResolveInput)` — `ResolvedConfig` with connection, absolute dirs, schemas, parsed replicas, env tag, production flag and warnings.
- Types: `LoadedConfig`, `LoadedSchema`, `ParsedUrl`, `ResolveInput` (config + `--url`/`--migrations`/`--schema`, `cwd`, `env`, `requireConnection?`), `ResolvedConfig`.

## Flow
1. `loadConfig` resolves an explicit `path` against `cwd`, or walks upward with `findConfigFile` (`packages/pg-prime-kit/src/config/load.ts:55`, `:158`).
2. It installs the `.js`→`.ts` resolve hook via `enableTsSpecifiers()` and `import()`s the file URL (`packages/pg-prime-kit/src/config/load.ts:165`).
3. On failure, `classifyUserImportFailure` maps the four type-stripping codes to `stripTypesAdvice`, else tries `tsSpecifierAdvice`, else rethrows the original (`packages/pg-prime-kit/src/config/load.ts:139`).
4. The default export must be a non-array object; `validate` type-checks string, number, array and boolean keys and `validateShadow` parses `shadow` (`packages/pg-prime-kit/src/config/load.ts:191`, `:215`).
5. The CLI calls `resolveConfig`: connection from `--url`, else `config.connection`, else `config.url`/`PG_PRIME_DATABASE_URL`/`DATABASE_URL` via `parseDatabaseUrl` (`packages/pg-prime-kit/src/config/load.ts:485`).
6. With no connection and `requireConnection === false`, a placeholder `ConnInfo` is used and `hasConnection` is false; otherwise it throws (`packages/pg-prime-kit/src/config/load.ts:492`).
7. Paths resolve against the config file's directory (or `cwd`); defaults `migrations`, `sql`, `seeds`, `["public"]` (`packages/pg-prime-kit/src/config/load.ts:501`, `:513`).
8. `production` is `config.production === true` or `PG_PRIME_ENV === "production"` (`packages/pg-prime-kit/src/config/load.ts:519`).
9. `loadSchema` imports each path (after `enableTsSpecifiers`), picks a registry (`default` with `tables`, else any export with `tables`), else scans all exports (`packages/pg-prime-kit/src/config/load.ts:336`).
10. Table-like values (`$.name`, `$.columns`, `$.extras`, no `$.view`) are keyed `schema.name` (`packages/pg-prime-kit/src/config/load.ts:297`, `:342`).
11. Standalone declarations (`kind` + `name`) are collected off the module's named exports into per-kind maps (`packages/pg-prime-kit/src/config/load.ts:350`).

## Gotchas
- Only `ERR_UNKNOWN_FILE_EXTENSION` sets `retryWithStripTypes`; the other three strip-types codes produce the same sentence without a re-exec (`packages/pg-prime-kit/src/config/load.ts:79`). The re-exec itself lives in `packages/pg-prime-kit/src/cli/main.ts:426`, guarded by `STRIP_TYPES_MARKER`.
- `tsSpecifierAdvice` fires only when the hook is not installed, the code is `ERR_MODULE_NOT_FOUND`, `err.url` is a string and `typeScriptSiblingUrl` finds a sibling; every other not-found error passes through untouched (`packages/pg-prime-kit/src/config/load.ts:109`).
- No cache-busting query on `import()`: a second `loadConfig` of the same file in one process returns the cached module.
- `validate` does not check `connection` or `schema`, and unknown keys are kept, not rejected (`packages/pg-prime-kit/src/config/load.ts:215`).
- `validateShadow` only parses `shadow`; the raw value is kept. So `shadow: "none"` passes (`parseShadowStrategy` maps it to `offline`, `packages/pg-prime-kit/src/shadow/ladder.ts:175`) but reaches `provisionShadow` as `"none"` where it is parsed as a tier-1 URL and throws `ShadowStrategyError` (`packages/pg-prime-kit/src/shadow/ladder.ts:285`).
- `--url` beats `config.connection`, but `config.connection` beats `config.url` (`packages/pg-prime-kit/src/config/load.ts:486`).
- `parseDatabaseUrl` drops all query parameters (e.g. `sslmode`) and reports them in `warnings`; user defaults to `PGUSER` then `postgres`, database to the user, host to `127.0.0.1`, port to 5432; IPv6 brackets are stripped (`packages/pg-prime-kit/src/config/load.ts:409`–`:427`).
- `replicas` URLs are parsed with `parseDatabaseUrl` and their warnings are discarded (`packages/pg-prime-kit/src/config/load.ts:517`).
- A registry's `tables` is preferred over the module's other exports for tables, but declarations always come off the module, never the registry; `default` is skipped for declarations (`packages/pg-prime-kit/src/config/load.ts:351`).
- A view is excluded from tables by `$.view`; without that check it would be emitted as a `CREATE TABLE` (`packages/pg-prime-kit/src/config/load.ts:303`).
- Duplicates across exports or files collapse by `schema.name` (by bare name for `pgSchema`), last one wins (`packages/pg-prime-kit/src/config/load.ts:357`).
- A module throws `ConfigError` only if it has neither tables nor declarations (`packages/pg-prime-kit/src/config/load.ts:363`).

## Tests
- `packages/pg-prime-kit/test/cli/config.test.ts` — `loadConfig` (`.ts` and `.mjs`, upward search, no file, missing explicit path, bad default export, mistyped keys, both `shadow` spellings and keywords, invalid `shadow`), `parseDatabaseUrl` (decoding, default port, IPv6, dropped params, bad scheme), `resolveConfig` (URL precedence, paths relative to config file, `PG_PRIME_ENV`, no-connection message), `tsSpecifierAdvice` (message shape and pass-through cases), and the binary loading `.mjs`/`.ts` configs plus the strip-types sentence with and without `STRIP_TYPES_MARKER`.
- `loadSchema` is exercised only through the binary in `packages/pg-prime-kit/test/cli/authoring.test.ts` (a `db/schema.ts` written by `test/cli/_project.ts`).
- Run: `pnpm --filter @pg-prime/kit exec vitest run test/cli/config.test.ts`. The kit suite builds `dist/` once in `test/globalSetup.ts` and expects a real server (`PG_PRIME_TEST_URL`).
- Uncovered: `loadSchema`'s three registry shapes, declaration discovery, duplicate collapsing and the "exports no tables" error have no direct test; `requireConnection: false` and `replicas` parsing are not asserted in `config.test.ts`.

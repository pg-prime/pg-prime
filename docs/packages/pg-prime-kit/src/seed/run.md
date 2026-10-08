# packages/pg-prime-kit/src/seed/run.ts

## Purpose
`pg-prime db seed`: runs `seeds/*.sql` and `seeds/*.ts` (the base set) plus any `--set <name>` subdirectories, one transaction per file, never recording anything in the history schema, and refusing production-looking targets unless forced.
Callers: `src/cli/commands/seed.ts` (`runSeeds`, `seedSets`, `scanSeeds`, `DEFAULT_PROD_PATTERN`). Not re-exported from `src/index.ts`.
Callees: `seed/db.ts` (`openSeedDb`), `db/pg.ts` (`withClient`), `sql/statements.ts` (`splitStatements`), `config/ts-specifiers.ts` (`enableTsSpecifiers`), `config/load.ts` (`tsSpecifierAdvice`).

## Public API
- `runSeeds(options)` → `SeedResult` — refusal checks, scan, then each file in order. Returns `refused`, `nothing_to_do`, `failed` or `seeded`; throws only when `openSeedDb` fails.
- `SeedOptions` — `seedsDir`, `connection`, `sets?`, `force?`, `production?`, `prodPattern?`, `schemaPaths?`, `onEvent?` (`start`/`done` per file).
- `SeedResult` — `status`, `applied`, `skipped` (paths after a failure), `sets`, `seedsDir` (resolved), `error` (`{ code, message, file? }`), `durationMs`.
- `SeedStatus` — `"seeded" | "nothing_to_do" | "refused" | "failed"`.
- `SeedFile` — `{ path, absPath, kind: "sql" | "ts", set }`; `path` is POSIX and prefixed with the seeds directory name.
- `AppliedSeed` — `{ path, kind, set, statements, durationMs }`; a `.ts` seed reports `statements: 1`.
- `SeedContext` — what a `.ts` seed's default export receives: `{ db, set, env }` (`env` = `PG_PRIME_ENV` or null).
- `scanSeeds(seedsDir, sets?)` — base-set files, then each requested set's files, in request order.
- `seedSets(seedsDir)` — immediate subdirectories that contain at least one seed file.
- `productionRefusal(options)` — the refusal sentence or null.
- `DEFAULT_PROD_PATTERN` — `"prod|production|live"`, shared with `push --dev`.

## Flow
1. `productionRefusal`: `force` skips all checks; `production: true` refuses; otherwise the pattern is tested case-insensitively against `host:port/database` (`packages/pg-prime-kit/src/seed/run.ts:178-197`). A refusal returns `refused` / `production` (`:232-233`).
2. Every `--set` must be in `seedSets`; otherwise `refused` / `unknown_set` naming the sets on disk (`:235-247`).
3. `scanSeeds` collects files with code-unit-sorted `readdir` (`:107-118`, `:165-174`); no files → `nothing_to_do` (`:250-255`).
4. If any file is `.ts`, `openSeedDb` once for the whole run (`:257-258`).
5. Per file, `applyOne`: `.sql` → `splitStatements`, then `BEGIN`, each statement, `COMMIT` on a fresh `withClient` connection (`:298-312`).
6. `.ts` → `enableTsSpecifiers`, import the file, require a function default export, call it inside `db.transaction(tx => fn({ db: tx, set, env }))` (`:317-340`).
7. A failing file returns `failed` / `seed_failed` with earlier files committed and later ones in `skipped` (`:270-279`); `finally` closes the seed `Db` (`:282-284`).

## Gotchas
- Nothing is written to `pgprime.*` and `ensureHistory` is never called (`packages/pg-prime-kit/src/seed/run.ts:19-22`).
- Only files directly in `seeds/` or directly in `seeds/<set>/` run; deeper subdirectories are ignored (`:130`).
- `.ts`, `.mts`, `.js` and `.mjs` are all `kind: "ts"`; `.d.ts` is excluded (`:94-102`).
- Each `.sql` seed opens its own connection; an empty `.sql` file opens none and reports 0 statements (`:301-302`).
- `openSeedDb` errors (missing peer, no schema) throw out of `runSeeds` before any file runs, including `.sql` ones (`:258`).
- `prodPattern` is compiled with `new RegExp(pattern, "i")`; an empty string disables the check, an invalid one throws (`:189`).
- `--force` is not recorded anywhere.

## Tests
- `packages/pg-prime-kit/test/seed/seed.test.ts` (server, drives the CLI binary): `--list`, base set in filename order with a `.ts` seed, re-runnable with no history schema created, `--set` and unknown-set refusal, production and `--prod-pattern` refusals with `--force`, a failing seed stops and keeps earlier ones, empty dir is `nothing_to_do`, `.js` specifiers from `.ts` seeds.
- Run: `pnpm --filter @pg-prime/kit exec vitest run test/seed/seed.test.ts` (`PG_PRIME_TEST_URL` or localhost port 54329 (`packages/pg-prime-kit/test/support/db.ts:42`)).
- Uncovered: symlinked seed files, `.mjs`/`.js` seeds, a `.ts` seed without a function default export.

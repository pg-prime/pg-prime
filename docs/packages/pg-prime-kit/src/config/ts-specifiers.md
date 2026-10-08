# packages/pg-prime-kit/src/config/ts-specifiers.ts

## Purpose
A Node resolve hook that lets an uncompiled `.ts` file loaded by the kit import its siblings with the `.js` specifiers `tsc`'s `nodenext` resolution requires (`import { schema } from './db/schema.js'` when only `schema.ts` exists). Called before every import of user code: `loadConfig` and `loadSchema` in `packages/pg-prime-kit/src/config/load.ts:165`, `:330`, and the seed loaders in `packages/pg-prime-kit/src/seed/run.ts:41` and `packages/pg-prime-kit/src/seed/db.ts:24`. `tsSpecifierAdvice` in `config/load.ts` reuses `typeScriptSiblingUrl` to explain the failure on Nodes without the hook.

## Public API
- `typeScriptSiblingUrl(url: string): string | null` — for a resolved URL ending in `.js`/`.mjs`/`.cjs` that is not on disk, the URL of the existing `.ts`/`.mts`/`.cts` sibling; otherwise `null`.
- `typeScriptSibling(specifier, parentURL): string | null` — the rewritten specifier (`./x.js` → `./x.ts`) when the rule applies; pure apart from the disk check, used by the hook and tests.
- `enableTsSpecifiers(): Promise<boolean>` — installs the hook once per process via `module.registerHooks`; `true` when in force, `false` when Node lacks `registerHooks` (22.12–22.14).

## Flow
1. `enableTsSpecifiers` memoises a single install promise in `installed` (`packages/pg-prime-kit/src/config/ts-specifiers.ts:119`).
2. It dynamically imports `node:module`; without `registerHooks` it resolves `false` (`packages/pg-prime-kit/src/config/ts-specifiers.ts:120`).
3. Otherwise it registers a `resolve` hook that calls `typeScriptSibling` and passes the rewritten or original specifier to `nextResolve` (`packages/pg-prime-kit/src/config/ts-specifiers.ts:122`).
4. `typeScriptSibling` requires a `parentURL`, a `./` or `../` prefix and a JS extension, then resolves the specifier against the parent (`packages/pg-prime-kit/src/config/ts-specifiers.ts:93`).
5. `typeScriptSiblingUrl` returns the sibling only if the JS file is absent and the TS file exists (`packages/pg-prime-kit/src/config/ts-specifiers.ts:88`).

## Gotchas
- The rule never overrides a resolution that would succeed: an existing `.js` always wins, so a compiled project and the kit's own built `dist/*.js` are unaffected.
- Bare specifiers (`pg-prime`, `node:fs`), extensionless specifiers and absolute paths are never rewritten (`packages/pg-prime-kit/src/config/ts-specifiers.ts:95`).
- Non-`file:` URLs make `onDisk` return `false`, so they are never redirected (`packages/pg-prime-kit/src/config/ts-specifiers.ts:60`).
- The hook is process-wide and permanent once installed; it applies to every later `import()` in the process, not only user files.
- `module.registerHooks` arrived in Node 22.15 while `engines` is `>=22.12`; on older Nodes the import fails with Node's `ERR_MODULE_NOT_FOUND`, which `tsSpecifierAdvice` (`packages/pg-prime-kit/src/config/load.ts:109`) turns into a `ConfigError`.
- The hook and the error message share `typeScriptSiblingUrl`, so the message cannot claim a redirect the hook would not make.
- The hook runs in the calling thread (no loader worker, no separate hooks file to ship).

## Tests
- `packages/pg-prime-kit/test/cli/config.test.ts` — "typeScriptSibling — the narrowest rule that can work" (rewrite when only the `.ts` exists; no rewrite for an existing `.js`, missing sibling, bare, `node:`, extensionless specifiers), `typeScriptSiblingUrl` on resolved URLs, and `enableTsSpecifiers` returning `true` on the test Node.
- `packages/pg-prime-kit/test/seed/seed.test.ts` — the end-to-end redirect, through the built binary; an in-process test would observe vite's own rewrite instead of Node's.
- Run: `pnpm --filter @pg-prime/kit exec vitest run test/cli/config.test.ts test/seed/seed.test.ts` (kit suite: real server via `PG_PRIME_TEST_URL`, `dist/` built by `test/globalSetup.ts`).
- Uncovered: the `false` branch (Node < 22.15) is not run.

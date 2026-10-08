# packages/pg-prime-create/src/types.ts

## Purpose
The package's public type vocabulary, kept in one file so the generated `src/versions.ts` holds only data. Imported by `args.ts`, `prompts.ts`, `scaffold.ts` and the generated `versions.ts` (for `Versions`); re-exported by `packages/pg-prime-create/src/index.ts:12-19`. No runtime code.

## Public API
- `PackageManager` — `'npm' | 'pnpm' | 'yarn' | 'bun'`.
- `Versions` — string ranges `pgPrime`, `kit`, `testing`, `pg`, `typescript`, `typesNode`, `vitest`, `pglite`; also the `{{token}}` names templates use.
- `ScaffoldOptions` — `{ dir (absolute), name, testing, packageManager }`; nothing in it is defaulted or prompted.
- `ScaffoldResult` — `{ dir, files }`; `files` are relative to `dir`, `/`-separated, sorted, directories omitted.
- `CliOptions` — parsed `argv`: `dir`, `help`, `version`, `yes`, and `packageManager`/`testing`/`install`/`git` as `undefined` when not given.
- `ParseResult` — `{ options: CliOptions; errors: readonly string[] }`.

## Flow
1. Declarations only. `parseArgs` produces `CliOptions`/`ParseResult`; `resolveOptions` turns `CliOptions` into a `ProjectPlan` (a superset of `ScaffoldOptions`, `packages/pg-prime-create/src/prompts.ts:34`); `scaffold` consumes `ScaffoldOptions` and returns `ScaffoldResult`.

## Gotchas
- `undefined` in `CliOptions` means "not given", which is what triggers a prompt; do not fill defaults at parse time (`packages/pg-prime-create/src/types.ts:45-48`).
- Adding a key to `Versions` requires adding it to `scripts/versions.mjs` (the generator) and makes it a template token via `tokensFor` (`packages/pg-prime-create/src/scaffold.ts:78`); `test/templates.test.ts` keeps its own list of known tokens.
- The `packageManager` comment says it is only printed (`:34`), but `main` also runs `<pm> install` with it (`packages/pg-prime-create/src/main.ts:85`) and templates render `{{pm}}`/`{{pmRun}}`/`{{pmExec}}` from it.

## Tests
- Type-only; exercised through `test/args.test.ts` and `test/scaffold.test.ts`. Typecheck: `pnpm --filter @pg-prime/create typecheck` (generates `versions.ts` first).

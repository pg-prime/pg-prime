# packages/pg-prime-create/src/args.ts

## Purpose
The dependency-free argument parser, `--help` text and version for `create-pg-prime`, plus package-manager detection from `npm_config_user_agent`. Used by `main` (`packages/pg-prime-create/src/main.ts:10`) and `resolveOptions` (`packages/pg-prime-create/src/prompts.ts:20`); `parseArgs` is re-exported by `packages/pg-prime-create/src/index.ts:9`. Reads the package's own `package.json`.

## Public API
- `VERSION: string` — the `version` of `@pg-prime/create`'s `package.json`.
- `PACKAGE_MANAGERS: readonly PackageManager[]` — `['npm', 'pnpm', 'yarn', 'bun']`.
- `HELP: string` — the full `--help` text, ending in `Version <VERSION>`.
- `detectPackageManager(userAgent?): PackageManager` — first token's name before `/`; unknown or missing → `'npm'`.
- `parseArgs(argv): ParseResult` — parses flags and one positional directory; never throws.

## Flow
1. At import, `SELF` reads `../package.json` relative to the module URL, which is the package root from both `src/` and `dist/` (`packages/pg-prime-create/src/args.ts:16-18`).
2. `parseArgs` starts from `EMPTY` (all tri-state flags `undefined`) (`:64-73`, `:84-86`).
3. `--` ends option parsing; the rest are positionals (`:92-95`). `-y` and `-h` are the only short flags (`:96-103`); any other arg not starting with `--` is a positional (`:104-107`).
4. `--name=value` is split at `=`; a `no-` prefix is stripped and remembered (`:108-113`).
5. Boolean flags (`yes`, `help`, `version`, `testing`, `install`, `git`) set `true`, or `false` with `--no-`; an inline value is an error (`:114-118`).
6. `--pm` takes the next argv item or the inline value and must be one of `PACKAGE_MANAGERS` (`:119-132`).
7. Anything else is `unknown option --<name>` (`:133`); more than one positional is an error, and `dir` is the first positional (`:136-141`).

## Gotchas
- Unknown flags are errors, never positionals, so a typo in `--no-install` cannot silently install.
- Errors are collected so `--oops --help` still prints help; `main` prints help and then the errors and exits 1 (`packages/pg-prime-create/src/main.ts:52-57`).
- `--no-help`, `--no-version` and `--no-yes` are accepted (they set `false`) because every boolean gets a `no-` form (`:59`, `:116`). `--no-pm` is an unknown option.
- `--pm` with no following item reports a missing value; with a following item it consumes it even if it looks like a flag (`:120`).
- `HELP` is goldened against `docs/src/content/docs/reference/create.mdx` by `tools/docs-coverage.mjs`, and its option lines must appear verbatim in `packages/pg-prime-create/README.md` (checked by `test/args.test.ts`). Changing a flag means updating both.
- `detectPackageManager` affects only printed commands, template tokens and which binary runs the install.

## Tests
- `packages/pg-prime-create/test/args.test.ts`: defaults undefined, one positional and the two-positional error, boolean and `--no-` forms, `-y`/`-h`, `--pm` both spellings, refusal and missing value, unknown flag, value on boolean, `--`; `detectPackageManager` with and without a known agent; `HELP` lists every flag, ends with the version, and matches the README option lines.
- Run: `pnpm --filter @pg-prime/create exec vitest run test/args.test.ts`.
- Uncovered: `--no-help`/`--no-version`/`--no-yes`, `--pm` consuming a flag-looking value.

# packages/pg-prime-kit/src/cli/args.ts

## Purpose
Dependency-free argument parser and `--help` option renderer; option specs double as help text.
Used by `packages/pg-prime-kit/src/cli/main.ts` and every `cli/commands/*.ts` (which declare `*_OPTIONS` and read values with `str`/`bool`/`ms`/`list`); `parseDuration` is also used by `packages/pg-prime-kit/src/runner/files.ts`.

## Public API
- `OptionType` — `"string" | "boolean" | "duration"`.
- `OptionSpec` — `{ name, type, describe, repeatable?, placeholder?, defaultText? }`; one per long flag.
- `ParseResult` — `{ values, positionals, errors }`; `values` maps flag name to string, string[], boolean or number (ms).
- `parseDuration(text)` — `500`, `500ms`, `30s`, `2m`, `1h` to rounded milliseconds; `null` if unparsable.
- `parseArgs(argv, specs)` — parses long flags into a `ParseResult`; never throws, collects messages in `errors`.
- `str(values, name)` / `bool(values, name)` / `ms(values, name)` — typed reads; `undefined` (or `false` for `bool`) on missing or wrong type.
- `list(values, name)` — repeatable read: the array, a single string wrapped in an array, or `undefined`.
- `renderOptions(specs)` — aligned `--name <placeholder>  describe (default X)` lines for help output.

## Flow
1. Index specs by name (`packages/pg-prime-kit/src/cli/args.ts:54`).
2. Walk argv: `--` moves every remaining token into `positionals` and stops (`packages/pg-prime-kit/src/cli/args.ts:84`).
3. `-h` sets `values.help = true`; any other token not starting with `--` is a positional (`packages/pg-prime-kit/src/cli/args.ts:88`).
4. Split `--name=value` at the first `=`; the name is trimmed (`packages/pg-prime-kit/src/cli/args.ts:96`).
5. An unknown `--no-x` whose `x` is a boolean spec sets `x` to `false` (`packages/pg-prime-kit/src/cli/args.ts:101`).
6. Any other unknown name pushes `unknown option --name` (`packages/pg-prime-kit/src/cli/args.ts:110`).
7. An inline value is applied directly; a boolean without one becomes `true` (`packages/pg-prime-kit/src/cli/args.ts:113`).
8. Otherwise the next token is consumed as the value, unless it is absent or starts with `--` and is longer than 2, which yields `--name needs a value` (`packages/pg-prime-kit/src/cli/args.ts:121`).
9. `set` converts by type: boolean, duration via `parseDuration`, repeatable append, or plain string (`packages/pg-prime-kit/src/cli/args.ts:59`).

## Gotchas
- Unknown flags are errors, never positionals, so a typo such as `--dryrun` cannot silently fall through.
- Only long flags exist, except `-h`; `-x` style tokens are positionals, and a single-dash token after a value flag is consumed as its value.
- A bare `--` after a value flag is consumed as that flag's value, not treated as the terminator (`packages/pg-prime-kit/src/cli/args.ts:122`).
- Booleans with an inline value are `true` for anything except the literal `false` (`--dry-run=0` is `true`) (`packages/pg-prime-kit/src/cli/args.ts:61`).
- `--no-x=value` records an error but still sets `x` to `false` (`packages/pg-prime-kit/src/cli/args.ts:104`).
- A spec literally named `no-x` (e.g. `check`'s `no-schema`) is matched directly before the negation rule applies.
- Non-repeatable flags given twice keep the last value. `repeatable` is ignored for duration specs.
- Duration units are `ms`, `s`, `m`, `h`; a bare number means milliseconds; decimals are allowed and rounded (`packages/pg-prime-kit/src/cli/args.ts:32`).

## Tests
- `packages/pg-prime-kit/test/cli/usage.test.ts:14` ("parseArgs"): value/inline/negation/`--` forms, repeatable, unknown option, missing value, bad duration, and every documented duration spelling.
- `renderOptions` is exercised indirectly by the help-page tests in the same file.
- Run: `pnpm --filter @pg-prime/kit exec vitest run test/cli/usage.test.ts` (no server needed).
- Uncovered: `-h`, `--no-x=value`, boolean inline values, a single-dash or `--` token consumed as a value, `list`/`ms` accessors directly.

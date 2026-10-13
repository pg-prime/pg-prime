# packages/pg-prime-kit/src/cli/main.ts

## Purpose
The CLI runner: routes argv to a command, parses its flags, loads and resolves config, runs the command and renders its output, returning an exit code.
Called by `packages/pg-prime-kit/src/cli.ts`. Calls `parseArgs`/`renderOptions` (`cli/args.ts`), `loadConfig`/`resolveConfig` (`config/load.ts`), the thirteen `run*` functions and `*_OPTIONS` in `cli/commands/*.ts`, and `render` (`cli/output.ts`).

## Public API
- `main(argv, io?)` — runs one CLI invocation; resolves to the exit code (a number) and never calls `process.exit`. Never rejects for command errors; they become an `error` envelope.
- `CliIo` — injectable `stdout`, `stderr`, `env`, `cwd`, and `entry` (the script path re-executed on a type-stripping retry); every field defaults to the real process.

## Flow
1. Fill `CliIo` defaults (`packages/pg-prime-kit/src/cli/main.ts:294`); `entry` defaults to `process.argv[1]`.
2. Take the command words positionally: `noun` is `argv[0]` and `verb` is `argv[1]`, each only if it does not start with `-` (`packages/pg-prime-kit/src/cli/main.ts:303`).
3. Pre-scan argv for `--help`/`-h` and for `--output json`/`--output=json` (`earlyFormat`), used for errors raised before parsing (`packages/pg-prime-kit/src/cli/main.ts:305`).
4. `--version` anywhere prints `version()` and returns 0 (`packages/pg-prime-kit/src/cli/main.ts:318`).
5. No noun: empty argv or help prints `rootHelp()` and returns 0; otherwise a `usage` error (`packages/pg-prime-kit/src/cli/main.ts:322`).
6. A bare command (`noun: null`, currently `pull`) matches first; otherwise the noun must be `migrate` or `db` (`packages/pg-prime-kit/src/cli/main.ts:343`).
7. Noun without verb: help prints `nounHelp`, else a `usage` error listing the noun's commands. An unknown verb is a `usage` error (`packages/pg-prime-kit/src/cli/main.ts:358`).
8. Parse the rest with the command's options plus `GLOBAL_OPTIONS` (`packages/pg-prime-kit/src/cli/main.ts:392`); `format` is `json` only for `--output json`.
9. `--help` prints `commandHelp` and returns 0; parse errors, then an `--output` value other than `text`/`json`, become `usage` errors (`packages/pg-prime-kit/src/cli/main.ts:398`).
10. `loadConfig(--config, cwd)` then `resolveConfig` with `--url`, `--migrations`, `--schema`, `env`; `requireConnection` is false only for `needsConnection: false` (`lint`) (`packages/pg-prime-kit/src/cli/main.ts:413`).
11. Run the command and `emit` its `CommandOutput` (`packages/pg-prime-kit/src/cli/main.ts:424`).
12. A `ConfigError` with `retryWithStripTypes` and no `STRIP_TYPES_MARKER` in env re-execs `node --experimental-strip-types <entry> ...argv` once, returning the child's status (`packages/pg-prime-kit/src/cli/main.ts:426`).
13. Any other throw becomes an envelope with error code `config` (for `ConfigError`) or `internal`, exit 1 (`packages/pg-prime-kit/src/cli/main.ts:435`).

## Gotchas
- `emit` writes JSON to stdout always; text goes to stdout on exit 0 and to stderr otherwise (`packages/pg-prime-kit/src/cli/main.ts:311`).
- Help and version output are plain text even with `--output json`; only errors and command results produce an envelope.
- Routing is positional: `pg-prime --url x migrate apply` fails with "expected a command", because flags may not precede the command words.
- `--version` and `--help`/`-h` are detected anywhere in argv, including after `--` (`packages/pg-prime-kit/src/cli/main.ts:305`, `packages/pg-prime-kit/src/cli/main.ts:318`).
- `earlyFormat` only recognizes `--output json` / `--output=json`; after parsing, a bad `--output` value is reported in text because `format` falls back to `text` (`packages/pg-prime-kit/src/cli/main.ts:395`).
- Usage errors carry `durationMs: 0` and a fresh `at`; `command` is `pg-prime`, the noun, or the spelled command (`migrate apply`, `db seed`, `pull`) depending on how far routing got (`packages/pg-prime-kit/src/cli/main.ts:278`).
- `version()` returns `ENGINE.version`, which `plan.ts` reads from the kit's `package.json` (`packages/pg-prime-kit/src/cli/main.ts:221`).
- The strip-types re-exec uses `stdio: "inherit"`, so the parent emits nothing; the marker env var prevents a second fork (`packages/pg-prime-kit/src/cli/main.ts:429`).
- Command noun defaults to `migrate`; `seed` is under `db`, `pull` is bare (`packages/pg-prime-kit/src/cli/main.ts:199`, `packages/pg-prime-kit/src/cli/main.ts:208`). The only alias is `deploy` for `apply`.
- Each command's `exits` string is help text only; the codes actually returned come from the command's `CommandOutput.exitCode`.

## Tests
- `packages/pg-prime-kit/test/cli/usage.test.ts` (no server): root/noun/command help, `--version`, unknown noun/verb, unknown flag, JSON envelopes for usage errors, the `deploy` alias, bad `--output`.
- `packages/pg-prime-kit/test/cli/config.test.ts` ("the binary reads the config file"): config discovery, `.ts` loading, the one-sentence strip-types error.
- `packages/pg-prime-kit/test/cli/envelope.test.ts`, `authoring.test.ts`, `repeatables.test.ts`: per-command envelope goldens in `test/cli/golden/`; need a server (`PG_PRIME_TEST_URL` or the default at `packages/pg-prime-kit/test/support/db.ts:43`).
- Run: `pnpm --filter @pg-prime/kit exec vitest run test/cli/usage.test.ts` (or `test/cli` for all).
- Uncovered: the successful `--experimental-strip-types` re-exec branch and the `internal` error code path; `main` is never called in-process with an injected `CliIo`.

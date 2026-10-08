# packages/pg-prime-kit/src/cli/commands/pull.ts

## Purpose
`pg-prime pull`: a top-level verb (no `migrate` noun) that introspects the database and writes a deterministic TypeScript schema file, Tier-R repeatables under a `sql/` directory, and `pull.report.json`. Records nothing. Registered with `noun: null` at `packages/pg-prime-kit/src/cli/main.ts:206`; callees are `pullSchema` and `writePull` (`packages/pg-prime-kit/src/pull/pull.ts:43`, `packages/pg-prime-kit/src/pull/pull.ts:93`).

## Public API
- `PULL_OPTIONS: readonly OptionSpec[]` — `--out <file>`, `--sql-dir <dir>`, `--no-sql-dir`, `--dry-run`.
- `runPull(config: ResolvedConfig, argv: ParseResult): Promise<CommandOutput>` — status `written` or `dry_run` (exit 0), `refused` or `error` (exit 1).

## Flow
1. `out` is `--out`, else the config's first schema path, else `db/schema.ts` (`packages/pg-prime-kit/src/cli/commands/pull.ts:42`).
2. `sqlDir` is `undefined` with `--no-sql-dir`, else `--sql-dir`, else `config.repeatablesDir` (`packages/pg-prime-kit/src/cli/commands/pull.ts:44`).
3. Refuse with error code `config` when there is no connection (`packages/pg-prime-kit/src/cli/commands/pull.ts:68`).
4. `pullSchema` with connection, schemas, `out` and optional `sqlDir`; any throw becomes status `error`, code `pull_failed` (`packages/pg-prime-kit/src/cli/commands/pull.ts:78`).
5. `--dry-run`: return counts, repeatables and unsupported objects; the text is the generated TypeScript (`packages/pg-prime-kit/src/cli/commands/pull.ts:99`).
6. Otherwise `writePull` writes the files; the envelope reports `written.schema`, `written.report` and the repeatable count (`packages/pg-prime-kit/src/cli/commands/pull.ts:115`).
7. Text summarizes paths and object counts, lists up to 20 unsupported objects, and prints the next steps (`baseline`, then `generate`) (`packages/pg-prime-kit/src/cli/commands/pull.ts:131`).

## Gotchas
- The `--out` help default says `./db/schema.ts`, but the config's first `schema` path wins over it (`packages/pg-prime-kit/src/cli/commands/pull.ts:42`).
- `writePull` overwrites existing files on purpose (a pull is a re-takeable snapshot), unlike `writePlan` (`packages/pg-prime-kit/src/pull/pull.ts:88`).
- `writePull` is outside the `try`, so a write failure is thrown to `main` rather than reported as `pull_failed` (`packages/pg-prime-kit/src/cli/commands/pull.ts:115`).
- With `--no-sql-dir`, Tier-R objects are reported as unsupported instead of written.
- `pull.report.json` goes beside the `.ts` file (`packages/pg-prime-kit/src/pull/pull.ts:113`).
- The `hasConnection` refusal is defensive: `main` already requires a connection for every command but `lint` (`packages/pg-prime-kit/src/cli/main.ts:417`).

## Tests
- `packages/pg-prime-kit/test/pull/roundtrip.test.ts` — extracts to TypeScript, is idempotent, and `generate` against the same database is empty; golden `test/cli/golden/pull.written.json`.
- `packages/pg-prime-kit/test/pull/ddl-closeout.test.ts` — every new DSL spelling with an empty residue; second pull byte-identical; tier-3 shadow path.
- `packages/pg-prime-kit/test/cli/usage.test.ts` — `pull` is a bare verb with its own help.
- Run: `pnpm --filter @pg-prime/kit exec vitest run test/pull/roundtrip.test.ts`. Needs a real server (`PG_PRIME_TEST_URL`).
- Uncovered: `--dry-run`, `--no-sql-dir`, the `pull_failed` envelope.

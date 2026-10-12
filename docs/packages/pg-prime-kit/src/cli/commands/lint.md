# packages/pg-prime-kit/src/cli/commands/lint.ts

## Purpose
`pg-prime migrate lint [<file>…]`: a thin shell over `lintPlan` that picks the target migrations, synthesizes a plan for hand-written SQL, and aggregates findings into one exit code. The only command registered with `needsConnection: false` (`packages/pg-prime-kit/src/cli/main.ts:160`). Callees: `readMigrationsDir`, `lintPlan`, `formatFindings`, `unusedDirectives` (`src/lint/lint.ts`), `buildPlan`, and `historyPresent`/`readMigrationRows` for the default target set.

## Public API
- `LINT_OPTIONS: readonly OptionSpec[]` — `--fail-on <error|warn|off>`, `--rules <codes>` (repeatable or comma-separated), `--format <text|json>`, `--style`, `--all`.
- `runLint(config: ResolvedConfig, argv: ParseResult): Promise<CommandOutput>` — status `clean` (exit 0), `failed` (exit 3), or `refused` (exit 1, error code `usage`).

## Flow
1. `--format sarif` is refused with a sentence; any value other than `text`/`json` is refused (`packages/pg-prime-kit/src/cli/commands/lint.ts:97`).
2. `--fail-on` must be `error`, `warn` or `off`; `--rules` values are split on commas and trimmed (`packages/pg-prime-kit/src/cli/commands/lint.ts:109`).
3. Read every migration file in `config.migrationsDir` (`packages/pg-prime-kit/src/cli/commands/lint.ts:118`).
4. Positionals: resolve each against `process.cwd()` and match a file's `path` or `<migrationsDir>/<id>.sql`; any unmatched path is a refusal (`packages/pg-prime-kit/src/cli/commands/lint.ts:124`).
5. No positionals and `--all` or no connection: lint every file (`packages/pg-prime-kit/src/cli/commands/lint.ts:133`).
6. Otherwise lint files whose id is not `applied`/`baselined` in history; absent history means all files (`packages/pg-prime-kit/src/cli/commands/lint.ts:138`).
7. `planFor` returns the file's `.plan.json` plan, or builds a minimal one from statement markers and directives (`packages/pg-prime-kit/src/cli/commands/lint.ts:63`).
8. `lintPlan(plan, file.text, options)` per file; findings, directive errors and unused `nolint` directives are tagged with the migration id (`packages/pg-prime-kit/src/cli/commands/lint.ts:152`).
9. Exit 3 when any file's result has `exitCode === 3`; the text body is per-file `formatFindings` or, with `--format json`, a JSON object (`packages/pg-prime-kit/src/cli/commands/lint.ts:166`).

## Gotchas
- Without a connection the default target silently widens from "unapplied" to "every file on disk" (`packages/pg-prime-kit/src/cli/commands/lint.ts:133`). The envelope's `database` is then `null`.
- `--format` only changes the text body; `--output json` still emits the full envelope (`packages/pg-prime-kit/src/cli/commands/lint.ts:168`).
- A synthesized plan marks every statement `verb: "alter"`, `kind: "unknown"`, `dataLoss: "none"`, uses the file's `txmode` for transactionality, and defaults `pgVersionNum` to 150000 when there is no `requires-pg` directive (`packages/pg-prime-kit/src/cli/commands/lint.ts:66`). This mirrors what the runner executes.
- Every positional is treated as a file because `main` hands the command only the args after the verb (`packages/pg-prime-kit/src/cli/commands/lint.ts:121`).
- Every refusal uses error code `usage`, including an unknown file (`packages/pg-prime-kit/src/cli/commands/lint.ts:222`).
- Severity table, `nolint` grammar and acknowledgement rules live in `src/lint/lint.ts`, not here.

## Tests
- `packages/pg-prime-kit/test/cli/authoring.test.ts` — clean on a generated plan, fails with `--fail-on warn`, refuses `sarif`; fails on a hand-written txmode-none file that cannot re-execute; goldens `test/cli/golden/lint.{clean,failed,refused}.json`.
- `packages/pg-prime-kit/test/lint/` — `lintPlan` rules without a database.
- Run: `pnpm --filter @pg-prime/kit exec vitest run test/cli/authoring.test.ts`. The CLI tests need a real server (`PG_PRIME_TEST_URL`).
- Uncovered: positional file arguments, `--all`, `--rules`, `--style`, the no-connection path.

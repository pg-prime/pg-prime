# packages/pg-prime-kit/src/repeatables/

## Purpose
Tier R repeatables: `sql/` files (views, functions, triggers) that are re-applied whole when their bytes change rather than diffed. Scans the tree in a fixed order, plans by comparing hashes with `pgprime.repeatables`, applies in one transaction, and checks statements for idempotence.
Callers: `src/runner/run.ts` and `src/runner/status.ts` (the `RepeatablesPass` type), CLI `apply`/`check`/`status`/`verify` (`createRepeatablesPass`), CLI `doctor` (`planRepeatables`), `src/generate.ts` and CLI `verify` (`loadRepeatables` into the shadow); everything is re-exported from `src/index.ts` through `index.ts`.
Callees: `sql/statements.ts` (`splitStatements`, `lexSql`), `ir/hash.ts` (`sha256`), `node:fs`.

## Public API
- `scanRepeatables(dir, options?)` (`scan.ts`) — `RepeatableFile[]` in apply order; a missing root is `[]`.
- `RepeatableFile` — `path` (POSIX, prefixed with the root dir name), `absPath`, `sha256` (`sha256:<hex>`), `directives`, `statements`.
- `ScanOptions` — `pathPrefix` (default: the scanned directory's basename; `""` for none).
- `parseDirectives(text)` / `Directive` — `-- pg-prime:<name> <value>` lines from the leading comment block only, with 1-based `line`.
- `planRepeatables(dir, applied, options?)` (`plan.ts`) → `RepeatablesPlan` — `toApply` (new or hash-changed, in scan order), `unchanged`, `orphaned` (recorded paths gone from disk, sorted).
- `RepeatablesPass` — `{ plan(dir, applied), apply(client, toApply) }`, the seam the runner and status depend on.
- `createRepeatablesPass(options?)` — binds `planRepeatables` and `applyRepeatables`.
- `applyRepeatables(client, toApply)` (`apply.ts`) — every statement of every file in one `BEGIN`/`COMMIT`; returns one `AppliedRepeatable` per file; no transaction for an empty list.
- `loadRepeatables(client, dir, options?)` — scans and applies every file (for an empty shadow); returns the scanned files.
- `AppliedRepeatable` — `{ path, sha256, durationMs }`, the row the caller writes. `RepeatableClient` — `{ query(text) }`.
- `RepeatableApplyError` — `code = "PG_PRIME_REPEATABLE_FAILED"`, carries `path`, `statementIndex`, `sql`, `cause`; message abbreviates SQL to 160 chars.
- `checkIdempotence(statements)` (`idempotence.ts`) → `IdempotenceResult` (`ok`, `violations: IdempotenceViolation[]` with `index`, `sql`, `reason`).

## Flow
1. `scanRepeatables` resolves the root and walks it depth-first; files and directories share one code-unit sort, so `015_x.sql` runs between `010_a/` and `020_b/` (`packages/pg-prime-kit/src/repeatables/scan.ts:110`, `:114-134`).
2. Only `*.sql` (case-insensitive) regular files or symlinks to regular files are kept; symlinked directories are not followed (`packages/pg-prime-kit/src/repeatables/scan.ts:126-131`).
3. Each file is read as UTF-8, hashed with `sha256`, its header directives parsed, and its statements split by the lexer (`packages/pg-prime-kit/src/repeatables/scan.ts:151-160`).
4. `planRepeatables` puts a file in `unchanged` when the recorded hash equals the file's, else in `toApply`; recorded paths missing from disk become `orphaned` (`packages/pg-prime-kit/src/repeatables/plan.ts:38-48`).
5. `applyRepeatables` runs `BEGIN`, each statement in order, and `COMMIT`; a statement error rolls back quietly and throws `RepeatableApplyError` (`packages/pg-prime-kit/src/repeatables/apply.ts:74-97`).
6. `checkIdempotence` normalises each statement (comments out, value literals masked, whitespace collapsed) and applies verb rules (`packages/pg-prime-kit/src/repeatables/idempotence.ts:45-58`, `:110-147`).

## Gotchas
- `path` is the `pgprime.repeatables` primary key; changing `pathPrefix` or the directory name re-applies every file (`packages/pg-prime-kit/src/repeatables/scan.ts:153`).
- A missing root (or a subdirectory vanishing mid-walk) is an empty scan; any other read error such as `EACCES` propagates (`packages/pg-prime-kit/src/repeatables/scan.ts:99-106`).
- `parseDirectives` stops at the first non-blank, non-`--` line, so directives below SQL are ignored (`packages/pg-prime-kit/src/repeatables/scan.ts:62-73`).
- A `COMMIT` failure is rethrown as the raw error, not a `RepeatableApplyError` (`packages/pg-prime-kit/src/repeatables/apply.ts:92-96`).
- This directory never writes history; the runner records rows. The runner also bypasses `pass.apply` and executes statements itself (`packages/pg-prime-kit/src/runner/run.ts:1212-1217`).
- `orphaned` objects are only reported; nothing drops them from the database.
- `checkIdempotence` passes unknown verbs, `COMMENT ON`, `GRANT`, `REVOKE`, `SET`, `SELECT`, `DO`, `TRUNCATE` and similar (`packages/pg-prime-kit/src/repeatables/idempotence.ts:67`); flags bare `CREATE`, bare `DROP`, `ALTER TYPE … ADD VALUE` without `IF NOT EXISTS`, `INSERT` without `ON CONFLICT`, and any `UPDATE`/`DELETE` (`packages/pg-prime-kit/src/repeatables/idempotence.ts:114-144`).
- A bare `CREATE` is accepted when an earlier `DROP … IF EXISTS` names the same kind and unqualified name (`packages/pg-prime-kit/src/repeatables/idempotence.ts:99-108`).
- `checkIdempotence` has no caller inside `src/` beyond the barrel re-export.

## Tests
- `packages/pg-prime-kit/test/repeatables/scan.test.ts` (no server): one-sort order, `.sql` only, POSIX prefix, `pathPrefix` incl. empty, missing dir, hash spelling, lexer splitting, `parseDirectives` (header-only, CRLF), `planRepeatables` orphans and empty cases.
- `packages/pg-prime-kit/test/repeatables/idempotence.test.ts` (no server): accepted forms, violations by index, `$$` bodies, comment/literal laundering, DROP/CREATE pairing, unknown verbs, case-insensitivity.
- `packages/pg-prime-kit/test/repeatables/apply.test.ts` (server): file-order apply, rollback of earlier files on failure, no transaction for nothing, `loadRepeatables` applies unchanged files.
- `packages/pg-prime-kit/test/cli/repeatables.test.ts` (server): status drift → apply, re-apply on change, shadow-load failure at `generate`, `doctor` orphans.
- Run: `pnpm --filter @pg-prime/kit exec vitest run test/repeatables`. Server tests need `PG_PRIME_TEST_URL` or localhost port 54329 (`packages/pg-prime-kit/test/support/db.ts:42`).
- Uncovered: symlink handling and `EACCES` propagation in the scan.

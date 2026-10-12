# packages/pg-prime-kit/src/runner/files.ts

## Purpose
Reads the migrations directory: discovers `NNNN_name.sql` files, orders them by `(seq, name)`, parses `-- pg-prime:` directives and `stmt` markers through the SQL lexer, loads the sibling `.plan.json`, and merges file text with plan metadata into what the runner executes.
Callers: `src/runner/run.ts`, `src/runner/status.ts`, `src/checkpoint/checkpoint.ts` (`MIGRATION_FILE`), `src/data/batch.ts` (`BatchDirective` type), `src/generate.ts`, CLI commands `baseline`, `check`, `checkpoint`, `doctor`, `generate`, `lint`; re-exported from `src/index.ts`.
Callees: `sql/statements.ts` (`lexSql`, `splitStatements`, `canonicalize`), `cli/args.ts` (`parseDuration`).

## Public API
- `MIGRATION_FILE` — `/^(\d{4,})_([a-z0-9_]+)\.sql$/`.
- `TxMode` — `"transactional" | "none" | "segmented"`.
- `findDirectives(text)` — every `-- pg-prime:<name> <args>` comment the lexer sees, with byte offsets and 1-based line.
- `parseMigrationSql(text, subject)` → `ParsedSql` — header directives, statements from `stmt` markers (or the splitter), diagnostics.
- `readMigrationsDir(dir)` → `ReadMigrationsResult` — ordered `MigrationFile[]` plus directory diagnostics; a missing dir is empty.
- `executionPlan(file)` → `ExecutionPlan` — `PlanStatement[]` (file text, plan metadata) and `Segment[]`, with drift diagnostics.
- `BATCH_DEFAULTS` — `{ size: 1000, pauseMs: 100, maxIterations: 0 }`.
- `MigrationFile` — `id`, `seq`, `name`, `path`, `planPath`, `checksum` (`sha256:<hex>` of raw bytes), `text`, `directives`, `statements`, `statementSource`, `plan`, `txmode`, `diagnostics`.
- `FileDirectives` — `migration`, `plan`, `from`, `to`, `txmode`, `lockTimeout`, `statementTimeout`, `requiresPg`, `checkpoint`, `data`, `batch`, `all`.
- `BatchDirective` — `size`, `pauseMs`, `maxReplicaLagMs` (null when unset), `maxIterations` (0 = unbounded).
- `FileDirective`, `FileStatement` (`index`, `sql`, `lockClass`, `idempotent`, `hazards`, `segment`), `ParsedSql`, `ReadMigrationsResult`, `ExecutionPlan`.

## Flow
1. `readMigrationsDir` lists the directory, skips non-`.sql`, warns `migration_filename_ignored` on names that miss `MIGRATION_FILE` (`packages/pg-prime-kit/src/runner/files.ts:438-449`).
2. For each file: read bytes, `parseMigrationSql`, then try `<id>.plan.json`; absent → `plan_missing` info, unparseable or not `formatVersion: 1` → `plan_unreadable` error (`:459-477`, `:392-420`).
3. `txmode` = plan's, else the `txmode` directive, else `transactional` (`:479`). Files sort by `seq`, then `name` (`:497`).
4. `parseMigrationSql` reads the first occurrence of each directive (`:267`); `batch` is parsed by `parseBatch`, and a batch with a non-`none` txmode is `batch_requires_txmode_none` (`:296-310`).
5. No `stmt` markers → `splitStatements` fallback with a `statements_from_splitter` info diagnostic (`:315-341`).
6. With markers: text between consecutive `stmt`/`segment` markers is one statement; `segment N` sets the segment for following statements; out-of-order index, empty body and multi-statement body are diagnosed (`:344-388`).
7. `executionPlan` takes each file statement's SQL and the plan statement at the same index; canonical text mismatch is `statement_text_drift` (the file wins) (`:519-529`).
8. A statement with no plan entry gets synthetic metadata: lock class and idempotence from marker flags, timeouts from the `timeout` directive, `statement: null` for `shareUpdateExclusive` (`:530-554`).
9. Count mismatch with the plan is `statement_count_drift` (error) (`:557-564`). Segments come from the plan, else from `segment` markers, else one segment (`:567-580`).

## Gotchas
- Directives are found only in lexer comment segments, so a `-- pg-prime:stmt` inside `$$…$$` or a string is ignored (`packages/pg-prime-kit/src/runner/files.ts:128-133`).
- `checksum` hashes raw bytes; any whitespace edit changes it and trips the runner's checksum gates.
- The splitter fallback canonicalises statements (comments dropped), so executed text differs from the file's bytes, and resume indices depend on the splitter.
- `parseStmtFlags` defaults lock class to `accessExclusive` and `idempotent` to false; an unknown `lock=` value is ignored silently (`:224-238`).
- `parseBatch` reports malformed values as errors but returns the default; `size=0` becomes 1000 plus an error (`:198-212`).
- `requiresPg` is `Number(args)`, so a malformed value is `NaN`, not a diagnostic (`:290`).
- `executionPlan` diagnostics are not part of `MigrationFile.diagnostics`; the runner adds them per file.
- `lockTimeout: "per-statement"` maps to `timeouts.lock: null` (`:543`); the runner does not read `timeouts.lock`.

## Tests
- `packages/pg-prime-kit/test/runner/files.test.ts` (no server): directive names round-trip with `renderSql`, markers ignored inside dollar quotes and literals, splitter fallback, out-of-order/empty markers, `(seq, name)` ordering with duplicate seq, missing directory, `executionPlan` for a planless `txmode none` file.
- `packages/pg-prime-kit/test/data/batch.test.ts:353` — `-- pg-prime:batch` parsing, defaults, malformed values, `size=0`, transactional refusal.
- Run: `pnpm --filter @pg-prime/kit exec vitest run test/runner/files.test.ts`.
- Uncovered: `statement_text_drift`, `statement_count_drift`, `plan_unreadable`, `stmt_marker_multi`.

# packages/pg-prime-kit/src/generate.ts

## Purpose
The end-to-end `migrate generate` pipeline: desired state from a TypeScript schema registry loaded into a shadow, current state extracted from the target, rename resolution, diff, lock-safe statement building and staging, proof on a clone, and writing `NNNN_name.sql` + `.plan.json` (plus a `_concurrently` companion and `_data_` backfill stubs). Also hosts the hand-written file templates (`--empty`, `--data`), the `--hints-file` reader and the older three-connection `generateFromDatabases`. Callers: `packages/pg-prime-kit/src/cli/commands/generate.ts:209`, plus `packages/pg-prime-kit/src/cli/commands/check.ts:67` and `packages/pg-prime-kit/src/cli/commands/push.ts:129` (both pass `multiFile: false`), and the package entry. Callees: `schema/views.ts`, `shadow/ladder.ts`, `schema/load.ts`, `repeatables/`, `catalog/extract.ts`, `diff/*`, `plan/plan.ts`, `plan/emit.ts`, `prove/prove.ts`, `prove/temp-schema.ts`.

## Public API
- `generate(input: GenerateInput): Promise<GenerateResult>` — runs the pipeline; returns a `GenerateStatus`. Throws `GenerateRefusedError` for `prove: false` on a multi-file plan; rethrows non-refusal I/O errors.
- `GenerateInput` — `target`, `schema` (`SchemaLike`), `seq`, `name`, plus optional `admin`, `repeatablesDir`, `schemas`, `shadow`, `hints`, `acknowledge`, `prove`, `dumpOracle`, `allowSkippedOracle`, `pgDump`, `strictUnmodeled`, `noSafeRewrite`, `multiFile`, `outDir`, `by`, `interactive`, `token`.
- `GenerateResult` — `status`, `files`, `diff`, `currentIR`, `desiredIR`, `renameHints`, `candidates`, `unresolved`, `repeatables`, `shadow` (`tier`, `reason`), `proof`, `diagnostics`, `writeRefusal?`, `durationMs`.
- `GenerateStatus` — `"generated" | "up_to_date" | "missing_hints" | "hazards" | "proof_failed" | "refused"`.
- `GeneratedFile` — `{ stage: "main" | "concurrent" | "data", id, plan: Plan | null, sql, sqlPath?, planPath? }`; `plan` is `null` for a data stub.
- `Unresolved` — `{ type: "rename_or_recreate" | "confirm_data_loss", kind, from?, to?, entity?, confidence?, reason?, fix }`.
- `GenerateRefusedError` — `code = "PG_PRIME_GENERATE_REFUSED"`; also thrown by `readHintsFile` and by the CLI's flag parsers.
- `annotationHints(schema, defaultSchema = "public"): RenameHint[]` — `renamedFrom` on schemas, enums, domains, sequences, tables, columns, plus enum `renamedValues`, as raw hints.
- `acceptHints(hints, current, desired): RenameHint[]` — keeps a hint only if `from` exists in `current`, `to` is absent from `current` and present in `desired`.
- `nonConcurrentIndexes(schema, defaultSchema = "public"): Set<string>` — encoded `index` ids declared `.concurrently(false)`.
- `emptyMigrationSql(seq, name): string` — the `--empty` skeleton: transactional, one numbered `SELECT 1;` statement, no plan.
- `dataMigrationSql(input: DataStubInput): string` — `--data` / backfill stub: a `RAISE EXCEPTION` guard (`stmt 0`) and a keyset batch (`stmt 1`).
- `DataStubInput` — `{ seq, name, origin?, backfill?: { schema, table, column }, key? = "id", keyCast? = "bigint", size? }`.
- `slug(text): string` — lowercases and folds to `[a-z0-9_]`, trims underscores, `"x"` if empty.
- `readHintsFile(path): Promise<RenameHint[]>` — JSON array or `{ hints: [...] }` of `{ from, to }`; throws `GenerateRefusedError` on bad JSON or shape.
- `generateFromDatabases(input: DatabaseGenerateInput): Promise<DatabaseGenerateResult>` — same diff/plan/prove with the desired state as a database; always single-file.
- `DatabaseGenerateInput` / `DatabaseGenerateResult` — `admin`, `target`, `desired` connections and options; result has `plan`, `diff`, IRs, `diagnostics`, `written?`, `writeRefusal?`.

## Flow
1. Dedupe and sort `schemas` (default `["public"]`); `admin` defaults to the target with `database: "postgres"` (`packages/pg-prime-kit/src/generate.ts:163`, `:174`).
2. Render declared views into `<repeatablesDir>/020_views/` via `syncViewRepeatables`, writing only when `outDir` is set (`packages/pg-prime-kit/src/generate.ts:186`).
3. `provisionShadow` picks the tier; everything after runs in `try … finally shadow.dispose()` (`packages/pg-prime-kit/src/generate.ts:197`, `:446`).
4. `loadDesired` emits the schema into the shadow and, with `repeatablesDir`, loads every repeatable after it (`packages/pg-prime-kit/src/generate.ts:206`).
5. Extract the target with `observe: true`, and census which declared views it already has (`packages/pg-prime-kit/src/generate.ts:222`).
6. Rename hints = `annotationHints` then `input.hints`, filtered by `acceptHints`; diff with `diffIR`, then `renameCandidates` (`packages/pg-prime-kit/src/generate.ts:230`, `:237`).
7. Probe empty tables, collect `volatile_default` subjects, read `nonConcurrentIndexes`, then `buildStatements` + `splitStages` (`packages/pg-prime-kit/src/generate.ts:246`, `:264`).
8. If `splitStages` declines, rebuild with `multiFile: false` and add a `concurrent_rewrite_declined` warning (`packages/pg-prime-kit/src/generate.ts:267`).
9. All stages empty → `up_to_date` (`packages/pg-prime-kit/src/generate.ts:288`).
10. `draftPlans` builds one plan per non-empty stage; unanswered rename candidates or unacknowledged `DS*` error hazards → `missing_hints` unless `interactive` (`packages/pg-prime-kit/src/generate.ts:308`, `:705`).
11. Prove: tier 3 uses `proveInTempSchemas`, tiers 1–2 `proveOnShadowClone` with all stages (`packages/pg-prime-kit/src/generate.ts:500`).
12. Rebuild final plans chaining fingerprints through `proof.stageFingerprints`, and append a `data` stub per `volatile_default_split` column (`packages/pg-prime-kit/src/generate.ts:359`, `:375`).
13. Proof not `passed` → `proof_failed`; unacknowledged error hazards → `hazards`; no `outDir` → `generated` without writing (`packages/pg-prime-kit/src/generate.ts:395`–`:402`).
14. Write each file: `writePlan` for planned files, `writeFile(…, { flag: "wx" })` for stubs; a `WriteRefusedError` → `refused` with `writeRefusal` (`packages/pg-prime-kit/src/generate.ts:404`).

## Gotchas
- The first stage's `from` is the live `current.ir.fingerprint`, not the rename-folded `diff.current`; using the folded one would make every renaming plan unappliable (`packages/pg-prime-kit/src/generate.ts:480`).
- Stage file names: `name`, `name_concurrently`, `name_data`; renames and diagnostics are attached only to the first draft (`packages/pg-prime-kit/src/generate.ts:477`, `:489`).
- `prove: false` with more than one draft throws: the intermediate fingerprint is only measurable on the clone (`packages/pg-prime-kit/src/generate.ts:336`).
- The "default schema" used for views, annotations and index opt-outs is `schemas[0]` after sorting, i.e. alphabetically first, not first-configured (`packages/pg-prime-kit/src/generate.ts:186`, `:230`).
- View repeatables are written before the shadow and before any hazard/proof gate, so a run that ends `hazards`, `proof_failed` or `missing_hints` may still have rewritten `020_views/` files.
- With `interactive: true`, unresolved decisions do not stop the run; they are still reported in `unresolved` (`packages/pg-prime-kit/src/generate.ts:310`).
- Stubs are written with `wx`, so an existing stub file raises `EEXIST` (not a refusal) (`packages/pg-prime-kit/src/generate.ts:410`).
- A `refused` result lists already-written files followed by the unwritten rest (`packages/pg-prime-kit/src/generate.ts:422`).
- Stub names are `slug`-folded so `readMigrationsDir` does not skip them (`packages/pg-prime-kit/src/generate.ts:381`).
- `acceptHints` processes table hints first so a column hint on a renamed table is checked under the old table name (`packages/pg-prime-kit/src/generate.ts:678`).
- `generateFromDatabases` does not sort `schemas`, uses `orderStatements` (no staging) and only treats `WriteRefusedError` as a refusal (`packages/pg-prime-kit/src/generate.ts:971`, `:1037`).
- `shadow.dispose()` errors are swallowed.

## Tests
- `packages/pg-prime-kit/test/generate/rewrites.test.ts` — `generate`'s two-file rewrites, the data stub, `concurrently(false)`, `--no-safe-rewrite`, and the `prove: false` refusal.
- `packages/pg-prime-kit/test/generate/stages.test.ts` — `splitStages` and the managed schema set carried in the plan; `test/generate/annotations.test.ts` and `test/enum.test.ts` — `annotationHints`/`acceptHints`.
- `packages/pg-prime-kit/test/schema-emit/views.test.ts` — declared views through `generate`, second run `up_to_date`.
- `generateFromDatabases` (imported as `generate`) — `test/corpus.test.ts`, `roundtrip`, `evolve`, `rename`, `enum`, `ddl`, `schema`, `provisioning`, `plan-gates`, `dump-oracle`, `oracle-strict`, and `test/support/migrations.ts`.
- `packages/pg-prime-kit/test/cli/authoring.test.ts` — the binary: `--empty`/`--data`, dry run, unacknowledged drop, rename proposals, `--offline` refusal.
- Run: `pnpm --filter @pg-prime/kit exec vitest run test/generate test/schema-emit/views.test.ts` (real server via `PG_PRIME_TEST_URL`).
- Uncovered: `readHintsFile`, `slug` and `nonConcurrentIndexes` have no direct unit test; the stub `EEXIST` path and the partial `refused` file list are not asserted.

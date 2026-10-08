# packages/pg-prime-kit/src/generate.ts

## Purpose
The end-to-end `migrate generate` pipeline: desired state from a TypeScript schema registry loaded into a shadow together with the declared lane (views, policies, triggers), current state extracted from the target, rename resolution, diff, lock-safe statement building and staging, proof on a clone, and writing `NNNN_name.sql` + `.plan.json` (plus a `_concurrently` companion and `_data_` backfill stubs). Also hosts the hand-written file templates (`--empty`, `--data`), the `--hints-file` reader and the older three-connection `generateFromDatabases`. Callers: `packages/pg-prime-kit/src/cli/commands/generate.ts:210`, plus `packages/pg-prime-kit/src/cli/commands/check.ts:69` and `packages/pg-prime-kit/src/cli/commands/push.ts:129` (both pass `multiFile: false`), and the package entry. Callees: `schema/views.ts`, `schema/declared.ts`, `shadow/ladder.ts`, `schema/load.ts`, `repeatables/`, `catalog/extract.ts`, `diff/*`, `plan/plan.ts`, `plan/emit.ts`, `prove/prove.ts`, `prove/temp-schema.ts`.

## Public API
- `generate(input: GenerateInput): Promise<GenerateResult>` — runs the pipeline; returns a `GenerateStatus`. Throws `GenerateRefusedError` for `prove: false` on a multi-file plan, `LaneRefusedError` when the declared lane refuses; rethrows non-refusal I/O errors.
- `GenerateInput` — `target`, `schema` (`SchemaLike`), `seq`, `name`, plus optional `admin`, `repeatablesDir`, `schemas`, `shadow`, `hints`, `acknowledge`, `prove`, `dumpOracle`, `allowSkippedOracle`, `pgDump`, `strictUnmodeled`, `noSafeRewrite`, `multiFile`, `outDir`, `by`, `interactive`, `token`.
- `GenerateResult` — `status`, `files`, `diff`, `currentIR`, `desiredIR`, `renameHints`, `candidates`, `unresolved`, `repeatables`, `shadow` (`tier`, `reason`), `proof`, `diagnostics`, `laneHazards` (all acknowledged), `writeRefusal?`, `durationMs`.
- `GenerateStatus` — `"generated" | "up_to_date" | "missing_hints" | "hazards" | "proof_failed" | "refused"`.
- `GeneratedFile` — `{ stage: "main" | "concurrent" | "data", id, plan: Plan | null, sql, sqlPath?, planPath? }`; `plan` is `null` for a data stub.
- `Unresolved` — `{ type: "rename_or_recreate" | "confirm_data_loss", kind, from?, to?, entity?, confidence?, reason?, fix }`.
- `GenerateRefusedError` — `code = "PG_PRIME_GENERATE_REFUSED"`; also thrown by `readHintsFile` and by the CLI's flag parsers.
- `LaneRefusedError` — subclass carrying the lane's error `diagnostics` and `hazards`; nothing was written.
- `shadowRepeatables(schema, dir, hand, schemaMap, schemas): RepeatableFile[]` — hand files plus the views and declared lane rendered into the shadow's schemas, prune excluded, in scan order; also used by `migrate verify`.
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
1. Dedupe and sort `schemas` (default `["public"]`); `admin` defaults to the target with `database: "postgres"` (`packages/pg-prime-kit/src/generate.ts:222`, `:211`).
2. Read the target before any shadow exists: extract with `observe: true`, probe empty tables, census declared views, read `readLaneState` (`packages/pg-prime-kit/src/generate.ts:226`–`:238`).
3. With `repeatablesDir`, `readLane` renders views and the declared lane, checks `laneConflicts` and unknown policy roles (predefined roles exist), and throws `LaneRefusedError` on any error, also for a lane with nothing but views (`packages/pg-prime-kit/src/generate.ts:543`).
4. `provisionShadow` picks the tier; everything after runs in `try … finally shadow.dispose()` (`packages/pg-prime-kit/src/generate.ts:241`, `:497`).
5. `loadDesired` emits the schema into the shadow, applies `shadowRepeatables`, and reads the shadow's lane state (`packages/pg-prime-kit/src/generate.ts:250`).
6. `afterState` merges before and shadow states; `laneHazardsOf` raises RL101/RL103/RL105/RL108 and throws `LaneRefusedError` unless each is acknowledged, recording new acks in the prune header and dropping recorded ones whose loss no longer stands in the after-state (the policy is declared again, FORCE returns, the role is covered again) (`packages/pg-prime-kit/src/generate.ts:263`, `:624`).
7. Rename hints = `annotationHints` then `input.hints`, filtered by `acceptHints`; the census drops declared kinds; diff with `diffIR`, then `renameCandidates` (`packages/pg-prime-kit/src/generate.ts:267`, `:280`).
8. Collect `volatile_default` subjects and `nonConcurrentIndexes`, then `buildStatements` (with the lane's before/after state) + `splitStages` (`packages/pg-prime-kit/src/generate.ts:287`, `:295`).
9. If `splitStages` declines, rebuild with `multiFile: false` and add a `concurrent_rewrite_declined` warning (`packages/pg-prime-kit/src/generate.ts:298`).
10. Without `outDir`, `syncDeclared(write: false)` reports a stale lane; all stages empty → write the lane (with `outDir`; a `syncDeclared` error throws `LaneRefusedError`) and return `up_to_date` (`packages/pg-prime-kit/src/generate.ts:312`, `:335`).
11. `draftPlans` builds one plan per non-empty stage; unanswered rename candidates or unacknowledged `DS*` error hazards → `missing_hints` unless `interactive` (`packages/pg-prime-kit/src/generate.ts:357`, `:956`).
12. Prove: tier 3 uses `proveInTempSchemas`, tiers 1–2 `proveOnShadowClone` with all stages (`packages/pg-prime-kit/src/generate.ts:751`).
13. Rebuild final plans chaining fingerprints through `proof.stageFingerprints`, and append a `data` stub per `volatile_default_split` column (`packages/pg-prime-kit/src/generate.ts:409`, `:425`).
14. Proof not `passed` → `proof_failed`; unacknowledged error hazards → `hazards`; no `outDir` → `generated` without writing (`packages/pg-prime-kit/src/generate.ts:445`–`:452`).
15. Write the lane, then each file: `writePlan` for planned files, `writeFile(…, { flag: "wx" })` for stubs; a `WriteRefusedError` → `refused` with `writeRefusal` (`packages/pg-prime-kit/src/generate.ts:453`).

## Gotchas
- The first stage's `from` is the live `current.ir.fingerprint`, not the rename-folded `diff.current`; using the folded one would make every renaming plan unappliable (`packages/pg-prime-kit/src/generate.ts:731`).
- Stage file names: `name`, `name_concurrently`, `name_data`; renames and diagnostics are attached only to the first draft (`packages/pg-prime-kit/src/generate.ts:728`, `:740`).
- `prove: false` with more than one draft throws: the intermediate fingerprint is only measurable on the clone (`packages/pg-prime-kit/src/generate.ts:386`).
- The default schema of a schema-less declaration is `public` everywhere (views, the lane, its shadow render, annotations, index opt-outs), as in `emitSchema`; it is not taken from `schemas`.
- Lane files are written only on `up_to_date` or after every gate passes, just before the migration files; a lane refusal writes nothing.
- On tier 3 the shadow lives in the target, so every target read happens before `provisionShadow`, and the shadow never loads the prune file.
- With `interactive: true`, unresolved decisions do not stop the run; they are still reported in `unresolved` (`packages/pg-prime-kit/src/generate.ts:359`).
- Stubs are written with `wx`, so an existing stub file raises `EEXIST` (not a refusal) (`packages/pg-prime-kit/src/generate.ts:461`).
- A `refused` result lists already-written files followed by the unwritten rest (`packages/pg-prime-kit/src/generate.ts:473`).
- Stub names are `slug`-folded so `readMigrationsDir` does not skip them (`packages/pg-prime-kit/src/generate.ts:431`).
- `acceptHints` processes table hints first so a column hint on a renamed table is checked under the old table name (`packages/pg-prime-kit/src/generate.ts:929`).
- `generateFromDatabases` does not sort `schemas`, uses `orderStatements` (no staging) and only treats `WriteRefusedError` as a refusal (`packages/pg-prime-kit/src/generate.ts:1222`, `:1288`).
- `shadow.dispose()` errors are swallowed.

## Tests
- `packages/pg-prime-kit/test/generate/rewrites.test.ts` — `generate`'s two-file rewrites, the data stub, `concurrently(false)`, `--no-safe-rewrite`, and the `prove: false` refusal.
- `packages/pg-prime-kit/test/generate/stages.test.ts` — `splitStages` and the managed schema set carried in the plan; `test/generate/annotations.test.ts` and `test/enum.test.ts` — `annotationHints`/`acceptHints`.
- `packages/pg-prime-kit/test/schema-emit/views.test.ts` — declared views through `generate`, second run `up_to_date`, a hand file at a view path refusing a views-only lane.
- `packages/pg-prime-kit/test/generate/declared-rls.test.ts` — the declared lane end to end (edit, prune, heal, tier 3) and RL101/RL103/RL105/RL108, `policy_unknown_role` (predefined roles pass), a lapsed acknowledgement asked again, a policy outside the managed schemas refused before a tier-3 shadow, `public` as the default schema, a refused run writing nothing (contents compared).
- `generateFromDatabases` (imported as `generate`) — `test/corpus.test.ts`, `roundtrip`, `evolve`, `rename`, `enum`, `ddl`, `schema`, `provisioning`, `plan-gates`, `dump-oracle`, `oracle-strict`, and `test/support/migrations.ts`.
- `packages/pg-prime-kit/test/cli/authoring.test.ts` — the binary: `--empty`/`--data`, dry run, unacknowledged drop, rename proposals, `--offline` refusal.
- Run: `pnpm --filter @pg-prime/kit exec vitest run test/generate test/schema-emit/views.test.ts`; lane specs also need role creation (real server via `PG_PRIME_TEST_URL`).
- Uncovered: `readHintsFile`, `slug` and `nonConcurrentIndexes` have no direct unit test; the stub `EEXIST` path and the partial `refused` file list are not asserted.

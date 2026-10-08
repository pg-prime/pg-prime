# packages/pg-prime-kit/src/plan/plan.ts

## Purpose
Defines the `.plan.json` artifact (`Plan`) and builds it from ordered statements, and renders the executable `.sql` text with its `-- pg-prime:` header and per-statement markers. Called by `generate.ts`, `checkpoint/checkpoint.ts`, `prove/*`, `cli/commands/baseline.ts`; read back by `plan/emit.ts`, `lint/*`, `runner/{apply,run,files}.ts` and `cli/main.ts`.

## Public API
- `ENGINE` — `{ name: "pg-prime-kit", version: "0.0.0-spike", backend: "in-house", irVersion: 1 }`, stamped into every plan.
- `osUser(env?)` — `USER`, then `USERNAME`, then `os.userInfo().username`, then `"unknown"`; blank values are skipped.
- `PlanStatement` — a `Statement` minus `phase`/`stage`, plus `index` and `timeouts: { lock, statement }`.
- `PlanHazard` — `{ code, severity, statement, subject, message, acknowledged }`; `statement` is `-1` for a diagnostic-derived hazard.
- `Proof` — `{ status: "passed" | "failed" | "skipped", reason?, at?, shadow?, provisioning?, driftDeltas?, deltas?, stageFingerprints?, error?, durationMs?, dumpOracle? }`.
- `Plan` — `{ formatVersion: 1, planId, engine, generated, migration, from, to, pg, schemas, normalized, shadowTier, txmode, segments, statements, renames, hazards, unmodeled, repeatables, acknowledged, proof }`.
- `Acknowledgement` — `{ dataLoss, by, reason, at, blanket }`; `AcknowledgeInput` — `{ dataLoss?, by?, reason?, allowDataLoss? }`.
- `hazardSeverity(code)` — the severity table (DS/MF/TX/EN error, BC/LK warn); unknown codes are `error`.
- `BuildPlanInput` — `{ seq, name, statements, segments, fromFingerprint, toFingerprint, pgVersionNum, renames, diagnostics, by?, shadowTier?, proof?, acknowledge?, schemas?, data?, checkpoint?, repeatables? }`.
- `MIGRATION_NAME` — `/^[a-z0-9_]+$/`.
- `InvalidMigrationIdError` — `code = "PG_PRIME_INVALID_MIGRATION_ID"`.
- `migrationId(seq, name)` — `NNNN_name` (seq zero-padded to 4); throws `InvalidMigrationIdError` for a negative/non-integer seq or a bad name.
- `buildPlan(input): Plan` — pure apart from the clock and `osUser`; throws only via `migrationId`.
- `RenderInput` — `{ id, name, statements, segments, txmode, from, to, pgMin, data?, checkpoint? }`.
- `renderSql(r): string` — the psql-runnable `.sql` text.

## Flow
1. Map each `Statement` to a `PlanStatement` with `lock: "3s"` and `statement: "30s"`, or `null` for `shareUpdateExclusive` statements (`packages/pg-prime-kit/src/plan/plan.ts:247-268`).
2. Expand every statement hazard into a `PlanHazard` whose subject is the first of `destroys`, `produces`, `consumes` (`packages/pg-prime-kit/src/plan/plan.ts:277-290`).
3. Append every error-severity diagnostic as a hazard with `statement: -1` (`packages/pg-prime-kit/src/plan/plan.ts:291-301`).
4. Mark hazards acknowledged: every `warn`, every error under `allowDataLoss`, and errors whose subject is in `acknowledge.dataLoss` (`packages/pg-prime-kit/src/plan/plan.ts:273-274`).
5. Build `acknowledged` only when an acknowledgement was asked for, listing the acknowledged error subjects (`packages/pg-prime-kit/src/plan/plan.ts:303-315`).
6. `txmode` is `transactional` for one transactional segment, `segmented` for several, `none` if any segment is bare (`packages/pg-prime-kit/src/plan/plan.ts:317-321`).
7. Render the SQL with `pgMin` 150000 and hash it into `migration.sha256` (`packages/pg-prime-kit/src/plan/plan.ts:323-341`).
8. Hash the canonical `core` (everything except `generated`, `acknowledged`, `proof`) into `planId` (`packages/pg-prime-kit/src/plan/plan.ts:338-363`).
9. `renderSql` writes header directives, `SET search_path = pg_catalog;`, then per segment a `-- pg-prime:segment` line and per statement a `-- pg-prime:stmt` line with lock/idempotence/hazard flags (`packages/pg-prime-kit/src/plan/plan.ts:390-432`).

## Gotchas
- `planId` excludes `generated`, `acknowledged` and `proof`, so re-proving or re-acknowledging keeps the id (`packages/pg-prime-kit/src/plan/plan.ts:361-363`).
- `migration.sha256` covers the text `buildPlan` rendered, including `data`/`checkpoint` header lines. `plan/emit.ts`'s `planSql` does not pass those flags, so a plan built with them must be written with its own renderer (`packages/pg-prime-kit/src/checkpoint/checkpoint.ts:239` does); otherwise `packages/pg-prime-kit/src/runner/run.ts:712` reports a checksum mismatch.
- `pg.minVersion` and the `requires-pg` header are hard-coded to 150000 (`packages/pg-prime-kit/src/plan/plan.ts:333`, `packages/pg-prime-kit/src/plan/plan.ts:344`); `pgVersionNum` is recorded only as `generatedAgainst`.
- The header timeout is the single shared value, or `per-statement` when statements differ; `null` renders as `0` (`packages/pg-prime-kit/src/plan/plan.ts:394-399`).
- An unknown hazard code is `error` (`packages/pg-prime-kit/src/plan/plan.ts:192-194`), so a new emitter code without a table entry blocks `writePlan`.
- Warn hazards are always `acknowledged: true` (`packages/pg-prime-kit/src/plan/plan.ts:273-274`); "acknowledged" means "not blocking".
- `schemas` defaults to `["public"]` and is sorted (`packages/pg-prime-kit/src/plan/plan.ts:345`).
- `unmodeled` reads `count` from the `unmodeled_kind` diagnostic, not its message (`packages/pg-prime-kit/src/plan/plan.ts:355-357`).
- `renderSql` pins `search_path = pg_catalog`; this relies on every emitted identifier being schema-qualified (`packages/pg-prime-kit/src/plan/plan.ts:411-414`).

## Tests
- `packages/pg-prime-kit/test/plan-gates.test.ts` — `migrationId` validation, acknowledgement recording, severity table completeness, header timeouts, structural `unmodeled` census (unit cases plus live `generate()` cases).
- `packages/pg-prime-kit/test/cli/envelope.test.ts:290` — `osUser` fallback chain; `test/lint/*.test.ts` build plans with `buildPlan` (no server).
- Also used by `test/enum.test.ts`, `test/plumbing.test.ts`, `test/runner/files.test.ts`, `test/kinds/*`.
- Run: `pnpm --filter @pg-prime/kit exec vitest run test/plan-gates.test.ts test/lint`; live cases need `PG_PRIME_TEST_URL`.
- Uncovered: `planId` stability across re-proof and the `segmented` txmode are not asserted directly.

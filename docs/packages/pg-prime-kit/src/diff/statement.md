# packages/pg-prime-kit/src/diff/statement.ts

## Purpose
The `Statement` record every DDL emitter produces and its supporting vocabularies: lock class, transactionality, emission stage and the `PHASE` tie-break ranks. Produced by `diff/ddl.ts`, ordered by `diff/order.ts`, copied into `PlanStatement` by `plan/plan.ts`; `runner/files.ts` reuses `LockClass` when parsing `-- pg-prime:stmt` flags.

## Public API
- `LockClass` — `"accessExclusive" | "shareRowExclusive" | "share" | "shareUpdateExclusive" | "rowExclusive" | "none"`; reported, never certified.
- `Transactionality` — `"transactional" | "nonTransactional" | "commitBoundaryAfter"`; the third closes the segment after the statement.
- `Stage` — `"main" | "concurrent" | "data"`; which emitted file a statement belongs to.
- `Statement` — `{ sql, verb, kind, produces, consumes, destroys, releases, transactionality, lockClass, idempotent, dataLoss, rewrite, hazards, phase, stage? }`; the four id lists are encoded `StableId`s.
- `PHASE` — `as const` record of numeric ranks, `createExtension: -1` through `dropSchema: 85`.

## Flow
1. `buildStatements` fills each `Statement`, usually through its `simple()` helper whose defaults are transactional, `accessExclusive`, non-idempotent, no data loss (`packages/pg-prime-kit/src/diff/ddl.ts:1138-1156`).
2. `produces`/`consumes`/`destroys`/`releases` become hard ordering edges in `orderStatements` (`packages/pg-prime-kit/src/diff/order.ts:59-62`); `phase` only breaks ties (`packages/pg-prime-kit/src/diff/order.ts:68-69`).
3. `transactionality` drives segmentation and the EN101 check (`packages/pg-prime-kit/src/diff/order.ts:95-131`); `stage` drives `splitStages` (`packages/pg-prime-kit/src/diff/order.ts:174-219`).
4. `buildPlan` copies the fields into `PlanStatement` and adds `index` and timeouts (`packages/pg-prime-kit/src/plan/plan.ts:248-269`).

## Gotchas
- `phase` is not a correctness mechanism; a missing `produces`/`consumes` edge falls back to `PHASE` order, which can be wrong across schemas (see `referencesHeldBy`, `packages/pg-prime-kit/src/diff/ddl.ts:256-274`).
- `stage` absent means `"main"` (`packages/pg-prime-kit/src/diff/statement.ts:49-50`); `splitStages` treats it so via `stageOf` (`packages/pg-prime-kit/src/diff/order.ts:153`).
- `dropIndexConcurrently` (21) must stay after `dropConstraint` (20): on a `txmode none` replay the constraint may own the index, and `DROP INDEX` on it fails (`packages/pg-prime-kit/src/diff/statement.ts:63-72`).
- `commitBoundaryAfter` is for `ALTER TYPE … ADD VALUE`: transactional, but the new label is unusable until commit (`packages/pg-prime-kit/src/diff/statement.ts:10-15`).
- `"data"` is declared but no emitter assigns it; the backfill stub is written by `generate.ts` from a `volatile_default_split` diagnostic.
- Some `produces`/`consumes` keys are synthetic (`<constraint id>#index` in `packages/pg-prime-kit/src/diff/ddl.ts:1610`) and match no fact.

## Tests
- No dedicated spec. `PHASE`/`Statement` are constructed by hand in `test/lint/rules.test.ts`, `test/lint/lint.test.ts`, `test/plan-gates.test.ts`, `test/generate/stages.test.ts` and `test/enum.test.ts`.
- Run: `pnpm --filter @pg-prime/kit exec vitest run test/lint test/generate/stages.test.ts` (the `test/lint` files need no server; `stages.test.ts` has a live case).
- Uncovered: the relative order of `PHASE` entries is not asserted anywhere.

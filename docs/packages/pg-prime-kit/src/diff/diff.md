# packages/pg-prime-kit/src/diff/diff.ts

## Purpose
`diffIR`: compares a current and a desired `SchemaIR` and returns deltas, accepted renames, rejected hints and diagnostics. It folds rename hints in first via `applyRenameHints` (`diff/rename.ts`). Callers: `generate.ts`, `checkpoint/checkpoint.ts`, `prove/prove.ts`, `prove/temp-schema.ts`, `cli/commands/{verify,check,baseline}.ts`; its result feeds `diff/ddl.ts` and `diff/candidates.ts`.

## Public API
- `DiffResult` — `{ deltas, renames, rejectedHints, diagnostics, current }`; `current` is the current IR after accepted renames, which is what statements are built against.
- `DiffOptions` — `{ renameHints?, strictUnmodeled?, diagnostics? }`; `diagnostics` are the extractor's, used only by `strictUnmodeled`.
- `diffIR(currentIn, desired, options?): DiffResult` — pure; never queries, never throws on content (only `applyRenameHints`/`parseId` errors propagate).
- `labelsOf(ir, typeId): string[]` — an enum's label names in `ordinal` order.
- `isEmptyDiff(result): boolean` — `result.deltas.length === 0`.

## Flow
1. Apply rename hints, replacing the current IR (`packages/pg-prime-kit/src/diff/diff.ts:60`).
2. Index both sides by encoded id, excluding `enumLabel` facts (`packages/pg-prime-kit/src/diff/diff.ts:64-73`).
3. Adopt undeclared partitions: a current table with non-null `partitionOf` absent from desired is removed from the current side with all descendants, reported as `adopted_partition` info (`packages/pg-prime-kit/src/diff/diff.ts:85-100`).
4. Retain undeclared extensions: removed from the current side, reported as `extension_retained` info (`packages/pg-prime-kit/src/diff/diff.ts:110-121`).
5. For each desired fact: absent on current → `create`; content hash differs → `alter` (`packages/pg-prime-kit/src/diff/diff.ts:125-132`). Each current-only fact → `drop` (`packages/pg-prime-kit/src/diff/diff.ts:133-135`).
6. For each enum type present on both sides, compare label lists: survivors must keep their relative order, else `EN102` error and no label deltas (`packages/pg-prime-kit/src/diff/diff.ts:143-158`); each new label becomes `addEnumValue` anchored `AFTER` its predecessor or `BEFORE` its successor (`packages/pg-prime-kit/src/diff/diff.ts:159-173`).
7. Sort deltas by kind rank (`ORDER`, `packages/pg-prime-kit/src/diff/diff.ts:33-46`) then encoded id (`packages/pg-prime-kit/src/diff/diff.ts:176-183`).
8. With `strictUnmodeled`, re-raise each non-Tier-R `unmodeled_kind` diagnostic once per kind as `unmodeled_kind_strict` error (`packages/pg-prime-kit/src/diff/diff.ts:186-203`).

## Gotchas
- Only payload content hashes are compared; edges and `ordinal` never produce a delta, so `isEmptyDiff` means "no fact payload differs" (`packages/pg-prime-kit/src/diff/diff.ts:129`, `packages/pg-prime-kit/src/diff/diff.ts:217-218`).
- Enum labels never produce `drop`/`alter`; removal or reorder is only `EN102` (`packages/pg-prime-kit/src/diff/diff.ts:151-157`), and labels of a newly created type ride on `CREATE TYPE` (`packages/pg-prime-kit/src/diff/diff.ts:145`).
- An adopted partition is skipped on both sides so the shadow proof does not report it as residual drift (`packages/pg-prime-kit/src/diff/diff.ts:75-84`); the same holds for retained extensions (`packages/pg-prime-kit/src/diff/diff.ts:102-109`).
- The partition test is `partitionOf === null`, so a payload missing the key (`undefined`) is treated as a partition (`packages/pg-prime-kit/src/diff/diff.ts:87`); `packages/pg-prime-kit/src/diff/ddl.ts:1154` guards the same field with `isPartitioned`.
- The delta sort is by kind rank and id, not dependency order; `diff/order.ts` does real ordering on the emitted statements.
- `strictUnmodeled` never inspects the IR: without `options.diagnostics` it adds nothing (`packages/pg-prime-kit/src/diff/diff.ts:188`).
- Error diagnostics (`EN102`, `unmodeled_kind_strict`) become unacknowledged hazards in `buildPlan` (`packages/pg-prime-kit/src/plan/plan.ts:290-300`), which `writePlan` refuses.

## Tests
- `packages/pg-prime-kit/test/enum.test.ts` (label append ordering, `addEnumValue` anchors, label renames), `test/evolve.test.ts` (two populated catalogs), `test/kinds/partition.test.ts` (adopted partitions), `test/kinds/extension.test.ts` (never dropped), `test/kinds/observation.test.ts` (`strictUnmodeled` escalation, Tier R left alone), `test/schema.test.ts`, `test/roundtrip.test.ts`, plus the fixture sweep in `test/corpus.test.ts`.
- All of these need a server (`PG_PRIME_TEST_URL`, see `test/support/db.ts`); they fail rather than skip without one.
- Run: `pnpm --filter @pg-prime/kit exec vitest run test/enum.test.ts test/kinds/partition.test.ts`.
- Uncovered: the `undefined` `partitionOf` case and the delta sort order have no dedicated assertion.

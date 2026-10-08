# packages/pg-prime-kit/src/diff/order.ts

## Purpose
Dependency-orders the unordered `Statement[]` from `buildStatements` (`diff/ddl.ts`), cuts it into transaction segments, and optionally splits it into per-stage files. `orderStatements` is called by `generateFromDatabases` in `generate.ts`, `checkpoint/checkpoint.ts`, `prove/*`, `cli/commands/baseline.ts`; `splitStages` by `generate()` in `generate.ts`. `Segment` is consumed by `plan/plan.ts` and `runner/{apply,files,run}.ts`.

## Public API
- `Segment` — `{ index, transactional, statements: number[] }`; statement indexes into the ordered list. Exported from the package as `Segment` (the lexer's is `SqlSegment`).
- `OrderResult` — `{ statements, segments, diagnostics }`.
- `orderStatements(input): OrderResult` — topological sort plus segmentation; reports `dependency_cycle` and `EN101` as error diagnostics, never throws.
- `StagedFile` — `{ stage, statements, segments }`, one emitted file.
- `StagedResult` — `{ files, diagnostics, declined }`; `declined` is a reason string when the concurrent split is refused, else `null`.
- `splitStages(input): StagedResult` — order once across stages, then one re-ordered file per non-empty stage.

## Flow
1. Index statements by every id in `produces`, `consumes`, `destroys`, `releases` (`packages/pg-prime-kit/src/diff/order.ts:27-41`).
2. Add edges: producer → consumer, consumer → destroyer, releaser → destroyer, destroyer → producer (`packages/pg-prime-kit/src/diff/order.ts:59-62`).
3. Kahn's algorithm with ties broken by `(phase, input index)` (`packages/pg-prime-kit/src/diff/order.ts:66-80`).
4. On a cycle, emit `dependency_cycle` and append the stuck statements, then re-sort the whole order by `(phase, index)` (`packages/pg-prime-kit/src/diff/order.ts:81-90`).
5. Segment: consecutive transactional statements share a segment; a `nonTransactional` statement gets its own; a `commitBoundaryAfter` statement closes its segment (`packages/pg-prime-kit/src/diff/order.ts:95-109`).
6. `EN101`: any statement consuming an id produced by a `commitBoundaryAfter` statement in the same or a later segment (`packages/pg-prime-kit/src/diff/order.ts:112-131`).
7. `splitStages` with no staged statement returns one `main` file from `orderStatements` (`packages/pg-prime-kit/src/diff/order.ts:175-183`).
8. Otherwise offset `phase` by 1000 per stage rank (`main` 0, `concurrent` 1, `data` 2) and sort globally (`packages/pg-prime-kit/src/diff/order.ts:185-186`).
9. If the global order ever moves to a lower stage rank, return no files and a `declined` reason (`packages/pg-prime-kit/src/diff/order.ts:188-201`).
10. Re-run `orderStatements` per stage, merging diagnostics deduplicated by `code|message` (`packages/pg-prime-kit/src/diff/order.ts:203-217`).

## Gotchas
- `phase` only breaks ties; correctness depends on emitters filling the four id lists (`packages/pg-prime-kit/src/diff/order.ts:16-22`).
- The cycle fallback re-sorts everything by phase (`packages/pg-prime-kit/src/diff/order.ts:89`), discarding the partial topological order already found.
- A segment index refers to positions in the ORDERED `statements`, not the input.
- On decline, `files` is empty; `packages/pg-prime-kit/src/generate.ts:264-277` rebuilds with `multiFile: false` and calls `splitStages` again.
- Re-ordering a stage on its own drops cross-stage edges; that is safe only because the global pass already proved stage order is monotone (`packages/pg-prime-kit/src/diff/order.ts:170-172`).
- `order.includes` in the cycle path is quadratic (`packages/pg-prime-kit/src/diff/order.ts:82`, `packages/pg-prime-kit/src/diff/order.ts:88`); fine for plan-sized input.

## Tests
- `packages/pg-prime-kit/test/generate/stages.test.ts` — `splitStages`: unstaged passthrough, main/concurrent cut, decline when a transactional statement must follow a concurrent one (unit cases; the file also has a live `generate` case).
- `test/enum.test.ts` — `ADD VALUE` ordered before every use of the new label, segment boundary (live).
- `test/ddl.test.ts` "ordering, end to end", `test/kinds/partition.test.ts`, `test/kinds/not-null-validity.test.ts`, `test/schema-emit/roundtrip.test.ts` (live).
- Run: `pnpm --filter @pg-prime/kit exec vitest run test/generate/stages.test.ts test/enum.test.ts`; live cases need `PG_PRIME_TEST_URL`.
- Uncovered: the `dependency_cycle` fallback is never exercised; `EN101` is only asserted absent (`packages/pg-prime-kit/test/enum.test.ts:102`), never raised.

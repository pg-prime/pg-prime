# packages/pg-prime-kit/src/diff/candidates.ts

## Purpose
Turns drop/create pairs that look like renames into questions (`RenameCandidate`), never into renames. `generate()` in `packages/pg-prime-kit/src/generate.ts:243` calls `renameCandidates` after `diffIR`; `unresolvedDecisions` (`packages/pg-prime-kit/src/generate.ts:705`) turns them into a `missing_hints` result (CLI exit 2), and `cli/commands/generate.ts` shows them under `--interactive`.

## Public API
- `RenameConfidence` — `"unambiguous" | "ambiguous" | "nearMiss"`.
- `RenameCandidate` — `{ kind, from, to, confidence, alternatives, reason }`; `from`/`to` are encoded ids (current-only / desired-only), `alternatives` the other equally good ids.
- `renameCandidates(diff, desired): RenameCandidate[]` — the candidates, sorted by `from`; `[]` when there are no drops or no creates.

## Flow
1. Collect `drop` and `create` deltas of the renameable kinds `column`, `table`, `type`, `schema` (`packages/pg-prime-kit/src/diff/candidates.ts:51`, `packages/pg-prime-kit/src/diff/candidates.ts:168-186`).
2. For each side compute its container (`containerOf`: table for a column, schema for a table/type, `"cluster"` otherwise, `packages/pg-prime-kit/src/diff/candidates.ts:61-71`) and `shapeHash` against `diff.current` or `desired` (`packages/pg-prime-kit/src/diff/candidates.ts:83-114`).
3. Mark dropped tables whose schema also gained a table; their columns are excluded from both sides (`packages/pg-prime-kit/src/diff/candidates.ts:192-199`).
4. For each eligible drop, the pool is eligible creates of the same kind and container (`packages/pg-prime-kit/src/diff/candidates.ts:203`).
5. Exactly one equal hash → `unambiguous` if that create also has exactly one equal-hash drop, else `ambiguous` with the other drops as alternatives (`packages/pg-prime-kit/src/diff/candidates.ts:206-226`).
6. Several equal hashes → `ambiguous`, first as `to`, rest as alternatives (`packages/pg-prime-kit/src/diff/candidates.ts:228-237`).
7. No equal hash → `nearMiss` for creates whose names are similar (`packages/pg-prime-kit/src/diff/candidates.ts:239-251`).
8. Sort by `from` (`packages/pg-prime-kit/src/diff/candidates.ts:253`).

## Gotchas
- Nothing here is applied; only an annotation (`renamedFrom`, hints file) renames. A candidate is a prompt.
- `diff.current` already has accepted hints folded in, so annotated renames never reappear as candidates (`packages/pg-prime-kit/src/diff/candidates.ts:157-163`).
- `shapeHash` is not `rollupOf`: a table hashes its own payload plus `name=contentHash` of its columns, a type its labels in ordinal order, a schema its tables' shape hashes (`packages/pg-prime-kit/src/diff/candidates.ts:73-114`). Constraint and index names, which derive from the table name, are left out deliberately.
- Indexes and constraints are never candidates; `diff/rename.ts` cascades them from accepted renames.
- `similar` is case-insensitive containment or edit-distance similarity ≥ 0.6 (`packages/pg-prime-kit/src/diff/candidates.ts:140-147`); thresholds only bound noise, since a near miss is never applied.
- Column exclusion triggers on any table created in the same schema, even an unrelated one (`packages/pg-prime-kit/src/diff/candidates.ts:195`).
- `ambiguous` from step 6 reports the first created id as `to`; the choice is order-dependent and meant only for display.

## Tests
- `packages/pg-prime-kit/test/cli/authoring.test.ts` — an unannotated column rename yields an `unambiguous` candidate and exit 2; adding `renamedFrom` resolves it (live, spawns the built CLI).
- CLI envelope goldens: `test/cli/golden/generate.missing-hints.json` and siblings.
- Run: `pnpm --filter @pg-prime/kit exec vitest run test/cli/authoring.test.ts` (needs `PG_PRIME_TEST_URL`; `globalSetup` builds `dist/`).
- Uncovered: no unit test for `ambiguous`/`nearMiss` verdicts, `shapeHash` of tables/types/schemas, or the moved-table column exclusion.

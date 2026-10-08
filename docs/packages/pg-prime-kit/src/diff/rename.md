# packages/pg-prime-kit/src/diff/rename.ts

## Purpose
Folds annotation rename hints into the current `SchemaIR` before diffing, so a rename becomes a `RENAME` statement instead of a drop and create. Also renames auto-named indexes, constraints and PG 18 NOT NULL names that PostgreSQL does not carry along. Called only by `diffIR` (`packages/pg-prime-kit/src/diff/diff.ts:60`); uses `lexSql` (`sql/statements.ts`), `defaultNotNullName` (`sql/ident.ts`) and `GENERATED_NAME` (`catalog/payloads.ts`).

## Public API
- `RenameApplication` — `{ ir, accepted, rejected }`: the rewritten current IR, `RenameRecord[]`, and `{ hint, reason }[]`.
- `applyRenameHints(current, desired, hints): RenameApplication` — applies hints in order; never throws for a bad hint (rejects it), but `parseId` throws on a malformed string id.
- `tokenizeDefinition(def)` — splits a stored definition into `{ ident }` and `{ text }` tokens via the lexer; quoted identifiers are unquoted, whitespace runs collapse to one space.
- `definitionsAgreeUnderRename(currentDef, desiredDef, renames): boolean` — token-wise equality where an identifier may differ only as `renames.get(old) === new`.

## Flow
1. For each hint, reject on kind mismatch, missing source on the current side, target already present on the current side, or target absent from desired (`packages/pg-prime-kit/src/diff/rename.ts:255-270`).
2. Record the name mapping: enum labels go to `labelRenames`, everything else to the identifier map `renames` (`packages/pg-prime-kit/src/diff/rename.ts:276-280`); remember affected tables (`packages/pg-prime-kit/src/diff/rename.ts:281-282`).
3. Rewrite fact ids, parents and edge endpoints with `remapId`, tracking each fact's original id in `originOf` (`packages/pg-prime-kit/src/diff/rename.ts:284-292`); push an `annotation` record (`packages/pg-prime-kit/src/diff/rename.ts:294-300`).
4. With nothing accepted, return the input IR unchanged (`packages/pg-prime-kit/src/diff/rename.ts:303`).
5. For every fact with a `definition`, adopt the desired side's text when it agrees under `renames` (`packages/pg-prime-kit/src/diff/rename.ts:306-314`).
6. For label renames, rewrite `'old'::type` constants in `definition`/`expression`/`default`, adopting only if the result equals the desired text exactly (`packages/pg-prime-kit/src/diff/rename.ts:317`, `packages/pg-prime-kit/src/diff/rename.ts:193-205`).
7. `cascadeRenames`: on affected tables, pair current-only and desired-only constraints/indexes whose payloads agree under `renames`, unique in both directions; rewrite their ids and push `cascade` records (`packages/pg-prime-kit/src/diff/rename.ts:320-346`, `packages/pg-prime-kit/src/diff/rename.ts:378-413`).
8. `cascadeNotNullRenames`: for columns on affected tables whose NOT NULL is `GENERATED_NAME` on both sides, emit a `cascade` constraint rename from the old default name to the new (`packages/pg-prime-kit/src/diff/rename.ts:349-357`, `packages/pg-prime-kit/src/diff/rename.ts:435-460`).
9. Rebuild with `SchemaIR.build` (`packages/pg-prime-kit/src/diff/rename.ts:359`).

## Gotchas
- Definitions are never rewritten textually; only the desired spelling is adopted when tokens agree, so string literals and CHECK bodies cannot be edited (`packages/pg-prime-kit/src/diff/rename.ts:35-54`).
- `renames` is keyed by bare name and step 5 runs over every id-matched definition, not only affected tables (`packages/pg-prime-kit/src/diff/rename.ts:279`, `packages/pg-prime-kit/src/diff/rename.ts:306-314`).
- `remapId` cascades a table rename only to `column` and `constraint` ids (`packages/pg-prime-kit/src/diff/rename.ts:23-31`). `default`, `comment`, `index`, `enumLabel` and `typeAttribute` ids keep their old spelling; defaults and comments then diff as create (re-emitted `SET DEFAULT` / `COMMENT ON`) plus a drop that `packages/pg-prime-kit/src/diff/ddl.ts:944` / `packages/pg-prime-kit/src/diff/ddl.ts:972` skips.
- Hints are checked against the progressively rewritten facts, but the target must already exist in desired, so a chain `a → b → c` cannot complete in one call (`packages/pg-prime-kit/src/diff/rename.ts:267`).
- The NOT NULL cascade record names the constraint on the NEW table, because the table `RENAME` in the same phase runs first (`packages/pg-prime-kit/src/diff/rename.ts:431-434`). Its `from` id is not a current fact; only the record is pushed.
- A label rename is never added to `renames`: labels are literals, and treating them as identifiers would make two literals interchangeable (`packages/pg-prime-kit/src/diff/rename.ts:274-276`).
- `cascadeRenames` requires the fact's `parent` to be the table (`packages/pg-prime-kit/src/diff/rename.ts:384-386`); `diff/ddl.ts` emits the resulting `RENAME CONSTRAINT` / `ALTER INDEX … RENAME TO` from `diff.renames`.

## Tests
- `packages/pg-prime-kit/test/rename.test.ts`: token agreement (bare vs quoted, literals never names, unrelated change still a change) as unit cases; live cases for dependent index/constraint renames instead of recreation and PG 18 NOT NULL name carry-over (the latter gated on `catalogsNotNullConstraints`).
- `test/enum.test.ts` covers label renames (`ALTER TYPE … RENAME VALUE`); `packages/pg-prime-kit/test/evolve.test.ts:166` asserts rejection reasons; `test/generate/annotations.test.ts` the hint firing rule.
- Run: `pnpm --filter @pg-prime/kit exec vitest run test/rename.test.ts`; live cases need `PG_PRIME_TEST_URL`.
- Uncovered: the re-emitted `SET DEFAULT` / `COMMENT ON` after a rename is not asserted either way.

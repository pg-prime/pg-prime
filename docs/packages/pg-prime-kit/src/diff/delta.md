# packages/pg-prime-kit/src/diff/delta.ts

## Purpose
Type-only vocabulary of the differ: the `Delta` union `diffIR` (`diff/diff.ts`) emits and `buildStatements` (`diff/ddl.ts`) consumes, plus the rename hint input and the rename record output. Also used by `diff/rename.ts`, `plan/plan.ts` (`RenameRecord` in a plan), `generate.ts`, `prove/temp-schema.ts` and `cli/commands/generate.ts`.

## Public API
- `Delta` — discriminated on `op`: `create { id, fact }`, `drop { id, fact }`, `alter { id, before, after }`, `rename { from, to, fact }`, `addEnumValue { id, anchor }`.
- `addEnumValue.anchor` — `{ position: "BEFORE" | "AFTER", label }` or `null`; the label's ordering anchor for `ALTER TYPE … ADD VALUE`.
- `RenameHint` — `{ from, to }`, each a `StableId` or its encoded string; an input, never inferred.
- `RenameRecord` — `{ kind, from, to, source: "annotation" | "cascade", confidence: "unambiguous" }`, ids encoded.

## Flow
1. Callers build `RenameHint[]` from `renamedFrom` annotations and hints files (`generate.ts` via `acceptHints`) and pass them to `diffIR`.
2. `applyRenameHints` turns accepted hints into `RenameRecord`s with `source: "annotation"`, and auto-named dependents it renames alongside into `source: "cascade"` (`packages/pg-prime-kit/src/diff/rename.ts:294-357`).
3. `diffIR` emits `create`/`alter`/`drop` and `addEnumValue` deltas (`packages/pg-prime-kit/src/diff/diff.ts:125-174`).
4. `buildStatements` switches on `op` (`packages/pg-prime-kit/src/diff/ddl.ts:405-1091`); `buildPlan` stores the records as `plan.renames`.

## Gotchas
- `diffIR` never emits `op: "rename"`; renames travel in `DiffResult.renames`, and `buildStatements` ignores a rename delta (`packages/pg-prime-kit/src/diff/ddl.ts:1089-1090`). Consumers still branch on it when printing ids (`packages/pg-prime-kit/src/diff/diff.ts:177-181`, `packages/pg-prime-kit/src/prove/prove.ts:221`).
- `cascade` is not inference: it covers auto-named constraints, indexes and PG 18 NOT NULL names matched or computed from an accepted annotation (`packages/pg-prime-kit/src/diff/delta.ts:26-31`).
- `confidence` is always `"unambiguous"`; uncertain pairings live in `diff/candidates.ts` as `RenameCandidate`, not here.

## Tests
- No dedicated spec; the types are exercised through `test/rename.test.ts`, `test/enum.test.ts` and `test/generate/annotations.test.ts`.
- Run: `pnpm --filter @pg-prime/kit exec vitest run test/rename.test.ts test/enum.test.ts` (needs a server via `PG_PRIME_TEST_URL`, see `test/support/db.ts`).
- Uncovered: nothing type-level is asserted directly.

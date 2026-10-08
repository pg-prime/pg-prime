# packages/pg-prime/src/query/ops.manifest.ts

## Purpose
The operator vocabulary as data: one `OpSpec` row per exported operator or `fn.*` member, with the
SQL shape it emits and its claimed result codec. It has no imports and no implementation. Re-exported
by `packages/pg-prime/src/query/types.ts:1712` (not by the public barrel `packages/pg-prime/src/index.ts`)
and consumed by the golden, OID-differential, semantic-differential and docs-table tests.

## Public API
- `OpClass` — union of row classes: `'all' | 'text' | 'array' | 'jsonb' | 'numeric' | 'tsvector' |
  'range' | 'net' | 'vector' | 'boolean' | 'aggregate'`.
- `OpSpec` — `{ name, class, sql, result, kind: 'expr' | 'order', deferred? }`; `name` is the export
  name (`fn.`-prefixed for the aggregate namespace); `result` is a codec name or a rule string.
- `OPS: readonly OpSpec[]` — every operator row, grouped by class
  (`packages/pg-prime/src/query/ops.manifest.ts:52`).
- `CONFIRMABLE: readonly OpSpec[]` — `OPS` rows with `kind === 'expr'` and no `deferred`; the rows
  whose result OID the live suite checks (`packages/pg-prime/src/query/ops.manifest.ts:285`).

## Flow
1. A maintainer adds an operator to `packages/pg-prime/src/query/ops.ts` or `fn.ts` and a row to `OPS`.
2. `packages/pg-prime/test/query/ops.test.ts` asserts the set of `OPS` names equals the set of
   golden `CASES` keys, then checks each golden's SQL and binds.
3. `packages/pg-prime/test/live-query/ops.test.ts` runs `select <expr>` for every `CONFIRMABLE` row
   and compares the result OID with the claimed codec, then compares each row's builder predicate
   with a hand-written SQL oracle on the seeded fixture.
4. `packages/pg-prime/test/query/ops-table.test.ts` renders `OPS` into the markdown table between the
   `ops-table` markers in `design/03-query-builder.md` and fails on any difference.

## Gotchas
- `fn.rank` is the only `deferred` row (`packages/pg-prime/src/query/ops.manifest.ts:227`), so it is
  excluded from `CONFIRMABLE`; the live suite confirms it separately via `rank() over ()`
  (`packages/pg-prime/test/live-query/ops.test.ts:952`). `test/query/ops.test.ts` pins that
  `fn.rank` stays the sole deferred row.
- `fn.denseRank`, `fn.rowNumber` and `fn.now` exist on `fn` (`packages/pg-prime/src/query/fn.ts:243`,
  `:246`, `:249`) but have no manifest rows, so none of the four consumers covers them (they are
  exercised in `packages/pg-prime/test/live-query/setop-window.test.ts` and `writes.test.ts`).
- `asc`/`desc` are `kind: 'order'` with result `'—'`; they get shape goldens only.
- `isTrue`/`isNotTrue`/`isFalse`/`isNotFalse` are filed under `boolean`, not `all`, although they
  are defined in `packages/pg-prime/src/query/ops.ts`.
- The six vector rows are `kind: 'expr'` with no `deferred`; on PGlite (no pgvector) the live suite
  skips them, and the real check runs in `packages/pg-prime/test/pg/vector.test.ts`.
- The `sql` strings are documentation shapes (`a`, `$n`, `·` alternatives), not the emitted text;
  the exact text lives in the goldens.
- Editing a row changes `design/03-query-builder.md`'s generated table; regenerate with
  `PG_PRIME_UPDATE_DOCS=1 pnpm test -- ops-table`.

## Tests
- `packages/pg-prime/test/query/ops.test.ts` — manifest/golden parity, the sole-deferred check, the
  vector rows being confirmable. Run `pnpm --filter pg-prime exec vitest run test/query/ops.test.ts`.
- `packages/pg-prime/test/query/ops-table.test.ts` — the generated table in
  `design/03-query-builder.md` equals the render of `OPS`; unique names and known classes. Run
  `pnpm --filter pg-prime exec vitest run test/query/ops-table.test.ts`.
- `packages/pg-prime/test/live-query/ops.test.ts` — OID and semantic differentials over
  `CONFIRMABLE` (PGlite by default). Run
  `pnpm --filter pg-prime exec vitest run test/live-query/ops.test.ts`.
- Uncovered by the manifest gates: `fn.denseRank`, `fn.rowNumber`, `fn.now` (no OID differential).

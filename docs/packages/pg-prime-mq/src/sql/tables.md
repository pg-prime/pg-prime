# packages/pg-prime-mq/src/sql/tables.ts

## Purpose
Identifiers, the statement runner and the CTE assembly every statement module uses, plus the
`[watch]` and wake fragments.

## Public API
- Internal: `tables(schema, notify?)` → `Tables`; `run`, `one` (labelled `mq.<op>`); `ms(n)`; `raw(s)`;
  `withCtes(ctes, tail, recursive?)`; `Cte`; `cols(alias)`; `watchCte`; `wakeCte`.

## Flow
1. `withCtes` joins the CTEs and references every SELECT CTE from the final select (packages/pg-prime-mq/src/sql/tables.ts:64).
2. `watchCte` notifies `{ id, s }` for rows whose queue has `watch` set; `wakeCte` one wake per queue.

## Gotchas
- An unreferenced SELECT CTE never runs: that is why `withCtes` adds `(select count(*) from …)`.
- `raw` memoizes `sql.unsafeRaw`, whose caller capture cost about 3 ms per claim.
- Channel names are computed in SQL by events' `engineChannelSql`, equal to `engineChannel`.

## Tests
- `test/unit/sql.test.ts` (goldens, references, same-row writers). `pnpm --filter @pg-prime/mq test`.

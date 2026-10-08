---
'pg-prime': minor
---

Row counts and optimistic locking for `update` and `delete`.

- `executeRowCount()` resolves with the command tag's row count (`UPDATE n` / `DELETE n`), with or
  without `RETURNING`.
- `.ifVersion((t) => t.blocks.rev, 7)` ANDs `rev = $n` into the `WHERE` and throws the new
  `VersionConflictError` (`code: 'VERSION_CONFLICT'`, `table`, and `expected` under
  `errors.includeParams`) when no row matched — from `execute()`, `executeTakeFirst()`,
  `executeRowCount()`, `db.run(q)`, `db.run(q.compile())` and `prepare().execute()` alike, so inside
  `db.transaction()` a conflict rolls the batch back. You still write the bump (`rev: add(t.blocks.rev, 1)`)
  and still need `.where()` or `.allRows()`. `stream()`, `streamBatches()`,
  `explain({ analyze: true, rollback: false })`, CTE bodies and `fromValues` refuse an `.ifVersion()`
  statement.

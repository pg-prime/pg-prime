---
'pg-prime': patch
---

Bulk insert, prepared queries and `db.sql` hardening:

- `valuesMany` with the `values` strategy now caps each chunk so `rows × columns` (plus any binds in `ON CONFLICT`/`RETURNING`) stays under the 65 535-parameter wire ceiling. A wide table — or one with an array column, where `unnest` is unavailable — chunks below 5 000 rows instead of failing with `TooManyParametersError`.
- `PreparedQuery.execute()` refuses an `undefined` placeholder value the same way it refuses a missing key, instead of binding SQL NULL and silently matching nothing. `null` still binds NULL.
- `onConflict().doUpdate()` throws when the patch leaves nothing to set (every key `undefined`) instead of compiling to invalid `do update set` SQL; use `doNothing()`.
- `` db.sql`…` `` refuses a `placeholder()` at the tag instead of binding it as NULL.
- Insert rows are snapshotted at `.values()`/`.valuesMany()` time; mutating the row object afterwards no longer changes what is inserted.
- `InsertQuery.toSQL()` and `.explain()` no longer throw on a chunked batch; they describe its first chunk (`compileAll()` has the rest).
- Relation `some()`/`none()` evaluate a declared `where` once per use rather than twice.

---
'pg-prime': minor
---

**Views and materialized views as typed read-only entities** — design/01 §3 row 58.

`pgView('active_users').columns((t) => ({ id: t.bigint(), email: t.text() })).as(sql`…`)` declares a
view; `.existing()` declares one the database already has and you do not manage;
`pgMaterializedView(...)` adds `.withNoData()` and `.refreshable({ concurrently })`. Options are
`.with({ securityInvoker, securityBarrier, checkOption })` — **`securityInvoker` is `true` by
default**, so a view reads with the caller's privileges and RLS policies unless the declaration
deliberately says otherwise — plus `.comment()`, `.renamedFrom()` and `.dependsOn(…)`.

The declared columns are the entity's type. `db.from(activeUsers)` is a FROM source with exact
column types, exact codecs and the full operator vocabulary, and it joins a table in either
direction — a subquery or a CTE cannot do that, because neither carries a declared PostgreSQL type
per column. The value a builder returns **is** a handle, so there is no `db.h.activeUsers` and a
view does not go into `defineSchema(...)`: a view has no relations for the registry to add and no
insert shape to offer.

`insertInto(view)`, `update(view)` and `deleteFrom(view)` are compile errors, and the diagnostic is
one line that names the view and says what to do instead:

```
Property 'values' does not exist on type 'OrmTypeError<"insertInto() takes a table:
  \"active_users\" is a view and is read-only — write to the table it selects from, or add an
  INSTEAD OF trigger through the sql/ lane">'.
```

`db.refreshMaterializedView(mv, { concurrently? })` is on every handle, next to `copyFrom` and for
the same reason: `REFRESH MATERIALIZED VIEW` is transaction-safe (`CONCURRENTLY` included), so the
common shape is a refresh inside the transaction that also writes the audit row. It goes through the
statement path, so it appears in the query log with the exact text that reached the server, and
`concurrently` without the unique index PostgreSQL requires is the server's `55000`, mapped and
rethrown — never a quiet downgrade to a blocking refresh.

Not built, deliberately: `pgView('v').as((q) => …)` with columns inferred from a builder query, and
structured diffing of a view definition. A view body is a hashed repeatable in the `sql/` lane in
v1 — that is design/01 §3's lane decision, and it is why pg-prime has no phantom view diffs.

Pre-alpha, and the API will change: this is `0.x`, breaking changes land in a minor and never in a
patch.

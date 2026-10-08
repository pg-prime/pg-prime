---
'pg-prime': minor
---

**Typed row-level security policies, setting keys and an `updated_at` trigger.**

- `definePolicy(name, { on, for, as, to, using, withCheck })` declares a `CREATE POLICY`. The
  predicates are thunks over the table's columns, typed like query predicates. Every column renders
  qualified by its table name, so a subquery cannot capture it, and values render as typed literals.
  `@pg-prime/kit` writes declared policies into the `sql/` repeatable lane.
- `rls.enable()` / `rls.force()` table extras turn row-level security on, and `force` applies it to
  the table owner too.
- `updatedAtTrigger(t.updatedAt)` asks for a `BEFORE UPDATE` trigger that sets the column to `now()`.
- `setting(name, codec?)` returns a `SettingKey`: `.set(value)` gives the record for
  `tx.setLocal(...)`, and `.current()` is the SQL expression
  `nullif(current_setting(name, true), '')::<type>`, typed `T | null`, usable in queries and policies.
- Binary operators now accept a nullable expression on the right, as they already did on the left:
  `eq(t.orgId, orgId.current())` compiles. The literal `null` is still refused.
- `inTransactionFrame(tx, fn)` runs `fn` under `tx`'s development guard frame, so a captured root
  `Db` throws `HandleMisuseError` when a transaction is held open across callbacks.

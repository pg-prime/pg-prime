---
'@pg-prime/kit': patch
---

- `migrate generate` writes the literal FOREIGN KEY or CHECK, with no `NOT VALID` + `VALIDATE` pair, on a table the same migration creates, and its `CREATE INDEX` no longer carries LK101. Such a table is empty and unseen, so the lock-safe forms only added noise.
- When only `sql/` repeatables changed, `migrate apply` prints `no migrations to apply.` and lists them under `repeatables applied:`. Before, it printed "nothing to do — the database is up to date." while applying them.

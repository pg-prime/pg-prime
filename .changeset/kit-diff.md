---
'@pg-prime/kit': patch
---

Diff and rewrite fixes in `migrate generate`:

- A table rename and a column rename on the same table in one migration are both applied; the column hint was silently rejected and the plan degraded to `DROP COLUMN` + `ADD COLUMN`. A hint the differ rejects is now a `rejected_hint` error instead of a silent drop.
- Renaming an enum, domain or schema no longer plans `ALTER COLUMN … TYPE` (MF105) for every column of that type, renaming a partitioned parent no longer DETACHes and re-ATTACHes its partitions, and a renamed table's sequences, defaults and comments follow it. Schema renames now cascade to everything in the schema instead of dropping and recreating it.
- A column type change drops the column's DEFAULT before the `ALTER TYPE` and sets it again after, so a default PostgreSQL cannot cast on its own (`text` → enum) no longer fails at apply.
- `serial` → identity conversions apply: `DROP DEFAULT` and the old sequence go before `ADD GENERATED … AS IDENTITY`, and a `setval` continues the numbering from the rows instead of restarting at 1.
- `DROP SEQUENCE` is a destructive change (new hazard `DS107`, error) and needs acknowledging; a renamed sequence is a rename candidate (`missing_hints`) instead of a silent drop + create.
- `ADD CONSTRAINT … FOREIGN KEY … NOT VALID` on a partitioned table, which PostgreSQL < 18 refuses, falls back to the literal `ADD CONSTRAINT` (with LK105/MF106) on those servers.
- Retyping a STORED generated column no longer emits `USING`, which PostgreSQL rejects.
- Domains over user types and composites with user-typed attributes are ordered by their dependencies instead of by name.
- PostgreSQL 18 virtual generated columns are emitted as `GENERATED ALWAYS AS (…) VIRTUAL`.

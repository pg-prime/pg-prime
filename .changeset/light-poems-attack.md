---
'pg-prime': minor
'@pg-prime/kit': minor
---

First release of the fixed `pg-prime` / `@pg-prime/kit` pair: a PostgreSQL-only, zero-dependency,
ESM-only TypeScript ORM — schema DSL, `sql` tag, typed query builder with relations, codec
registry and a structural driver seam — together with the migration engine behind the `pg-prime`
CLI, which diffs a live catalog against the schema you wrote, proves the plan on a shadow clone
and applies it under an advisory lock.

Pre-alpha, and the API will change: this is `0.x`, breaking changes land in a minor and never in a
patch, and the closed 1.0 checklist is `design/08-architecture.md` §6.2.

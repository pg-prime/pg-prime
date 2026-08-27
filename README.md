# pg-prime

A PostgreSQL-only, type-safe TypeScript ORM with first-class migrations and zero runtime dependencies.

> **Status: pre-alpha.** Design complete; four implementation spikes are green but not yet
> wired to each other, so nothing is installable. Current state, decisions and next steps:
> [`design/00-overview.md`](./design/00-overview.md).

## Why

Multi-database ORMs pay a dialect tax on every feature: the schema DSL stops at the lowest common denominator, the migration engine can't use Postgres superpowers (transactional DDL, `CREATE INDEX CONCURRENTLY`, RLS), and type decoding is inconsistent across drivers. pg-prime targets exactly one database and manages the *entire* PostgreSQL DDL surface — tables, triggers, functions, domains, composite types, partitions, exclusion constraints, RLS policies — with an operations-grade migration engine and end-to-end owned type codecs.

**Design** — [`design/`](./design/), maintained; start at [`00-overview.md`](./design/00-overview.md).
**Research** — [`research/`](./research/), a historical 2026-08-14 snapshot kept as provenance.

## Packages

| Package | Purpose |
|---|---|
| `pg-prime` | Runtime: schema DSL, codecs, query builder, executor, migration applier. Zero deps, zero peer deps. |
| `@pg-prime/kit` | CLI: diff engine, migration generation, lint, verify. |
| `@pg-prime/testing` | Test helpers (PGlite tier, container matrix). |
| `create-pg-prime` | Project scaffolder (`npm create pg-prime`). |

## License

[MPL-2.0](./LICENSE) — modifications to pg-prime's files must stay open source; applications using pg-prime are unaffected.

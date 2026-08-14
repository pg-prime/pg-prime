# pgorm

A PostgreSQL-only, type-safe TypeScript ORM with first-class migrations and zero runtime dependencies.

> **Status: pre-alpha.** Design phase complete; implementation spikes in progress. Nothing here is usable yet.

## Why

Multi-database ORMs pay a dialect tax on every feature: the schema DSL stops at the lowest common denominator, the migration engine can't use Postgres superpowers (transactional DDL, `CREATE INDEX CONCURRENTLY`, RLS), and type decoding is inconsistent across drivers. pgorm targets exactly one database and manages the *entire* PostgreSQL DDL surface — tables, triggers, functions, domains, composite types, partitions, exclusion constraints, RLS policies — with an operations-grade migration engine and end-to-end owned type codecs.

Full research and design records: [`research/`](./research/) and [`design/`](./design/) (start with `design/00-overview.md`).

## Packages

| Package | Purpose |
|---|---|
| `pgormjs` | Runtime: schema DSL, codecs, query builder, executor, migration applier. Zero deps, zero peer deps. |
| `@pgorm/kit` | CLI: diff engine, migration generation, lint, verify. |
| `@pgorm/testing` | Test helpers (PGlite tier, container matrix). |
| `create-pgormjs` | Project scaffolder (`npm create pgormjs`). |

## License

[MPL-2.0](./LICENSE) — modifications to pgorm's files must stay open source; applications using pgorm are unaffected.

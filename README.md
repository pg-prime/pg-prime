# pg-prime

A PostgreSQL-only, type-safe TypeScript ORM with first-class migrations and zero runtime dependencies.

> **Status: pre-alpha.** `pg-prime` and `@pg-prime/kit` build (unbundled ESM + `.d.ts`), pass
> `publint --strict` and `attw --profile esm-only`, and install from a `pnpm pack` tarball into a
> fresh project — a consumer can import them, type-check on TypeScript 5.9, and run. Both are still
> at `0.0.0` and **not published to npm**, and the API will change. Current state, decisions and
> next steps: [`design/00-overview.md`](./design/00-overview.md).

## Why

Multi-database ORMs pay a dialect tax on every feature: the schema DSL stops at the lowest common denominator, the migration engine can't use Postgres superpowers (transactional DDL, `CREATE INDEX CONCURRENTLY`, RLS), and type decoding is inconsistent across drivers. pg-prime targets exactly one database and manages the *entire* PostgreSQL DDL surface — tables, triggers, functions, domains, composite types, partitions, exclusion constraints, RLS policies — with an operations-grade migration engine and end-to-end owned type codecs.

**Design** — [`design/`](./design/), maintained; start at [`00-overview.md`](./design/00-overview.md).
**Research** — [`research/`](./research/), a historical 2026-08-14 snapshot kept as provenance.

## Packages

| Package | Purpose |
|---|---|
| `pg-prime` | Runtime: schema DSL, codecs, query builder, executor, migration applier. Zero deps, zero peer deps. |
| `@pg-prime/kit` | Migration engine: catalog diffing, plan generation, prove-on-shadow-clone, apply. Programmatic API today; the CLI is not written yet. |
| `@pg-prime/testing` | Test helpers (PGlite tier, container matrix). |
| `@pg-prime/create` | Project scaffolder (`npm create @pg-prime`). |

## License

[MPL-2.0](./LICENSE) — modifications to pg-prime's files must stay open source; applications using pg-prime are unaffected.

# pg-prime

A PostgreSQL-only, type-safe TypeScript ORM with first-class migrations and zero runtime dependencies.

> **Status: pre-alpha.** The **migration loop is closed**: `pg-prime migrate generate → apply →
> status → check → verify` runs from a `pg-prime.config.ts` against PostgreSQL 15–18, needs no
> `CREATEDB`, refuses a transaction-mode pooler, writes nothing until the plan has been proved on a
> shadow clone, and is green on Pagila, Northwind, AdventureWorks and Chinook. The query builder is
> still a spike. Both packages build (unbundled ESM + `.d.ts`), pass `publint --strict` and
> `attw --profile esm-only`, and install from a `pnpm pack` tarball into a fresh project. Both are
> still at `0.0.0` and **not published to npm**, and the API will change. Current state, decisions
> and next steps: [`design/00-overview.md`](./design/00-overview.md).

## Why

Multi-database ORMs pay a dialect tax on every feature: the schema DSL stops at the lowest common denominator, the migration engine can't use Postgres superpowers (transactional DDL, `CREATE INDEX CONCURRENTLY`, RLS), and type decoding is inconsistent across drivers. pg-prime targets exactly one database and manages the *entire* PostgreSQL DDL surface — tables, triggers, functions, domains, composite types, partitions, exclusion constraints, RLS policies — with an operations-grade migration engine and end-to-end owned type codecs.

**Design** — [`design/`](./design/), maintained; start at [`00-overview.md`](./design/00-overview.md).
**Research** — [`research/`](./research/), a historical 2026-08-14 snapshot kept as provenance.

## Packages

| Package | Purpose |
|---|---|
| `pg-prime` | Runtime: schema DSL, codecs, query builder, executor, migration applier. Zero deps, zero peer deps. |
| `@pg-prime/kit` | Migration engine and the `pg-prime` CLI: `migrate generate / apply / status / check / verify / lint / baseline / push --dev / doctor / unlock`. Catalog diffing, plan generation, prove-on-shadow-clone, `pg_dump` witness, apply. |
| `@pg-prime/testing` | Test helpers (PGlite tier, container matrix). |
| `@pg-prime/create` | Project scaffolder (`npm create @pg-prime`). |

## License

[MPL-2.0](./LICENSE) — modifications to pg-prime's files must stay open source; applications using pg-prime are unaffected.

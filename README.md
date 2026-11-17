# pg-prime

A PostgreSQL-only, type-safe TypeScript ORM with first-class migrations and zero runtime dependencies.

> **Status: 0.2.6, pre-1.0.** The API will still change; breaking changes land in a minor.
> `pg-prime migrate generate → apply → status → check → verify` runs from a `pg-prime.config.ts`
> against PostgreSQL 15–18, needs no `CREATEDB`, refuses a transaction-mode pooler, proves every plan
> on a shadow clone witnessed by `pg_dump`, and is green on Pagila, Northwind, AdventureWorks and
> Chinook. The query builder, the `Db`/`Tx`/`Session` runtime and six add-ons (events, outbox, mq,
> cron, context, nestjs) are built and published. Known open defects and the route to 1.0:
> [`design/21-review-2026-11-17.md`](./design/21-review-2026-11-17.md). Current state and decisions:
> [`design/00-overview.md`](./design/00-overview.md).

## Why

Multi-database ORMs pay a dialect tax on every feature: the schema DSL stops at the lowest common denominator, the migration engine can't use Postgres superpowers (transactional DDL, `CREATE INDEX CONCURRENTLY`, RLS), and type decoding is inconsistent across drivers. pg-prime targets exactly one database and manages the *entire* PostgreSQL DDL surface — tables, triggers, functions, domains, composite types, partitions, exclusion constraints, RLS policies — with an operations-grade migration engine and end-to-end owned type codecs.

**Documentation** — the site in [`docs/`](./docs/) (Astro Starlight): a fifteen-minute getting
started, the concepts, guides for the schema DSL, queries, transactions and migrations, an
operations manual (locks, poolers, zero-downtime, CI/CD) and a hand-written API reference covering
every public export. Every code block on it is compiled on TypeScript 5.9.3 against the built
packages and every example is executed against a real PostgreSQL in CI (`pnpm docs:check`).
Published to GitHub Pages from `main`.
**Design** — [`design/`](./design/), maintained; start at [`00-overview.md`](./design/00-overview.md).
**Research** — [`research/`](./research/), a historical 2026-08-14 snapshot kept as provenance.

## Packages

| Package | Purpose |
|---|---|
| `pg-prime` | Runtime: schema DSL, codecs, query builder, the `Db`/`Tx`/`Session` handles, executor. Zero runtime dependencies; `pg` is an **optional** peer, resolved lazily and only by the `connection:` form (`pool:` and `driver:` need nothing). |
| `@pg-prime/kit` | Migration engine and the `pg-prime` CLI: `migrate generate / apply / status / check / verify / lint / baseline / push --dev / doctor / unlock / checkpoint`, `db seed`, `pull`. Catalog diffing, plan generation, prove-on-shadow-clone, `pg_dump` witness, apply. |
| `@pg-prime/testing` | Test helpers: PGlite, containers, scratch databases, a mock pool, `rollbackScope`. |
| `@pg-prime/create` | Project scaffolder (`npm create @pg-prime`). |
| `@pg-prime/events` | Typed channels, a durable event log with cursors, pub/sub. |
| `@pg-prime/outbox` | Transactional outbox with an ordered relay to external sinks. |
| `@pg-prime/mq` | Work queues: leases, retry with backoff, FIFO per group, LISTEN wake-up. |
| `@pg-prime/cron` | Scheduled jobs on mq, with the database as the only coordinator. |
| `@pg-prime/context` | Ambient transactions (`TransactionHost`) over `AsyncLocalStorage`. |
| `@pg-prime/nestjs` | Nest module for `pg-prime` and `@pg-prime/context`. |

## License

[MPL-2.0](./LICENSE) — modifications to pg-prime's files must stay open source; applications using pg-prime are unaffected.

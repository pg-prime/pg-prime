# @pg-prime/testing

Test helpers for [pg-prime](https://www.npmjs.com/package/pg-prime): a recording pool mock, an
in-process PGlite server, real-PostgreSQL fixtures and skip guards.

> **Status: pre-alpha.** Published on npm; the API will change. Follow progress at
> <https://github.com/pg-prime/pg-prime>.

```
npm i -D @pg-prime/testing
```

| Tier | Exports |
|---|---|
| No database | `createMockPool()` — a `PgLikePool` for `pgPrime({ pool })` that records statements and replays scripted results; `expectSql(query, { text, values })` |
| PGlite | `startPglite()` — PostgreSQL 18 in the test process behind a real wire socket, TimeZone UTC, no Docker |
| Real server | `startPostgres()` — a container via `@testcontainers/postgresql`; `scratchDatabase(adminUrl)` — an empty database on a server you already run |
| Guards | `requiresRealPostgres(it, reason)`, `requiresConcurrency(it)` — skip loudly unless `PG_PRIME_TEST_URL` is set |

Nothing imports a test runner: it works under vitest, `bun test` and others. `pg-prime` is a required
peer; `@electric-sql/pglite` and `@testcontainers/postgresql` are optional peers, loaded only by the
fixture that needs them. The `connection:` form below also needs `pg`.

```ts
import { defineSchema, pgPrime } from 'pg-prime'
import { startPglite } from '@pg-prime/testing'

const server = await startPglite()
const db = pgPrime({ connection: server.url, schema: defineSchema({}), poolOptions: { max: 1 } })
const rows = await db.sql`select 1 as one`.execute()
await db.end()
await server.stop()
```

Full reference: <https://pg-prime.github.io/pg-prime/reference/testing/>.

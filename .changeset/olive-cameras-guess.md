---
'@pg-prime/testing': minor
---

First real release of `@pg-prime/testing`: the fixtures pg-prime's own suites are built out of,
extracted rather than written for the documentation. `createMockPool()` is a `PgLikePool`-shaped
double that records every statement and replays a script of result sets or duck-typed SQLSTATE
errors, so `pgPrime({ pool })` runs the compiler, the executor and the codecs with no I/O at all;
`expectSql(query, { text, values })` asserts compiled SQL through `compileOnly` and fails with a
unified diff. `startPglite()` boots a real PostgreSQL in the test process behind a real
wire-protocol socket, TZ pinned; `startPostgres()` starts a container and `scratchDatabase(adminUrl)`
carves an empty `pgprime_test_*` database out of a server you already run — and refuses to drop
anything it did not name. `requiresRealPostgres(it, reason)` and `requiresConcurrency(it)` skip
loudly, on stderr, when `PG_PRIME_TEST_URL` is unset.

Everything is runner-agnostic: the guards take your runner's own `it` and hand one back, and
nothing in the package imports a test runner. `pg-prime` is a required peer;
`@electric-sql/pglite` and `@testcontainers/postgresql` are optional peers, each imported lazily by
the one fixture that needs it and each failing with a sentence that names it.

Pre-alpha, and the API will change: this is `0.x`, breaking changes land in a minor and never in a
patch. `@pg-prime/testing` versions independently of the fixed `pg-prime` / `@pg-prime/kit` pair.

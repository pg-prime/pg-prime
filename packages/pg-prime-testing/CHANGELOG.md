# @pg-prime/testing

## 0.1.0

### Minor Changes

- [`0c6005c`](https://github.com/pg-prime/pg-prime/commit/0c6005c9611c8e776b2e97a9f06e56ad500576a0) Thanks [@YohoCX](https://github.com/YohoCX)! - First real release of `@pg-prime/testing`: the fixtures pg-prime's own suites are built out of,
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

### Patch Changes

- Updated dependencies [[`faf2f01`](https://github.com/pg-prime/pg-prime/commit/faf2f013fde077c2ff819c5d5ecbf61a7069e691), [`2655664`](https://github.com/pg-prime/pg-prime/commit/2655664ba433821176d790d4baf2608fb3f26fb3), [`21d2e66`](https://github.com/pg-prime/pg-prime/commit/21d2e66a332ffa47aba3fce5f8530706af673615), [`36dff23`](https://github.com/pg-prime/pg-prime/commit/36dff2302e3747dd1c6a46b96fcb20cfe37263a6), [`c530947`](https://github.com/pg-prime/pg-prime/commit/c530947c9c0317560bac4754119930ff7689e8e7)]:
  - pg-prime@0.1.0

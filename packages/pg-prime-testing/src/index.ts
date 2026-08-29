/**
 * `@pg-prime/testing` — the test helpers `pg-prime`'s own suites are built out of
 * (design/08 §1.1, §4.1–§4.3).
 *
 * One entry point, five modules, three tiers:
 *
 *   tier 0  {@link createMockPool}   a recording `PgLikePool`. No I/O, no database, no async.
 *           {@link expectSql}        the golden-string assertion for compiled SQL.
 *   tier 1  {@link startPglite}      a real PostgreSQL in-process, behind a real wire socket.
 *   tier 2  {@link startPostgres}    a container, through `@testcontainers/postgresql`.
 *           {@link scratchDatabase}  an empty database on a server you already have.
 *   any     {@link requiresRealPostgres} / {@link requiresConcurrency} — the loud skip.
 *
 * ## Dependencies
 *
 * `pg-prime` is a **required** peer: this package exists to test it. `@electric-sql/pglite` and
 * `@testcontainers/postgresql` are **optional** peers, imported lazily by the one fixture that
 * needs each, so a suite that only mocks the pool installs neither and a suite that never leaves
 * PGlite never pulls testcontainers.
 *
 * ## Runner-agnostic
 *
 * Nothing here imports vitest. The guards take the runner's own `it` and hand one back
 * ({@link TestDecl}), the fixtures are plain `async` functions, and `expectSql` throws an ordinary
 * `Error`. Every runner reports all three.
 */

export { createMockPool, DEFAULT_SERVER_PARAMETERS } from './mock-pool.js'
export type {
  MockError,
  MockField,
  MockPool,
  MockPoolOptions,
  MockQueryMode,
  MockResult,
  MockStep,
  RecordedQuery,
} from './mock-pool.js'

export { expectSql, normaliseSql } from './expect-sql.js'
export type { CompilableLike, CompiledLike, SqlExpectation } from './expect-sql.js'

export {
  onRealPostgres,
  requiresConcurrency,
  requiresRealPostgres,
  TEST_URL_ENV,
} from './guards.js'
export type { TestDecl } from './guards.js'

export { startPglite } from './pglite.js'
export type { PgliteServer, TestServer } from './pglite.js'

export { serve } from './pglite-bridge.js'
export type { PgliteBridge, PgliteLike } from './pglite-bridge.js'

export {
  databaseUrl,
  dockerAvailable,
  dropScratchDatabase,
  isScratchDatabase,
  probe,
  SCRATCH_PREFIX,
  scratchDatabase,
  scratchDatabaseName,
  startPostgres,
} from './postgres.js'
export type { PostgresServer, ScratchDatabase, StartPostgresOptions } from './postgres.js'

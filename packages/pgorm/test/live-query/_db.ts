/**
 * One live database per test file, wired to the *builder* rather than to the compiler
 * (design/09 WS4 tier 1).
 *
 * Three things it owns, and each exists because a test that did it itself would get it subtly
 * wrong:
 *
 *  - **The registry is resolved.** `role` is an enum, and an enum's OID is per-database, so
 *    `resolveDynamic` has to run before any statement compiles or the codec has no OID and
 *    `assertShape` has nothing to compare (`02` §4.6).
 *  - **`raw()` is a *separate* path to the data.** R1: a write verified by reading it back with
 *    the same builder proves only that the builder is self-consistent. `raw()` goes through the
 *    driver with hand-written SQL and hand-declared parsing, so it is an oracle and not an echo.
 *  - **Teardown drops the namespace**, so a file's failure cannot poison the next run (R6).
 */

import { Registry } from '../../src/codec/index.js'
import type { CodecRegistry } from '../../src/codec/index.js'
import type { PgConnection } from '../../src/driver/index.js'
import { pgOrm } from '../../src/query/run.js'
import type { Db } from '../../src/query/types.js'
import type { AnySchema } from '../../src/schema/index.js'
import { makeHarness, planProbe, type Harness } from '../live/_harness.js'
import { makeFixture, type Fixture } from '../live/fixture.js'

export interface LiveDb {
  readonly fx: Fixture
  readonly db: Db<Fixture['schema']>
  readonly registry: CodecRegistry
  readonly conn: PgConnection
  /**
   * A second `db` over a schema this file declares itself, sharing the resolved registry and the
   * pool. A test that needs a table the shared fixture must not carry (`03` §2.7's `staging` /
   * `live`) creates it with raw DDL and reaches it through here.
   */
  dbFor<S extends AnySchema>(schema: S): Db<S>
  /** Hand-written SQL, straight to the server. Values come back as raw text (or `null`). */
  raw(text: string, params?: readonly unknown[]): Promise<(string | null)[][]>
  end(): Promise<void>
}

export async function makeLiveDb(ns: string): Promise<LiveDb> {
  const fx = makeFixture(ns)
  const h: Harness = await makeHarness(2)
  const conn = await h.driver.acquire()

  await conn.execute({ text: fx.drop, params: [], mode: 'simple' })
  await conn.execute({ text: fx.ddl, params: [], mode: 'simple' })
  await conn.execute({ text: fx.seed, params: [], mode: 'simple' })

  const registry = new Registry()
  registry.setServerParameters(conn.serverParameters)
  await registry.resolveDynamic(conn, [
    { schema: ns, name: 'user_role', kind: 'enum', enumLabels: ['admin', 'owner', 'member'] },
  ])

  const db = pgOrm({ driver: h.driver, schema: fx.schema, registry })

  return {
    fx,
    db,
    registry,
    conn,
    dbFor: (schema) => pgOrm({ driver: h.driver, schema, registry }),
    async raw(text, params = []) {
      const r = await conn.execute({ text, params: params as never })
      return r.rows.map((row) => row.map((v) => (v === null ? null : String(v))))
    },
    async end() {
      await conn.execute({ text: fx.drop, params: [], mode: 'simple' }).catch(() => {})
      await h.driver.release(conn)
      await h.end()
    },
  }
}

/**
 * PostgreSQL's own answer to "would this statement plan?", without running it.
 *
 * `EXPLAIN (GENERIC_PLAN)` is 16+; below that `PREPARE`/`DEALLOCATE` is the equivalent check —
 * both force the parser, the analyser and the planner over the exact text and parameter types the
 * builder produced, which is the only way to catch SQL that is well-formed but not *valid*
 * (a `group by` that misses a column, a cast PostgreSQL will not make, an operator that does not
 * exist for those operand types).
 */
export async function assertPlans(
  live: LiveDb,
  sql: string,
  _paramTypes: readonly number[],
  major: number,
): Promise<void> {
  for (const stmt of planProbe(sql, major)) {
    await live.conn.execute({ text: stmt, params: [], mode: 'simple' })
  }
}

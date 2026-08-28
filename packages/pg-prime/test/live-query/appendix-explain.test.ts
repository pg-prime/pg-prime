/**
 * `EXPLAIN` over every `03` §2 example, against a real server (design/09 WS6).
 *
 * This is the strongest R1 oracle the executor has: the *planner* is asked to accept each of
 * Appendix A's statements, with the exact text and the exact parameter types the builder produced.
 * A statement that is syntactically well-formed but not *valid* — a cast PostgreSQL will not make,
 * an `ON CONFLICT` with no matching arbiter index, a `group by` that misses a column — fails here
 * and nowhere else, because compiling it and diffing the golden cannot notice.
 *
 * The list is `test/query/_appendix-a.ts`'s, shared with the tier-0 doc generator rather than
 * copied: two lists would be two things to keep in step, and the whole reason Appendix A is
 * generated is that it must not have a second source of truth.
 *
 * Nothing here uses `analyze`, so nothing here writes: `EXPLAIN` without it plans and stops.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Registry } from '../../src/codec/index.js'
import type { PgConnection } from '../../src/driver/index.js'
import { pgPrime } from '../../src/query/run.js'
import type { Db } from '../../src/query/types.js'
import { makeHarness, sqlState, type Harness } from '../live/_harness.js'
import { makeAppendixA } from '../query/_appendix-a.js'

const NS = 'pgprime_q_appendix'
const fx = makeAppendixA(NS)

let h: Harness
let conn: PgConnection
let db: Db<typeof fx.schema>

beforeAll(async () => {
  h = await makeHarness(2)
  conn = await h.driver.acquire()
  await conn.execute({ text: fx.drop(NS), params: [], mode: 'simple' })
  await conn.execute({ text: fx.ddl(NS), params: [], mode: 'simple' })

  // The enum's OID is per database (`02` §4.6), and this namespace declares its own `user_role`,
  // so it gets its own registry rather than sharing the fixture's.
  const registry = new Registry()
  registry.setServerParameters(conn.serverParameters)
  await registry.resolveDynamic(conn, [
    { schema: NS, name: 'user_role', kind: 'enum', enumLabels: ['admin', 'owner', 'member'] },
  ])
  db = pgPrime({ driver: h.driver, schema: fx.schema, registry })
}, 120_000)

afterAll(async () => {
  await conn?.execute({ text: fx.drop(NS), params: [], mode: 'simple' }).catch(() => {})
  if (conn) await h.driver.release(conn)
  await h?.end()
})

describe('every `03` §2 example plans on a real server', () => {
  it.each(fx.statements.map((s) => [s.label, s] as const))('%s', async (_label, entry) => {
    const built = entry.build(db) as unknown as {
      explain(o?: { format?: 'json' }): Promise<{ plan?: { 'Node Type': string }; text: string }>
    }
    const r = await built.explain()
    // A plan node with a type is PostgreSQL saying "I parsed, analysed and planned this".
    expect(typeof r.plan?.['Node Type']).toBe('string')
    expect(r.text.length).toBeGreaterThan(0)
  })

  it('R4 negative control: a statement PostgreSQL cannot plan fails here', async () => {
    // `EXPLAIN` really is doing the work — the same call over a relation that does not exist is
    // refused, so a green run above is a verdict and not a no-op.
    const missingRelation = await db.sql`select 1 from pgprime_no_such_table_zz`
      .explain()
      .catch((e: unknown) => e)
    expect(sqlState(missingRelation)).toBe('42P01')

    const missingColumn = await db.sql`select nonexistent_column_zz`
      .explain()
      .catch((e: unknown) => e)
    expect(sqlState(missingColumn)).toBe('42703')
  })
})

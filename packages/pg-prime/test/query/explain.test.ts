/**
 * `.explain()` and the `ANALYZE` safety rail (design/07 §7.5; design/09 WS6).
 *
 * Tier 0 owns two things here and only two: the **text we send** (which options, in which
 * spelling, with the query's own binds) and the **transaction shape** around it. Whether the plan
 * that comes back is a plan is PostgreSQL's business and is asserted at tier 1, over every one of
 * `03` §2's examples.
 *
 * The rail is the part worth a mock: `EXPLAIN ANALYZE UPDATE …` performs the update, and the only
 * way to see that we wrapped it is to watch the connection.
 */

import { describe, expect, it } from 'vitest'
import { pgPrime } from '../../src/query/run.js'
import * as q from '../../src/query/types.js'
import { mockDriver } from './_mock-driver.js'
import { schema } from './_schema.js'

/** What `EXPLAIN (FORMAT JSON)` sends back: one row, one column, a JSON array of one plan. */
const jsonPlan = (extra: Record<string, unknown> = {}): string[][] => [
  [
    JSON.stringify([
      {
        Plan: { 'Node Type': 'Seq Scan', 'Relation Name': 'users', 'Plan Rows': 10 },
        ...extra,
      },
    ]),
  ],
]

const kinds = (texts: readonly string[]): string[] =>
  texts.map((t) => t.split(' ').slice(0, 2).join(' '))

describe('what goes on the wire', () => {
  it('format json by default, with settings, and the query s own binds', async () => {
    const driver = mockDriver()
    const db = pgPrime({ driver, schema })
    driver.rows.push(jsonPlan())

    const r = await db
      .from(schema.h.posts)
      .select(({ posts: p }) => ({ id: p.id }))
      .where(({ posts: p }) => q.gt(p.amount, '10.50'))
      .explain()

    const sent = driver.log[0]
    expect(sent?.text.startsWith('explain (settings true, format json) select ')).toBe(true)
    // The SAME parameters the statement itself would send. A plan for an inlined literal is a
    // plan for a different query (07 §7.5); `EXPLAIN (GENERIC_PLAN)` is the other question.
    expect(sent?.params).toStrictEqual(['10.50'])
    expect(sent?.paramTypes).toStrictEqual([1700])
    expect(r.plan?.['Node Type']).toBe('Seq Scan')
    expect(r.executed).toBe(false)
    expect(r.rolledBack).toBe(false)
  })

  it('analyze turns on buffers and timing, because they are only legal with it', async () => {
    const driver = mockDriver()
    const db = pgPrime({ driver, schema })
    driver.rows.push(jsonPlan({ 'Planning Time': 0.25, 'Execution Time': 3.5 }))
    const r = await db.from(schema.h.users).select(({ users: u }) => ({ id: u.id })).explain({
      analyze: true,
    })
    expect(driver.log[0]?.text.startsWith(
      'explain (analyze true, buffers true, timing true, settings true, format json) ',
    )).toBe(true)
    expect(r.executed).toBe(true)
    expect(r.planningTimeMs).toBe(0.25)
    expect(r.executionTimeMs).toBe(3.5)
  })

  it('format text gives text and no typed tree, and toString() is the text', async () => {
    const driver = mockDriver()
    const db = pgPrime({ driver, schema })
    driver.rows.push([['Seq Scan on users  (cost=0.00..1.00 rows=1 width=8)'], ['  Filter: true']])
    const r = await db
      .from(schema.h.users)
      .select(({ users: u }) => ({ id: u.id }))
      .explain({ format: 'text' })
    expect(driver.log[0]?.text.startsWith('explain (settings true, format text) ')).toBe(true)
    expect(r.plan).toBeUndefined()
    expect(r.text).toBe('Seq Scan on users  (cost=0.00..1.00 rows=1 width=8)\n  Filter: true')
    expect(String(r)).toBe(r.text)
  })

  it('costs false and verbose are passed through; buffers without analyze is NOT', async () => {
    const driver = mockDriver()
    const db = pgPrime({ driver, schema })
    driver.rows.push(jsonPlan())
    await db
      .from(schema.h.users)
      .select(({ users: u }) => ({ id: u.id }))
      .explain({ costs: false, verbose: true, buffers: true, settings: false })
    // `EXPLAIN (BUFFERS)` without ANALYZE is an error before PG 16, and asking for it is almost
    // always a mistake rather than a request, so it is dropped rather than forwarded.
    expect(driver.log[0]?.text.startsWith('explain (verbose true, costs false, format json) ')).toBe(true)
  })
})

describe('the ANALYZE rail (07 §7.5) — EXPLAIN ANALYZE UPDATE performs the update', () => {
  const update = (db: ReturnType<typeof pgPrime<typeof schema>>) =>
    db
      .update(schema.h.users)
      .set(() => ({ name: 'x' }))
      .where(({ users: u }) => q.eq(u.id, 1n))

  it('a mutating statement under analyze is wrapped and rolled back by default', async () => {
    const driver = mockDriver()
    const db = pgPrime({ driver, schema })
    driver.rows.push([], jsonPlan())
    const r = await update(db).explain({ analyze: true })
    expect(kinds(driver.texts())).toStrictEqual(['begin', 'explain (analyze', 'rollback'])
    expect(r.executed).toBe(true)
    expect(r.rolledBack).toBe(true)
    expect(driver.released).toBe(1)
  })

  it('rollback: false is the deliberate opt-out and reads as one', async () => {
    const driver = mockDriver()
    const db = pgPrime({ driver, schema })
    driver.rows.push(jsonPlan())
    const r = await update(db).explain({ analyze: true, rollback: false })
    expect(kinds(driver.texts())).toStrictEqual(['explain (analyze'])
    expect(r.rolledBack).toBe(false)
  })

  it('R4 negative control: a plain SELECT under analyze is NOT wrapped', async () => {
    const driver = mockDriver()
    const db = pgPrime({ driver, schema })
    driver.rows.push(jsonPlan())
    const r = await db
      .from(schema.h.users)
      .select(({ users: u }) => ({ id: u.id }))
      .explain({ analyze: true })
    expect(kinds(driver.texts())).toStrictEqual(['explain (analyze'])
    expect(r.rolledBack).toBe(false)
  })

  it('a SELECT carrying a writable CTE IS wrapped — `writes` is what decides, not `kind`', async () => {
    const driver = mockDriver()
    const db = pgPrime({ driver, schema })
    driver.rows.push([], jsonPlan())
    await db
      .with('gone', (d) =>
        d
          .deleteFrom(schema.h.comments)
          .where(({ comments: c }) => q.eq(c.id, 1n))
          .returning(({ comments: c }) => ({ id: c.id })),
      )
      .fromCte('gone')
      .select(({ gone: g }) => ({ id: g.id }))
      .explain({ analyze: true })
    expect(kinds(driver.texts())).toStrictEqual(['begin', 'explain (analyze', 'rollback'])
  })

  it('inside a transaction the rail is a SAVEPOINT, not a nested BEGIN', async () => {
    const driver = mockDriver()
    const db = pgPrime({ driver, schema })
    await db.transaction(async (tx) => {
      driver.rows.push([], jsonPlan())
      const r = await tx
        .update(schema.h.users)
        .set(() => ({ name: 'x' }))
        .where(({ users: u }) => q.eq(u.id, 1n))
        .explain({ analyze: true })
      expect(r.rolledBack).toBe(true)
    })
    // Rolling the caller's whole transaction back because they asked for a plan would be the
    // cure being worse than the disease.
    expect(kinds(driver.texts())).toStrictEqual([
      'begin',
      'savepoint pgprime_explain',
      'explain (analyze',
      'rollback to',
      'release savepoint',
      'commit',
    ])
  })

  it('a failure inside the rail still undoes it', async () => {
    const driver = mockDriver()
    const db = pgPrime({ driver, schema })
    driver.failOn = (query) => (query.text.startsWith('explain') ? new Error('boom') : undefined)
    await expect(update(db).explain({ analyze: true })).rejects.toThrow('boom')
    expect(kinds(driver.texts())).toStrictEqual(['begin', 'explain (analyze', 'rollback'])
    expect(driver.released).toBe(1)
  })
})

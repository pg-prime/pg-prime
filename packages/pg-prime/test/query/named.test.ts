/**
 * `{ statement: 'named' }` and the description cache — design/07 §2.4, design/03 §1.4 (c).
 *
 * Tier 0 can prove everything about the *policy* — which name goes out, whether it is reused,
 * when we re-prepare, when we stop — because all of it is our own decision-making over SQLSTATEs
 * that the seam delivers as plain data (`02` §7 D12). What tier 0 cannot prove is that
 * PostgreSQL agrees the statement exists; that is `test/pg/executor.test.ts`, against
 * `pg_prepared_statements` on a real session.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearDescribeCache, describeCacheStats } from '../../src/query/executor.js'
import { pgPrime } from '../../src/query/run.js'
import * as q from '../../src/query/types.js'
import { field, mockDriver, serverError } from './_mock-driver.js'
import { schema } from './_schema.js'

const NAME = /^pgprime_[0-9a-z]+_\d+$/

afterEach(() => {
  vi.restoreAllMocks()
})

const select = (db: ReturnType<typeof pgPrime<typeof schema>>) =>
  db.from(schema.h.users).select(({ users: u }) => ({ id: u.id }))

describe('the default is unnamed (07 §2.1)', () => {
  it('no statementName, no server session state, on every pooler', async () => {
    const driver = mockDriver()
    driver.rows.push([['7']])
    await select(pgPrime({ driver, schema })).execute()
    expect(driver.log[0]?.mode).toBe('unnamed')
    expect(driver.statementNames).toStrictEqual([])
  })
})

describe('{ statement: "named" } (07 §2.4)', () => {
  it('sends mode named with a pgprime_<hash>_<seq> name of at most 63 bytes', async () => {
    const driver = mockDriver()
    const db = pgPrime({ driver, schema, statement: 'named' })
    driver.rows.push([['7']])
    await select(db).execute()

    const sent = driver.log[0]
    expect(sent?.mode).toBe('named')
    expect(sent?.statementName).toMatch(NAME)
    // NAMEDATALEN - 1. `pg_` is deliberately NOT the prefix: PostgreSQL reserves it (42939).
    expect((sent?.statementName ?? '').length).toBeLessThanOrEqual(63)
    expect(sent?.statementName?.startsWith('pg_')).toBe(false)
  })

  it('the same statement on the same connection reuses the same name', async () => {
    const driver = mockDriver()
    const db = pgPrime({ driver, schema, statement: 'named' })
    const query = select(db)
    driver.rows.push([['7']], [['8']])
    await query.execute()
    await query.execute()
    expect(driver.statementNames).toHaveLength(1)
    expect(driver.log.map((r) => r.statementName)).toStrictEqual([
      driver.statementNames[0],
      driver.statementNames[0],
    ])
  })

  it('a different statement gets a different name', async () => {
    const driver = mockDriver()
    const db = pgPrime({ driver, schema, statement: 'named' })
    driver.rows.push([['7']], [['x']])
    await select(db).execute()
    await db.from(schema.h.posts).select(({ posts: p }) => ({ title: p.title })).execute()
    expect(driver.statementNames).toHaveLength(2)
  })

  it('per-query opt-in: .prepare(name, { statement: "named" }) on an otherwise unnamed db', async () => {
    const driver = mockDriver()
    const db = pgPrime({ driver, schema })
    driver.rows.push([['7']], [['7']])
    await select(db).execute()
    await select(db).prepare('by_id', { statement: 'named' }).execute({})
    expect(driver.log[0]?.mode).toBe('unnamed')
    expect(driver.log[1]?.mode).toBe('named')
  })
})

describe('self-heal (07 §2.4, policies 1–4)', () => {
  it('26000 re-prepares ONCE with a fresh name, and the second attempt succeeds', async () => {
    const driver = mockDriver()
    const db = pgPrime({ driver, schema, statement: 'named' })
    let failed = false
    driver.failOn = (query) => {
      if (query.mode === 'named' && !failed) {
        failed = true
        return serverError('26000', 'prepared statement "x" does not exist')
      }
      return undefined
    }
    driver.rows.push([['7']])

    expect(await select(db).execute()).toStrictEqual([{ id: 7n }])
    // Two attempts, two DIFFERENT names: the old one is gone from the pooler's server, so
    // re-using the name is how you get 42P05 on the way back.
    expect(driver.log).toHaveLength(2)
    expect(driver.statementNames).toHaveLength(2)
    expect(driver.statementNames[0]).not.toBe(driver.statementNames[1])
  })

  it('a SECOND 26000 in the same execution is surfaced, not retried forever', async () => {
    const driver = mockDriver()
    const db = pgPrime({ driver, schema, statement: 'named' })
    driver.failOn = (query) => (query.mode === 'named' ? serverError('26000') : undefined)
    await expect(select(db).execute()).rejects.toThrow(/26000/)
    expect(driver.log).toHaveLength(2)
  })

  it('never inside a FAILED transaction: a 0A000 there is surfaced, not re-issued', async () => {
    const driver = mockDriver()
    const db = pgPrime({ driver, schema, statement: 'named' })
    driver.forceTxStatus = 'E'
    driver.failOn = (query) => (query.mode === 'named' ? serverError('0A000') : undefined)
    await expect(select(db).execute()).rejects.toThrow(/0A000/)
    // ONE attempt. Re-issuing into an aborted block gets 25P02 and hides the real error.
    expect(driver.log).toHaveLength(1)
  })

  it('never inside an OPEN transaction either — the guard is "idle", not "not failed"', async () => {
    // AMENDS `07` §2.4 policy 2, and the amendment is forced rather than chosen: over `pg` the
    // error callback fires BEFORE the ReadyForQuery that carries the new status, so a guard
    // reading `=== 'E'` still sees `'T'` and lets the retry through — which then gets 25P02.
    // Measured: the tier-2 case flipped between 26000 and 25P02 run to run (09 §3.6).
    const driver = mockDriver()
    const db = pgPrime({ driver, schema, statement: 'named' })
    driver.forceTxStatus = 'T'
    driver.failOn = (query) => (query.mode === 'named' ? serverError('26000') : undefined)
    await expect(select(db).execute()).rejects.toThrow(/26000/)
    expect(driver.log).toHaveLength(1)
  })

  it('an UNNAMED statement is never self-healed — there is no server object to have lost', async () => {
    const driver = mockDriver()
    const db = pgPrime({ driver, schema })
    driver.failOn = () => serverError('26000')
    await expect(select(db).execute()).rejects.toThrow(/26000/)
    expect(driver.log).toHaveLength(1)
  })

  it('the circuit breaker downgrades the POOL to unnamed after N consecutive heals', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const driver = mockDriver()
    const db = pgPrime({
      driver,
      schema,
      statement: 'named',
      preparedStatements: { downgradeAfterFailures: 2 },
    })
    driver.failOn = (query) => (query.mode === 'named' ? serverError('26000') : undefined)

    // First execution: two named attempts, both refused, surfaced.
    await expect(select(db).execute()).rejects.toThrow(/26000/)
    driver.rows.push([['7']])
    // Second: the counter reaches the threshold, the pool downgrades, and the RETRY already
    // goes out unnamed — so the caller gets an answer rather than a second failure.
    expect(await select(db).execute()).toStrictEqual([{ id: 7n }])

    driver.clear()
    driver.rows.push([['8']])
    await select(db).execute()
    // A one-way door for the process lifetime (07 §2.4 policy 4).
    expect(driver.log[0]?.mode).toBe('unnamed')
    expect(errors).toHaveBeenCalledTimes(1)
    expect(String(errors.mock.calls[0]?.[0])).toContain('downgrading this pool to unnamed')
  })
})

describe('LRU eviction uses the protocol Close, never SQL DEALLOCATE (07 §2.4)', () => {
  it('evicting at maxPerConnection closes the least-recently-used name', async () => {
    const driver = mockDriver()
    const db = pgPrime({
      driver,
      schema,
      statement: 'named',
      preparedStatements: { maxPerConnection: 1 },
    })
    driver.rows.push([['7']], [['x']])
    await select(db).execute()
    const first = driver.statementNames[0]
    await db.from(schema.h.posts).select(({ posts: p }) => ({ title: p.title })).execute()

    expect(driver.closed).toStrictEqual([first])
    // `DEALLOCATE <our name>` is exactly what breaks PHP/PDO through PgBouncer, because the name
    // the pooler gave the server is its own. It must never appear.
    expect(driver.texts().some((t) => t.toLowerCase().includes('deallocate'))).toBe(false)
  })

  it('a custom prefix that would overflow 63 bytes is refused rather than truncated', async () => {
    const driver = mockDriver()
    const db = pgPrime({
      driver,
      schema,
      statement: 'named',
      preparedStatements: { prefix: 'x'.repeat(60) },
    })
    await expect(select(db).execute()).rejects.toThrow(/PostgreSQL allows 63/)
  })
})

describe('the description cache (03 §1.4c) — decode PLANS, not Parse messages', () => {
  it('100 executions of one fragment-only statement build ONE decode plan', async () => {
    clearDescribeCache(true)
    const driver = mockDriver()
    const db = pgPrime({ driver, schema })
    for (let i = 0; i < 100; i++) {
      driver.rows.push([[String(i)]])
      driver.fields.push([field('n', 23)])
    }
    const raw = db.sql`select 1 as n`
    for (let i = 0; i < 100; i++) await raw.execute()

    const stats = describeCacheStats()
    expect(stats.builds).toBe(1)
    expect(stats.hits).toBe(99)
  })

  it('the rows are decoded BY OID, keyed by field name — the value oracle for the cache', async () => {
    clearDescribeCache(true)
    const driver = mockDriver()
    const db = pgPrime({ driver, schema })
    driver.rows.push([['9007199254740993', '10.50']])
    driver.fields.push([field('big', 20), field('amount', 1700)])
    // int8 → bigint, numeric → precision-exact string. A cache that handed back a stale plan
    // would show up here as a `string` where a `bigint` belongs.
    expect(await db.sql`select …`.execute()).toStrictEqual([
      { big: 9007199254740993n, amount: '10.50' },
    ])
  })

  it('a different OID signature for the same SQL rebuilds the plan', async () => {
    clearDescribeCache(true)
    const driver = mockDriver()
    const db = pgPrime({ driver, schema })
    driver.rows.push([['1']], [['x']])
    driver.fields.push([field('v', 23)], [field('v', 25)])
    const raw = db.sql`select v from t`
    expect(await raw.execute()).toStrictEqual([{ v: 1 }])
    expect(await raw.execute()).toStrictEqual([{ v: 'x' }])
    expect(describeCacheStats().builds).toBe(2)
  })

  it('0A000 invalidates it — even for an UNNAMED statement (07 §2.4 policy 3)', async () => {
    clearDescribeCache(true)
    const driver = mockDriver()
    const db = pgPrime({ driver, schema })
    driver.rows.push([['1']])
    driver.fields.push([field('v', 23)])
    await db.sql`select v from t`.execute()
    expect(describeCacheStats().builds).toBe(1)

    // A migration ran. PostgreSQL says the cached plan must not change result type.
    driver.failOn = (query) => (query.text.startsWith('select "users"') ? serverError('0A000') : undefined)
    await expect(select(db).execute()).rejects.toThrow(/0A000/)
    driver.failOn = undefined

    driver.rows.push([['1']])
    driver.fields.push([field('v', 23)])
    await db.sql`select v from t`.execute()
    // Rebuilt: the entry was dropped, not merely revalidated.
    expect(describeCacheStats().builds).toBe(2)
  })

  it('R4 negative control: 23505 does NOT invalidate it', async () => {
    clearDescribeCache(true)
    const driver = mockDriver()
    const db = pgPrime({ driver, schema })
    driver.rows.push([['1']])
    driver.fields.push([field('v', 23)])
    await db.sql`select v from t`.execute()

    driver.failOn = (query) => (query.text.startsWith('select "users"') ? serverError('23505') : undefined)
    await expect(select(db).execute()).rejects.toThrow(/23505/)
    driver.failOn = undefined

    driver.rows.push([['1']])
    driver.fields.push([field('v', 23)])
    await db.sql`select v from t`.execute()
    expect(describeCacheStats().builds).toBe(1)
  })

  it('a BUILDER query never touches the cache — its codecs are known statically (03 §1.4c)', async () => {
    clearDescribeCache(true)
    const driver = mockDriver()
    const db = pgPrime({ driver, schema })
    driver.rows.push([['7']])
    driver.fields.push([field('id', 20)])
    await select(db).execute()
    expect(describeCacheStats()).toMatchObject({ builds: 0, hits: 0, misses: 0 })
  })
})

/** Keeps the operator import honest under `noUnusedLocals`. */
void q

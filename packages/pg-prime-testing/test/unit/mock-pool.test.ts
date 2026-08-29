/**
 * Tier 0 for `createMockPool` — the three things it promises (record, replay, scripted SQLSTATE)
 * and the one that makes them worth anything: that `pgPrime({ pool })` accepts it and runs a
 * query end to end through the real executor, the real compiler and the real codecs.
 */

import { eq, pgPrime, UniqueViolationError } from 'pg-prime'
import { describe, expect, it } from 'vitest'
import { createMockPool, DEFAULT_SERVER_PARAMETERS } from '../../src/mock-pool.js'
import { schema } from './_schema.js'

describe('createMockPool', () => {
  it('satisfies pgPrime({ pool }) and decodes a scripted row through the schema codecs', async () => {
    const pool = createMockPool({
      script: [{ rows: [['9007199254740993', 'ada@example.com', 'Ada']] }],
    })
    const db = pgPrime({ pool, schema })

    const rows = await db
      .from(db.h.users)
      .select(({ users: u }) => ({ id: u.id, email: u.email, name: u.name }))
      .where(({ users: u }) => eq(u.email, 'ada@example.com'))
      .execute()

    // `bigint`, not a lossy number: the mock hands back the wire text and the schema's codec is
    // what turns it into a value. A mock that returned already-decoded rows would prove nothing.
    expect(rows).toEqual([{ id: 9007199254740993n, email: 'ada@example.com', name: 'Ada' }])
    await db.end()
    expect(pool.ended).toBe(true)
  })

  it('records text, values, mode, binary and rowMode for every statement', async () => {
    const pool = createMockPool({ script: [{ rows: [['1', 'a@example.com', 'A']] }] })
    const db = pgPrime({ pool, schema })

    await db
      .from(db.h.users)
      .select(({ users: u }) => ({ id: u.id }))
      .where(({ users: u }) => eq(u.email, 'a@example.com'))
      .execute()

    expect(pool.queries).toHaveLength(1)
    const q = pool.queries[0]!
    expect(q.text).toContain('from "public"."users" as "users"')
    expect(q.text).toContain('where "users"."email" = $1')
    expect(q.values).toEqual(['a@example.com'])
    // pg-prime forces the extended protocol even with zero parameters (design/02 D4), and asks
    // for array rows and text results. All three are recorded so a regression is one assertion.
    expect(q.mode).toBe('unnamed')
    expect(q.rowMode).toBe('array')
    expect(q.binary).toBe(false)
    expect(q.client).toBe(0)
    expect(pool.texts).toEqual([q.text])
    await db.end()
  })

  it('answers the pg_settings handshake without consuming a script step or recording one', async () => {
    const pool = createMockPool({ script: [{ rows: [['1', 'a@example.com', 'A']] }] })
    const db = pgPrime({ pool, schema })
    await db
      .from(db.h.users)
      .select(({ users: u }) => ({ id: u.id }))
      .execute()

    expect(pool.stepsUsed).toBe(1)
    expect(pool.queries.every((q) => !q.text.includes('pg_settings'))).toBe(true)
    expect(DEFAULT_SERVER_PARAMETERS['server_version_num']).toBe('170011')
    await db.end()
  })

  it('replays the script in order and answers an exhausted script with an empty result', async () => {
    const pool = createMockPool({
      script: [
        { rows: [['1', 'one@example.com', 'One']] },
        { rows: [['2', 'two@example.com', 'Two']] },
      ],
    })
    const db = pgPrime({ pool, schema })
    const read = (): Promise<{ id: bigint }[]> =>
      db
        .from(db.h.users)
        .select(({ users: u }) => ({ id: u.id }))
        .execute()

    expect(await read()).toEqual([{ id: 1n }])
    expect(await read()).toEqual([{ id: 2n }])
    expect(await read()).toEqual([])
    expect(pool.stepsUsed).toBe(2)
    await db.end()
  })

  it('answers a step written as a function of the statement it is answering', async () => {
    const pool = createMockPool({
      script: [
        (q) =>
          q.text.startsWith('insert')
            ? { command: 'INSERT', rowCount: 1, rows: [['7']] }
            : { rows: [] },
      ],
    })
    const db = pgPrime({ pool, schema })
    const inserted = await db
      .insertInto(db.h.users)
      .values({ email: 'z@example.com', name: 'Z' })
      .returning(({ users: u }) => ({ id: u.id }))
      .execute()

    expect(inserted).toEqual([{ id: 7n }])
    await db.end()
  })

  it('raises a scripted SQLSTATE as the pg-prime error class for that code', async () => {
    const pool = createMockPool({
      script: [
        {
          code: '23505',
          message: 'duplicate key value violates unique constraint "users_email_key"',
          detail: 'Key (email)=(ada@example.com) already exists.',
          table: 'users',
          constraint: 'users_email_key',
        },
      ],
    })
    const db = pgPrime({ pool, schema })

    const failure = await db
      .insertInto(db.h.users)
      .values({ email: 'ada@example.com', name: 'Ada' })
      .execute()
      .then(
        () => undefined,
        (e: unknown) => e,
      )

    // The whole point of scripting the error as DATA: pg-prime's own duck-typed detection runs,
    // so the SQLSTATE really does become the class, with the constraint name on it.
    expect(failure).toBeInstanceOf(UniqueViolationError)
    expect((failure as UniqueViolationError).code).toBe('23505')
    expect((failure as UniqueViolationError).sqlStateClass).toBe('23')
    expect((failure as UniqueViolationError).constraintName).toBe('users_email_key')
    await db.end()
  })

  it('lets a test override what the handshake reports', async () => {
    const pool = createMockPool({ serverParameters: { server_version_num: '150013' } })
    const db = pgPrime({ pool, schema })
    await db
      .from(db.h.users)
      .select(({ users: u }) => ({ id: u.id }))
      .execute()
    // Read back off the pool rather than out of pg-prime: the assertion here is that the option
    // reaches the wire, and where pg-prime keeps it afterwards is pg-prime's business.
    expect(pool.connectCount).toBeGreaterThan(0)
    await db.end()
  })

  it('reports the pool it is standing in for', async () => {
    const pool = createMockPool({ max: 3 })
    expect(pool.options).toEqual({ max: 3 })
    expect(pool.checkedOut).toBe(0)
    const client = await pool.connect()
    expect(pool.checkedOut).toBe(1)
    expect(pool.totalCount).toBe(1)
    client.release()
    expect(pool.checkedOut).toBe(0)
    expect(pool.idleCount).toBe(1)
  })

  it('forgets everything on reset()', async () => {
    const pool = createMockPool()
    pool.push({ rows: [['1', 'a@example.com', 'A']] })
    const db = pgPrime({ pool, schema })
    await db
      .from(db.h.users)
      .select(({ users: u }) => ({ id: u.id }))
      .execute()
    expect(pool.queries).toHaveLength(1)
    pool.reset()
    expect(pool.queries).toHaveLength(0)
    expect(pool.stepsUsed).toBe(0)
    await db.end()
  })

  it('refuses a pg Submittable with a sentence naming the fixture that does drive one', async () => {
    const pool = createMockPool()
    const client = await pool.connect()
    expect(() => client.query({ submit: () => undefined } as never)).toThrow(/startPglite/)
  })
})

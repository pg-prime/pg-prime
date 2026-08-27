/**
 * `stream()` — the cursor lifecycle (design/07 §6.3; design/09 WS6).
 *
 * Everything asserted here is about *what happened to the connection*, which is why the oracle is
 * the mock driver's log and its acquire/release counters rather than the rows. A cursor wrapper
 * that returns the right rows and leaks a connection looks perfect from the consumer's side; the
 * leak only shows up as a pool exhaustion three hours into production. So: one `begin`, one
 * `close`, one transaction end, and `acquired === released`, on *every* exit path — completion,
 * `break`, and `throw`.
 *
 * The cursor SQL itself (`DECLARE … NO SCROLL CURSOR` / `FETCH FORWARD n`, `25P01` outside a
 * transaction, the FETCH count that may not be a bind) is pinned against a real server by
 * `test/driver/cursor.test.ts`. This file does not re-litigate it.
 */

import { describe, expect, it } from 'vitest'
import { pgPrime } from '../../src/query/run.js'
import { mockDriver } from './_mock-driver.js'
import { schema } from './_schema.js'

const kinds = (texts: readonly string[]): string[] =>
  texts.map((t) => t.split(' ')[0] ?? '').filter((w) => w !== '')

describe('at the root, a stream owns a connection and a transaction', () => {
  const build = (db: ReturnType<typeof pgPrime<typeof schema>>) =>
    db.from(schema.h.users).select(({ users: u }) => ({ id: u.id }))

  it('begin → declare → fetch ×n → close → commit, and the connection goes back', async () => {
    const driver = mockDriver()
    const db = pgPrime({ driver, schema })
    driver.chunks.push([{ rows: [['7'], ['8']] }, { rows: [['9']] }])

    const seen: unknown[] = []
    for await (const row of build(db).stream({ batchSize: 2 })) seen.push(row)

    expect(seen).toStrictEqual([{ id: 7n }, { id: 8n }, { id: 9n }])
    expect(kinds(driver.texts())).toStrictEqual([
      'begin',
      'declare',
      'fetch',
      'fetch',
      'close',
      'commit',
    ])
    expect(driver.acquired).toBe(1)
    expect(driver.released).toBe(1)
  })

  it('the batch size reaches the FETCH, so back-pressure is the size the caller asked for', async () => {
    const driver = mockDriver()
    const db = pgPrime({ driver, schema })
    driver.chunks.push([{ rows: [['7']] }])
    for await (const _ of build(db).stream({ batchSize: 250 })) void _
    expect(driver.texts().find((t) => t.startsWith('fetch'))).toContain('fetch forward 250')
  })

  it('`break` closes the cursor, ends the transaction and releases — the classic leak', async () => {
    const driver = mockDriver()
    const db = pgPrime({ driver, schema })
    // Three batches scripted; the consumer takes one row out of the first.
    driver.chunks.push([{ rows: [['7'], ['8']] }, { rows: [['9']] }, { rows: [['10']] }])

    const seen: unknown[] = []
    for await (const row of build(db).stream({ batchSize: 2 })) {
      seen.push(row)
      break
    }

    expect(seen).toStrictEqual([{ id: 7n }])
    // ONE fetch, because the second batch was never asked for; and the exit is a rollback, not a
    // commit: a consumer that stopped reading did not finish, and saying so costs nothing.
    expect(kinds(driver.texts())).toStrictEqual(['begin', 'declare', 'fetch', 'close', 'rollback'])
    expect(driver.released).toBe(1)
  })

  it('a throw in the consumer also unwinds the cursor and the transaction', async () => {
    const driver = mockDriver()
    const db = pgPrime({ driver, schema })
    driver.chunks.push([{ rows: [['7']] }, { rows: [['8']] }])

    await expect(
      (async () => {
        for await (const _ of build(db).stream()) {
          void _
          throw new Error('consumer exploded')
        }
      })(),
    ).rejects.toThrow('consumer exploded')

    expect(kinds(driver.texts())).toStrictEqual(['begin', 'declare', 'fetch', 'close', 'rollback'])
    expect(driver.acquired).toBe(driver.released)
  })

  it('a stream that yields nothing still closes cleanly', async () => {
    const driver = mockDriver()
    const db = pgPrime({ driver, schema })
    driver.chunks.push([{ rows: [] }])
    for await (const _ of build(db).stream()) void _
    expect(kinds(driver.texts())).toStrictEqual(['begin', 'declare', 'fetch', 'close', 'commit'])
    expect(driver.released).toBe(1)
  })
})

describe('inside db.transaction() a stream joins, it does not nest', () => {
  it('no second begin, no commit of the caller s transaction, no second connection', async () => {
    const driver = mockDriver()
    const db = pgPrime({ driver, schema })
    driver.chunks.push([{ rows: [['7']] }])

    const seen: unknown[] = []
    await db.transaction(async (tx) => {
      for await (const row of tx
        .from(schema.h.users)
        .select(({ users: u }) => ({ id: u.id }))
        .stream()) {
        seen.push(row)
      }
    })

    expect(seen).toStrictEqual([{ id: 7n }])
    // Exactly one `begin` and one `commit`, both the transaction's own. A nested BEGIN is a
    // 25001 warning and a commit that ends the wrong scope (03 §2.6's rule, applied to cursors).
    expect(kinds(driver.texts())).toStrictEqual([
      'begin',
      'declare',
      'fetch',
      'close',
      'commit',
    ])
    expect(driver.acquired).toBe(1)
  })

  it('breaking out inside a transaction leaves the transaction alive for the rest of the block', async () => {
    const driver = mockDriver()
    const db = pgPrime({ driver, schema })
    driver.chunks.push([{ rows: [['7'], ['8']] }])
    driver.rows.push([['1']])

    await db.transaction(async (tx) => {
      for await (const _ of tx
        .from(schema.h.users)
        .select(({ users: u }) => ({ id: u.id }))
        .stream({ batchSize: 2 })) {
        void _
        break
      }
      // Still inside the SAME transaction: this statement must reach the server before commit.
      await tx.from(schema.h.users).select(({ users: u }) => ({ id: u.id })).execute()
    })

    expect(kinds(driver.texts())).toStrictEqual([
      'begin',
      'declare',
      'fetch',
      'close',
      'select',
      'commit',
    ])
  })
})

describe('assertShape and the dynamic decode run on the first chunk', () => {
  it('a lying codec on a streamed column throws on the first batch, not per row', async () => {
    const driver = mockDriver()
    const db = pgPrime({ driver, schema })
    driver.chunks.push([
      // `id` is declared int8 (20); the server says text (25).
      { rows: [['7']], fields: [{ name: 'id', dataTypeID: 25, dataTypeModifier: -1, tableID: 0, columnID: 0, dataTypeSize: -1, format: 'text' }] },
    ])

    await expect(
      (async () => {
        for await (const _ of db
          .from(schema.h.users)
          .select(({ users: u }) => ({ id: u.id }))
          .stream()) {
          void _
        }
      })(),
    ).rejects.toThrow(/CodecMismatch|declared as codec/)
    // …and the cursor still came down cleanly.
    expect(driver.released).toBe(1)
  })
})

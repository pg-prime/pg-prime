import type { Tx } from 'pg-prime'
import { expect, it } from 'vitest'
import { db } from '../db.js'
import type { schema } from '../schema.js'

type AppSchema = typeof schema

/**
 * The fixture: every case runs inside a transaction that is ALWAYS rolled back. No truncation, no
 * re-seeding, no ordering between cases — and it exercises the same transaction machinery the
 * application uses.
 *
 * `tx.rollbackWith(value)` aborts the transaction and resolves it with the value, so the fixture
 * does not have to throw a sentinel error and catch it.
 */
const test = (name: string, fn: (tx: Tx<AppSchema>) => Promise<void>): void => {
  it(name, async () => {
    const outcome = await db.transaction(async (tx) => {
      await fn(tx)
      return tx.rollbackWith('rolled back' as const)
    })
    expect(outcome).toBe('rolled back')
  })
}

test('inserts a user', async (tx) => {
  await tx
    .insertInto(tx.h.users)
    .values({ email: 'ada@example.com', name: 'Ada' })
    .execute()

  const rows = await tx
    .from(tx.h.users, 'u')
    .select((t) => ({ email: t.u.email }))
    .execute()

  expect(rows).toEqual([{ email: 'ada@example.com' }])
})

test('starts from an empty table, because the last case rolled back', async (tx) => {
  const rows = await tx
    .from(tx.h.users, 'u')
    .select((t) => ({ email: t.u.email }))
    .execute()

  expect(rows).toEqual([])
})

// design/08 §1.2's "full CRUD + tx" line, §2.4's method.
//
// Insert, update, delete and select against one schema, plus `db.transaction()` — the shape of a
// real application module. This pulls in the write builders, the returning projection and the
// connection-scoped runner on top of everything `connect-one-select` uses; it must still leave out
// the relation loader, window functions, set ops, cursors and EXPLAIN.
import { and, defineSchema, desc, eq, gt, pgDriver, pgPrime, pgTable } from 'pg-prime'
import type { Db, PgLikePool } from 'pg-prime'

const users = pgTable('users', (t) => ({
  id: t.bigint().primaryKey().generatedAlways(),
  email: t.text(),
  name: t.text().nullable(),
  createdAt: t.timestamptz().defaultNow(),
}))

const schema = defineSchema({ users })
type Schema = typeof schema

export function connect(pool: PgLikePool): Db<Schema> {
  return pgPrime({ driver: pgDriver(pool), schema })
}

export async function crud(db: Db<Schema>): Promise<unknown> {
  const inserted = await db
    .insertInto(schema.h.users)
    .values({ email: 'someone@example.com', name: 'Someone' })
    .returning(({ users: u }) => ({ id: u.id }))
    .execute()

  const updated = await db
    .update(schema.h.users)
    .set(() => ({ name: 'Renamed' }))
    .where(({ users: u }) => eq(u.email, 'someone@example.com'))
    .returning(({ users: u }) => ({ id: u.id, name: u.name }))
    .execute()

  const selected = await db
    .from(schema.h.users)
    .select(({ users: u }) => ({ id: u.id, email: u.email }))
    .where(({ users: u }) => and(eq(u.email, 'someone@example.com'), gt(u.id, 0n)))
    .orderBy(({ users: u }) => desc(u.id))
    .limit(10)
    .execute()

  const deleted = await db
    .deleteFrom(schema.h.users)
    .where(({ users: u }) => eq(u.email, 'someone@example.com'))
    .execute()

  return { inserted, updated, selected, deleted }
}

export function inTransaction(db: Db<Schema>): Promise<bigint> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insertInto(schema.h.users)
      .values({ email: 'tx@example.com' })
      .returning(({ users: u }) => ({ id: u.id }))
      .execute()
    await tx
      .update(schema.h.users)
      .set(() => ({ name: 'in a transaction' }))
      .where(({ users: u }) => eq(u.id, row!.id))
      .execute()
    return row!.id
  })
}

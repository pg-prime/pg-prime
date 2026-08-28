// design/08 §1.2's "connect + one select" line, §2.4's method.
//
// The smallest thing an application can honestly be said to do: declare one table, open a handle
// over a pool, and compile one filtered select. Everything else in the package — the insert /
// update / delete builders, CTEs, window functions, set ops, the relation loader, the codegen
// decoder, EXPLAIN, cursors, ~80 of the ~90 operators — must NOT be in the bundle, and
// `expected-modules.json` beside this file is the assertion that says which modules are.
//
// Imported through `pg-prime`, never through `../../packages/pg-prime/src`: the point of the check
// is that the published EXPORT MAP tree-shakes, and a relative import would test something we do
// not ship.
import { compileOnly, defineSchema, eq, pgDriver, pgPrime, pgTable } from 'pg-prime'
import type { Db, PgLikePool } from 'pg-prime'

const users = pgTable('users', (t) => ({
  id: t.bigint().primaryKey().generatedAlways(),
  email: t.text(),
}))

const schema = defineSchema({ users })

export function connect(pool: PgLikePool): Db<typeof schema> {
  return pgPrime({ driver: pgDriver(pool), schema })
}

export function oneSelect(): string {
  return compileOnly(schema)
    .from(schema.h.users)
    .select(({ users: u }) => ({ id: u.id, email: u.email }))
    .where(({ users: u }) => eq(u.email, 'someone@example.com'))
    .compile().sql
}

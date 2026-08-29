/**
 * The two-table schema the tier-0 tests compile against. Deliberately the same shape as the docs
 * site's `blog` snippet, so an example on `guides/testing` and a test here read the same.
 */

import { defineSchema, pgTable } from 'pg-prime'

export const users = pgTable('users', (t) => ({
  id: t.bigint().primaryKey().generatedAlways(),
  email: t.text().unique(),
  name: t.text(),
}))

export const schema = defineSchema({ users })
export type AppSchema = typeof schema

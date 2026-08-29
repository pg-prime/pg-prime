import { pgPrime } from 'pg-prime'
import { schema } from './schema.js'

export const db = pgPrime({
  connection: process.env['DATABASE_URL']!,
  schema,
})

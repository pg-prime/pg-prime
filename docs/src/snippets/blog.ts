// docs: use=blog-schema
/**
 * `blog-schema` plus the handle every example queries through.
 *
 * `DATABASE_URL` is what the examples runner sets to the PGlite server it starts for the run, and
 * what an application reads in production. Pages that also need the tables to exist write
 * `use=blog,blog-ddl`.
 */
import { pgPrime } from 'pg-prime'

const db = pgPrime({
  connection: process.env['DATABASE_URL'] ?? 'postgres://localhost:5432/postgres',
  schema,
})

export {}

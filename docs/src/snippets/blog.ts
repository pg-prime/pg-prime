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
  // Two lines an application does not want, and no page shows: the examples runner's PGlite is ONE
  // backend behind one socket bridge (design/08 F8), so a second physical connection opened while a
  // transaction is in flight is dropped and the transaction silently stops isolating. `max: 1`
  // removes the pool's own second connection; `devGuard: false` removes design/07 §5.4's startup
  // pooler probe, which deliberately opens up to three more to create contention. `docs:examples`
  // fails any example the bridge drops a connection under, so this cannot rot into a lie.
  poolOptions: { max: 1 },
  devGuard: false,
})

export {}

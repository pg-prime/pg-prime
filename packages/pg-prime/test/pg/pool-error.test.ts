/**
 * Tier 2 — what happens to an IDLE pooled connection when the server kills it
 * (design/07 §1.2, §7.1; design/13 §5, the fix round's item 1).
 *
 * `checkout-error.test.ts` is the other half: a connection the adapter has CHECKED OUT, where
 * `pg-adapter.ts`'s own per-client `error` listener owns the failure. This file is the case
 * nothing owned. pg-pool keeps an `idleListener` on a client while it sits in the idle set
 * (`pg-pool/index.js` `makeIdleListener`): on an error it removes the client, closes it, and
 * re-emits `('error', err, client)` **on the pool** — and an `EventEmitter` `error` with no
 * listener throws, so `pg_terminate_backend` against an idle pooled connection used to take the
 * whole process down with an uncaught `57P01`.
 *
 * The oracle needs no assertion of its own, exactly as in `checkout-error.test.ts`: if `buildPool`
 * stops attaching a listener this file does not fail — **the vitest worker dies**. What the
 * assertions add is the rest of the contract: the pool heals onto a fresh backend, and the event
 * is reported on `onInternal` rather than swallowed.
 *
 * It needs a second backend session to do the killing, so it is tier 2: on PGlite there is one
 * backend and `pg_terminate_backend` would take the test's own session with it.
 */

import { afterAll, describe, expect } from 'vitest'
import pg from 'pg'
import type { InternalEvent } from '../../src/observe/index.js'
import { OperatorInterventionError } from '../../src/errors/index.js'
import { pgPrime } from '../../src/query/run.js'
import { defineSchema, pgTable } from '../../src/schema/index.js'
import { liveTarget, requiresConcurrency, sqlState } from '../live/_harness.js'

const marker = pgTable('pgprime_pool_error_marker', (t) => ({ id: t.integer().primaryKey() }))
const schema = defineSchema({ marker })

/** Handles opened by a test, closed once at the end whether it passed or not. */
const open: (() => Promise<void>)[] = []

afterAll(async () => {
  for (const close of open.splice(0)) await close().catch(() => {})
})

async function killer(): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: liveTarget().url })
  await c.connect()
  return c
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** `pg_backend_pid()` of whichever connection this statement lands on. */
async function pidOf(handle: {
  sql: (strings: TemplateStringsArray) => { execute: () => Promise<readonly unknown[]> }
}): Promise<number> {
  const [row] = await handle.sql`select pg_backend_pid() as pid`.execute()
  return Number((row as { pid: unknown }).pid)
}

describe('an idle pooled connection the server kills (07 §1.2)', () => {
  requiresConcurrency()(
    'is reported on onInternal, the pool heals onto a fresh backend, and the process lives',
    async () => {
      const seen: InternalEvent[] = []
      // `max: 1` so the pid below IS the pool's only connection; `devGuard: false` so §5.4's
      // startup probe does not open three more and make "which backend died" a race.
      const app = pgPrime({
        connection: liveTarget().url,
        schema,
        poolOptions: { max: 1 },
        devGuard: false,
        hooks: {
          onInternal: (e) => {
            seen.push(e)
          },
        },
      })
      open.push(() => app.end())

      // One statement, to open the pooled connection — released back IDLE at its end, which is
      // the state this file is about.
      const first = await pidOf(app)
      expect(first).toBeGreaterThan(0)

      const other = await killer()
      try {
        await other.query('select pg_catalog.pg_terminate_backend($1)', [first])
      } finally {
        await other.end()
      }

      // The dropped socket reaches pg asynchronously, and pg-pool re-emits it on the pool.
      const idle = (): InternalEvent[] => seen.filter((e) => e.kind === 'idle-connection-error')
      for (let i = 0; i < 100 && idle().length === 0; i++) await sleep(20)

      // At least one, not exactly one: pg-pool's `_remove` calls `client.end()` on a socket that
      // is already gone, and a second `error` from that teardown would be a second event. The
      // claim is that the death is reported, not how many times the socket complains.
      expect(idle().length).toBeGreaterThanOrEqual(1)
      expect(idle()[0]!.message).toContain('IDLE')
      expect(idle()[0]!.cause).toBeDefined()

      // …and the handle still works, on a DIFFERENT backend: pg-pool discarded the dead client
      // before it emitted, so nothing of ours had to.
      const second = await pidOf(app)
      expect(second).toBeGreaterThan(0)
      expect(second).not.toBe(first)
    },
    60_000,
  )

  requiresConcurrency()(
    'the CHECKED-OUT case still rejects with the mapped class, through the same pool',
    async () => {
      // The pool listener must not have taken the checked-out path's error away from it: while a
      // transaction holds the connection pg-pool's idle listener is OFF and the adapter's own is
      // ON, so the failure reaches the caller as a rejected promise carrying the SQLSTATE.
      const app = pgPrime({
        connection: liveTarget().url,
        schema,
        poolOptions: { max: 1 },
        devGuard: false,
      })
      open.push(() => app.end())

      const other = await killer()
      try {
        const err = await app
          .transaction(async (tx) => {
            const pid = await pidOf(tx)
            await other.query('select pg_catalog.pg_terminate_backend($1)', [pid])
            await tx.sql`select pg_sleep(0.2)`.execute()
          })
          .catch((e: unknown) => e)

        expect(err).toBeInstanceOf(Error)
        // 57P01 admin_shutdown when the ErrorResponse wins the race with the socket close; either
        // way it is a rejection the caller sees, which is the property under test.
        if (sqlState(err) === '57P01') expect(err).toBeInstanceOf(OperatorInterventionError)
      } finally {
        await other.end()
      }
    },
    60_000,
  )
})

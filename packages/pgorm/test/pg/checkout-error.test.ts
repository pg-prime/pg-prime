/**
 * Tier 2 — what happens to a CHECKED-OUT connection when the server kills it (design/02 §2.2).
 *
 * `test/driver/adapter-lifecycle.test.ts` pins this structurally over a fake pool. This file is
 * the end-to-end half, and it needs a second backend to do the killing, so it lives here: on
 * PGlite there is only one backend and `pg_terminate_backend` would take the test's own session
 * with it.
 *
 * The oracle is brutal and needs no assertion of its own: pg-pool takes ITS `error` listener off
 * the client at checkout, and Node throws on an `'error'` event with no listener. If the adapter
 * stops keeping one, this file does not fail — the worker dies.
 */

import { afterAll, beforeAll, describe, expect } from 'vitest'
import { makeHarness, requiresConcurrency, type Harness } from '../live/_harness.js'

let h: Harness

beforeAll(async () => {
  h = await makeHarness()
})
afterAll(async () => {
  await h?.end()
})

describe('a terminated backend is an error we own, not an uncaught event', () => {
  requiresConcurrency()('pg_terminate_backend during a checkout flips usable and disposes', async () => {
    const victim = await h.driver.acquire()
    const killer = await h.driver.acquire()
    const pid = victim.backendPid!
    expect(pid).toBeGreaterThan(0)
    expect(victim.usable).toBe(true)

    try {
      await killer.execute({
        text: 'select pg_catalog.pg_terminate_backend($1::int4)',
        params: [String(pid)],
        paramTypes: [23],
      })
      // the ErrorResponse + socket close reach us asynchronously
      for (let i = 0; i < 50 && victim.usable; i++) await new Promise((r) => setTimeout(r, 20))

      expect(victim.usable).toBe(false)
      await expect(victim.execute({ text: 'select 1', params: [] })).rejects.toMatchObject({
        pgorm: { connectionUnusable: true },
      })
    } finally {
      // a plain release: `usable === false` is enough for the adapter to throw it away
      await h.driver.release(victim)
      await h.driver.release(killer)
    }

    // the pool is still usable afterwards — one dead backend is not a dead driver
    const fresh = await h.driver.acquire()
    expect((await fresh.execute({ text: 'select 1', params: [] })).rows).toEqual([['1']])
    await h.driver.release(fresh)
  })
})

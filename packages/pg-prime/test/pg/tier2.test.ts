/**
 * Tier 2 exists because tier 1 lies, and this file is the proof (design/08 §4.2, F8).
 *
 * Every assertion here is one PGlite would get **wrong while passing**: it multiplexes every
 * connection onto one backend, so "two sessions" share a pid, a lock table and a transaction.
 * That is why the ban list is a rule and not a preference — a broken `skip locked`, a broken
 * advisory lock or a broken retry-on-40001 would all test green on tier 1.
 *
 * It doubles as the self-test for `requiresConcurrency()` / `requiresVersion()`: run it on
 * PGlite (`pnpm test:live`) and every case must skip with a printed reason; run it against
 * `PG_PRIME_TEST_URL` (`pnpm test:pg`) and every case must run.
 */

import { afterAll, beforeAll, describe, expect } from 'vitest'
import {
  makeHarness,
  requiresConcurrency,
  requiresVersion,
  type Harness,
} from '../live/_harness.js'
import type { PgConnection } from '../../src/driver/index.js'

/** Arbitrary, but stable and ours: `pg-prime` in ASCII, shifted into the advisory-lock key space. */
const LOCK_KEY = 0x70676f726d01

let h: Harness
let a: PgConnection
let b: PgConnection

beforeAll(async () => {
  h = await makeHarness()
  a = await h.driver.acquire()
  b = await h.driver.acquire()
})

afterAll(async () => {
  await h?.driver.release(a, { dispose: true })
  await h?.driver.release(b, { dispose: true })
  await h?.end()
})

const one = async (
  conn: PgConnection,
  text: string,
  params: string[] = [],
): Promise<string | null> => {
  const v = (await conn.execute({ text, params })).rows[0]?.[0]
  return typeof v === 'string' ? v : null
}

describe('tier 2 — two connections are two backends', () => {
  requiresConcurrency()('they report different pids', async () => {
    const [pidA, pidB] = [
      await one(a, 'select pg_backend_pid()'),
      await one(b, 'select pg_backend_pid()'),
    ]
    expect(pidA).not.toBe(pidB)
    // and the driver agrees with the server about which one it is holding
    expect(String(a.backendPid)).toBe(pidA)
    expect(String(b.backendPid)).toBe(pidB)
  })

  requiresConcurrency()('session state does not leak between them', async () => {
    await a.execute({ text: `select set_config('pgprime.probe', 'a', false)`, params: [] })
    expect(await one(b, `select current_setting('pgprime.probe', true)`)).toBeNull()
  })

  requiresConcurrency()('an advisory lock held by one is NOT grantable to the other', async () => {
    expect(await one(a, 'select pg_advisory_lock($1::int8)', [String(LOCK_KEY)])).toBe('')
    try {
      // PGlite answers `t` here — the single finding that put the migration runner's lock safety
      // on tier 2 (design/08 F8).
      expect(await one(b, 'select pg_try_advisory_lock($1::int8)', [String(LOCK_KEY)])).toBe('f')
    } finally {
      await a.execute({ text: 'select pg_advisory_unlock($1::int8)', params: [String(LOCK_KEY)] })
    }
  })

  requiresConcurrency()(
    'a row locked by one is skipped, not returned, by `skip locked`',
    async () => {
      await a.execute({ text: 'drop table if exists pgprime_tier2_q', params: [], mode: 'simple' })
      await a.execute({
        text: `create table pgprime_tier2_q (id int primary key)`,
        params: [],
        mode: 'simple',
      })
      await a.execute({ text: `insert into pgprime_tier2_q values (1), (2)`, params: [] })
      await a.execute({ text: 'begin', params: [] })
      try {
        expect(await one(a, 'select id from pgprime_tier2_q where id = 1 for update')).toBe('1')
        // The queue-workload guarantee: B must see 2 and never block on 1.
        const rows = (
          await b.execute({
            text: 'select id from pgprime_tier2_q order by id for update skip locked',
            params: [],
          })
        ).rows.map((r) => r[0])
        expect(rows).toEqual(['2'])
      } finally {
        await a.execute({ text: 'rollback', params: [] })
        await a.execute({ text: 'drop table pgprime_tier2_q', params: [], mode: 'simple' })
      }
    },
  )
})

describe('tier 2 — version-gated SQL', () => {
  // `EXPLAIN (GENERIC_PLAN)` is 16+; below that the plan-ability check falls back to
  // PREPARE/DEALLOCATE (design/09 §2.2). This is also the self-test for `requiresVersion`.
  requiresVersion(16)('EXPLAIN (GENERIC_PLAN) plans a statement without binding it', async () => {
    // `mode: 'simple'` is not incidental: the whole point of GENERIC_PLAN is that `$1` is never
    // bound, and the extended protocol would try to bind it (`08P01`, `exec_bind_message`).
    const r = await a.execute({
      text: 'explain (generic_plan) select id from (values (1)) as t(id) where id = $1::int4',
      params: [],
      mode: 'simple',
    })
    expect(r.rows.flat().join('\n')).toMatch(/Values Scan|Result/)
  })
})

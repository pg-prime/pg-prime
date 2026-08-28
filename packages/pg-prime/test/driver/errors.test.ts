/**
 * design/02 §7 D12 — the classification table, as a table.
 *
 * The oracle here is pg's OWN source: every `message` below is a string literal copied out of
 * `pg/lib/client.js`, `pg/lib/query.js` or `pg-pool/index.js`, and every SQLSTATE is PostgreSQL's.
 * Nothing asserts on wording we invented. What the table pins is the ROUTING decision the runtime
 * layer makes from `kind` + `connectionUnusable`: retry it, discard the connection, or neither.
 *
 * The regexes this replaced got three of these wrong: `/timeout/i` matched the pool's
 * "timeout exceeded when trying to connect" (a dead acquire reported as a survivable query
 * deadline), `/unexpected/` matched "Connection terminated unexpectedly" (a dead socket reported
 * as a protocol desync), and a client-side "Prepared statements must be unique" — raised before
 * anything is written to the socket — poisoned a perfectly healthy connection.
 */

import { describe, expect, it } from 'vitest'
import { normaliseError } from '../../src/driver/index.js'
import type { PgErrorKind } from '../../src/driver/index.js'

interface Case {
  readonly what: string
  readonly error: unknown
  readonly kind: PgErrorKind
  readonly connectionUnusable: boolean
  readonly aborted?: boolean
}

const serverError = (sqlstate: string, message: string): unknown =>
  Object.assign(new Error(message), { code: sqlstate, severity: 'ERROR', message })

const CASES: readonly Case[] = [
  // ── pg's client-side rejections ───────────────────────────────────────────
  {
    what: "pg's query_timeout give-up (client.js)",
    error: new Error('Query read timeout'),
    kind: 'timeout',
    connectionUnusable: false,
  },
  {
    what: "pg-pool's ACQUISITION timeout — not a query deadline at all",
    error: new Error('timeout exceeded when trying to connect'),
    kind: 'connection',
    connectionUnusable: true,
  },
  {
    what: 'a prepared-statement name reused for different SQL (query.js) — nothing was sent',
    error: new Error(
      `Prepared statements must be unique - 'ps_1' was used for a different statement`,
    ),
    kind: 'adapter',
    connectionUnusable: false,
  },
  {
    what: 'non-array values (query.js) — nothing was sent',
    error: new Error('Query values must be an array'),
    kind: 'adapter',
    connectionUnusable: false,
  },
  {
    what: 'neither text nor name (query.js) — nothing was sent',
    error: new Error('A query must have either text or a name. Supplying neither is unsupported.'),
    kind: 'adapter',
    connectionUnusable: false,
  },
  {
    what: 'the socket died mid-query (client.js)',
    error: new Error('Connection terminated unexpectedly'),
    kind: 'connection',
    connectionUnusable: true,
  },
  {
    what: 'the client refuses further work (client.js)',
    error: new Error('Client has encountered a connection error and is not queryable'),
    kind: 'connection',
    connectionUnusable: true,
  },
  {
    what: 'a real protocol desync (client.js)',
    error: new Error('Received unexpected parseComplete message from backend.'),
    kind: 'protocol',
    connectionUnusable: true,
  },
  // ── server errors ─────────────────────────────────────────────────────────
  {
    what: '57014 from statement_timeout is RETRYABLE, not a user cancel',
    error: serverError('57014', 'canceling statement due to statement timeout'),
    kind: 'timeout',
    connectionUnusable: false,
  },
  {
    what: '57014 from lock_timeout is likewise not a user cancel',
    error: serverError('57014', 'canceling statement due to lock timeout'),
    kind: 'timeout',
    connectionUnusable: false,
  },
  {
    what: '57014 from a CancelRequest says so in the message',
    error: serverError('57014', 'canceling statement due to user request'),
    kind: 'cancelled',
    connectionUnusable: false,
  },
  {
    what: '57014 while OUR AbortSignal was firing',
    error: serverError('57014', 'canceling statement due to statement timeout'),
    aborted: true,
    kind: 'cancelled',
    connectionUnusable: false,
  },
  {
    what: 'an ordinary constraint violation leaves the connection usable',
    error: serverError('23505', 'duplicate key value violates unique constraint "t_pkey"'),
    kind: 'server',
    connectionUnusable: false,
  },
  {
    what: '08006 poisons the connection',
    error: serverError('08006', 'connection failure'),
    kind: 'server',
    connectionUnusable: true,
  },
  {
    what: '57P01 (admin shutdown) poisons the connection',
    error: serverError('57P01', 'terminating connection due to administrator command'),
    kind: 'server',
    connectionUnusable: true,
  },
]

describe('normaliseError — kind and connectionUnusable', () => {
  for (const c of CASES) {
    it(c.what, () => {
      const d = normaliseError(c.error, {
        adapter: 'pg',
        ...(c.aborted === undefined ? {} : { aborted: c.aborted }),
      })
      expect([d.kind, d.connectionUnusable]).toEqual([c.kind, c.connectionUnusable])
    })
  }

  it('the adapter can override connectionUnusable — only IT knows the socket survived', () => {
    // §5.4: pg gave up client-side, but the statement is still running on that socket.
    const d = normaliseError(new Error('Query read timeout'), {
      adapter: 'pg',
      connectionUnusable: true,
    })
    expect(d.kind).toBe('timeout')
    expect(d.connectionUnusable).toBe(true)
  })

  it('a failed cancel request is reported on the error it belongs to', () => {
    const d = normaliseError(new Error('Query read timeout'), {
      adapter: 'pg',
      cancelError: 'the pool is exhausted',
    })
    expect(d.cancelError).toBe('the pool is exhausted')
    // absent stays ABSENT (§7 trap 3)
    expect('cancelError' in normaliseError(new Error('x'), { adapter: 'pg' })).toBe(false)
  })

  it('an explicit abort beats every message-based rule', () => {
    const d = normaliseError(new Error('Connection terminated unexpectedly'), {
      adapter: 'pg',
      aborted: true,
    })
    expect(d.kind).toBe('cancelled')
  })
})

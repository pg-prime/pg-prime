/**
 * The session layer at tier 0 (design/07 §1, §3, §4, §5, §7; design/12 §3 S).
 *
 * Everything here is asserted against the **recording mock driver** or against a pure function,
 * because everything here is about what we *emit* and how we *classify* — not about what a server
 * does with it. The server's own answers are tier 1 and tier 2 (`test/live/session.test.ts`,
 * `test/pg/session*.test.ts`), which is R18: a claim about transactions is asserted on the
 * statement log AND on the row, in the same test, and the row needs a database.
 *
 * One file rather than eight, deliberately. `pnpm test` is at the 5 s ceiling design/12 §1
 * decision 11 refuses to raise, and the measured cost of a tier-0 file is dominated by transform
 * and import, not by cases: eight files of twenty cases cost several hundred milliseconds more
 * than one file of a hundred and sixty.
 */

import { describe, expect, it, vi } from 'vitest'
import { defaultRegistry } from '../../src/codec/index.js'
import {
  AbortError,
  CachedPlanChangedError,
  CheckViolationError,
  ConfigError,
  ConnectionError,
  DeadlockDetectedError,
  DiskFullError,
  DivisionByZeroError,
  DuplicateStatementError,
  DuplicateTableError,
  ExclusionViolationError,
  ForeignKeyViolationError,
  IndeterminateCommitError,
  InFailedTransactionError,
  InsufficientPrivilegeError,
  IntegrityConstraintError,
  InvalidDatetimeFormatError,
  InvalidPasswordError,
  InvalidStatementNameError,
  InvalidTextRepresentationError,
  LockNotAvailableError,
  NotNullViolationError,
  NumericValueOutOfRangeError,
  OperatorInterventionError,
  OutOfMemoryError,
  PgPrimeError,
  PoolTimeoutError,
  QueryCanceledError,
  QueryError,
  ReadOnlySqlTransactionError,
  RestrictViolationError,
  SQLSTATE_MAP,
  SchemaObjectError,
  SerializationFailureError,
  SqlSyntaxError,
  StringDataRightTruncationError,
  TooManyConnectionsError,
  UndefinedColumnError,
  UndefinedFunctionError,
  UndefinedTableError,
  TransactionAbandonedError,
  TransactionClosedError,
  TransactionRollback,
  UniqueViolationError,
  UnknownQueryError,
  UnsupportedInPoolerModeError,
  UsageError,
  classForSqlState,
  isForeignKeyViolation,
  isUniqueViolation,
  mapError,
  parseDetail,
  redactDetail,
  resolveErrorOptions,
} from '../../src/errors/index.js'
import { HookBus, SEMCONV, spanAttributes, spanName } from '../../src/observe/index.js'
import { POOLER_MODES, POOLER_PROFILES } from '../../src/pooler/index.js'
import { pgPrime } from '../../src/query/run.js'
import { defineSchema, pgTable } from '../../src/schema/index.js'
import { resolveSessionSettings } from '../../src/session/gucs.js'
import { resetGuardForTests } from '../../src/session/guard.js'
import {
  advisoryFn,
  advisoryKey,
  beginSql,
  releaseSavepointSql,
  resolveRetry,
  retryDelayMs,
  rollbackToSavepointSql,
  savepointSql,
  setConfigParams,
  setConfigSql,
} from '../../src/session/transaction.js'
import { mockDriver, serverError } from '../query/_mock-driver.js'
import type { MockDriver } from '../query/_mock-driver.js'
import { schema } from '../query/_schema.js'

function setup(opts: Record<string, unknown> = {}): { driver: MockDriver; db: ReturnType<typeof pgPrime<typeof schema>> } {
  const driver = mockDriver()
  const db = pgPrime({ driver, schema, registry: defaultRegistry(), ...opts })
  return { driver, db }
}

/** A server error as the seam delivers it, with the fields `07` §4.3 reads. */
function pgError(
  sqlstate: string,
  extra: Record<string, unknown> = {},
): Error & { pgPrime: { kind: string; server: Record<string, unknown> } } {
  const e = new Error(`${sqlstate}`) as Error & {
    pgPrime: { kind: string; server: Record<string, unknown>; connectionUnusable: boolean; adapter: string; message: string }
  }
  e.pgPrime = {
    kind: 'server',
    message: (extra['message'] as string) ?? `scripted ${sqlstate}`,
    connectionUnusable: false,
    adapter: 'mock',
    server: { severity: 'ERROR', sqlstate, message: (extra['message'] as string) ?? `scripted ${sqlstate}`, ...extra },
  }
  return e
}

/** A connection loss, which is what makes `commitWritten` mean `IndeterminateCommitError`. */
function connectionLost(message = 'Connection terminated unexpectedly'): Error {
  const e = new Error(message) as Error & { pgPrime: Record<string, unknown> }
  e.pgPrime = { kind: 'connection', message, connectionUnusable: true, adapter: 'mock' }
  return e
}

// ─────────────────────────────────────────────────────────────────────────────
// §3.1 — BEGIN, as ONE statement
// ─────────────────────────────────────────────────────────────────────────────

describe('BEGIN is one statement, never a separate SET TRANSACTION (07 §3.1)', () => {
  it.each([
    [{}, 'begin'],
    [{ isolation: 'read committed' as const }, 'begin isolation level read committed'],
    [{ isolation: 'repeatable read' as const }, 'begin isolation level repeatable read'],
    [{ isolation: 'serializable' as const }, 'begin isolation level serializable'],
    [{ accessMode: 'read only' as const }, 'begin read only'],
    [{ accessMode: 'read write' as const }, 'begin read write'],
    [
      { isolation: 'serializable' as const, accessMode: 'read only' as const },
      'begin isolation level serializable read only',
    ],
    [
      { isolation: 'serializable' as const, accessMode: 'read only' as const, deferrable: true },
      'begin isolation level serializable read only deferrable',
    ],
  ])('%o → %s', (opts, expected) => {
    expect(beginSql(opts)).toBe(expected)
  })

  it('refuses deferrable outside serializable + read only, because PG silently IGNORES it there', () => {
    expect(() => beginSql({ isolation: 'serializable', deferrable: true })).toThrow(ConfigError)
    expect(() => beginSql({ accessMode: 'read only', deferrable: true })).toThrow(/serializable/)
  })

  it("refuses 'read uncommitted', which PostgreSQL accepts and silently downgrades", () => {
    expect(() => beginSql({ isolation: 'read uncommitted' as never })).toThrow(/read uncommitted/)
  })

  it('emits exactly begin … commit around the callback, on ONE connection', async () => {
    const { driver, db } = setup()
    driver.rows.push([['1']])
    await db.transaction(async (tx) => {
      await tx.sql`select 1`.execute()
    }, { isolation: 'serializable', accessMode: 'read only', deferrable: true })
    expect(driver.texts()).toStrictEqual([
      'begin isolation level serializable read only deferrable',
      'select 1',
      'commit',
    ])
    expect(driver.acquired).toBe(1)
    expect(driver.released).toBe(1)
  })

  it('rolls back and rethrows on a throw, and the connection still goes back', async () => {
    const { driver, db } = setup()
    const boom = new Error('user code')
    await expect(db.transaction(async () => { throw boom })).rejects.toBe(boom)
    expect(driver.texts()).toStrictEqual(['begin', 'rollback'])
    expect(driver.released).toBe(1)
  })

  it('takes (opts, fn) as well as (fn, opts) — both overloads reach the same emission', async () => {
    const { driver, db } = setup()
    await db.transaction({ isolation: 'repeatable read' }, async () => undefined)
    expect(driver.texts()[0]).toBe('begin isolation level repeatable read')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §3.3 — savepoints
// ─────────────────────────────────────────────────────────────────────────────

describe('savepoint names are depth-derived, deterministic and always quoted (07 §3.3)', () => {
  it('the three statements a savepoint emits', () => {
    expect(savepointSql(1)).toBe('savepoint "pgprime_sp_1"')
    expect(releaseSavepointSql(1)).toBe('release savepoint "pgprime_sp_1"')
    expect(rollbackToSavepointSql(2)).toBe('rollback to savepoint "pgprime_sp_2"')
  })

  it('nests by depth, and `savepoint` is the same thing as the nested `transaction`', async () => {
    const { driver, db } = setup()
    await db.transaction(async (tx) => {
      expect(tx.depth).toBe(0)
      await tx.savepoint(async (a) => {
        expect(a.depth).toBe(1)
        await a.transaction(async (b) => {
          expect(b.depth).toBe(2)
        })
      })
    })
    expect(driver.texts()).toStrictEqual([
      'begin',
      'savepoint "pgprime_sp_1"',
      'savepoint "pgprime_sp_2"',
      'release savepoint "pgprime_sp_2"',
      'release savepoint "pgprime_sp_1"',
      'commit',
    ])
  })

  it('rolls back to the savepoint on a throw and RELEASES it, so the outer tx is usable', async () => {
    const { driver, db } = setup()
    await db.transaction(async (tx) => {
      await expect(
        tx.savepoint(async () => {
          throw new Error('speculative')
        }),
      ).rejects.toThrow('speculative')
      driver.rows.push([['1']])
      await tx.sql`select 1`.execute()
    })
    expect(driver.texts()).toStrictEqual([
      'begin',
      'savepoint "pgprime_sp_1"',
      'rollback to savepoint "pgprime_sp_1"',
      'release savepoint "pgprime_sp_1"',
      'select 1',
      'commit',
    ])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §3.5 — set_config, batched into one round trip
// ─────────────────────────────────────────────────────────────────────────────

describe('setLocal is set_config($1,$2,true), batched (07 §3.5)', () => {
  it('builds one statement for N settings', () => {
    expect(setConfigSql(1, true)).toBe('select set_config($1,$2,true)')
    expect(setConfigSql(3, true)).toBe(
      'select set_config($1,$2,true), set_config($3,$4,true), set_config($5,$6,true)',
    )
    expect(setConfigSql(1, false)).toBe('select set_config($1,$2,false)')
  })

  it('flattens name/value pairs and stringifies, so a number is a valid GUC value', () => {
    expect(setConfigParams({ 'app.tenant_id': 7, statement_timeout: '5s', on: true })).toStrictEqual([
      'app.tenant_id',
      '7',
      'statement_timeout',
      '5s',
      'on',
      'true',
    ])
  })

  it('validates the GUC NAME as a typo catcher — the value is a bind and needs nothing', () => {
    expect(() => setConfigParams({ 'app.tenant; drop table users': '1' })).toThrow(UsageError)
    expect(() => setConfigParams({ 'app.tenant_id': "'; drop table users --" })).not.toThrow()
  })

  it('localSettings and both timeouts go out in ONE round trip right after BEGIN', async () => {
    const { driver, db } = setup()
    await db.transaction(async () => undefined, {
      localSettings: { 'app.tenant_id': 't1' },
      timeoutMs: 5_000,
      lockTimeoutMs: 250,
    })
    expect(driver.texts()).toStrictEqual([
      'begin',
      'select set_config($1,$2,true), set_config($3,$4,true), set_config($5,$6,true)',
      'commit',
    ])
    expect(driver.log[1]?.params).toStrictEqual([
      'app.tenant_id',
      't1',
      'statement_timeout',
      '5000',
      'lock_timeout',
      '250',
    ])
  })

  it('tx.setLocal batches an object and takes a scalar pair', async () => {
    const { driver, db } = setup()
    await db.transaction(async (tx) => {
      await tx.setLocal('app.a', 1)
      await tx.setLocal({ 'app.b': 2, 'app.c': 3 })
    })
    expect(driver.texts().slice(1, 3)).toStrictEqual([
      'select set_config($1,$2,true)',
      'select set_config($1,$2,true), set_config($3,$4,true)',
    ])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §3.7 — advisory locks
// ─────────────────────────────────────────────────────────────────────────────

describe('advisory locks (07 §3.7, §5.2)', () => {
  it('names the pg_advisory_* function for every (scope, try, shared) triple', () => {
    expect(advisoryFn('xact', false, false)).toBe('pg_catalog.pg_advisory_xact_lock')
    expect(advisoryFn('xact', true, false)).toBe('pg_catalog.pg_try_advisory_xact_lock')
    expect(advisoryFn('xact', false, true)).toBe('pg_catalog.pg_advisory_xact_lock_shared')
    expect(advisoryFn('xact', true, true)).toBe('pg_catalog.pg_try_advisory_xact_lock_shared')
    expect(advisoryFn('session', false, false)).toBe('pg_catalog.pg_advisory_lock')
    expect(advisoryFn('session', true, true)).toBe('pg_catalog.pg_try_advisory_lock_shared')
  })

  it('hashes a string key deterministically into the signed 64-bit range', () => {
    const a = advisoryKey('migrate:orders')
    expect(a).toBe(advisoryKey('migrate:orders'))
    expect(a).not.toBe(advisoryKey('migrate:order'))
    expect(a).toBeGreaterThanOrEqual(-(2n ** 63n))
    expect(a).toBeLessThan(2n ** 63n)
    expect(advisoryKey(42n)).toBe(42n)
  })

  it('a Tx only ever takes the transaction-scoped family', async () => {
    const { driver, db } = setup()
    driver.rows.push([['t']])
    await db.transaction(async (tx) => {
      expect(await tx.advisoryLock(7n)).toBe(true)
    })
    expect(driver.texts()[1]).toBe('select pg_catalog.pg_advisory_xact_lock($1)')
    expect(driver.log[1]?.params).toStrictEqual(['7'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §3.7 — rollback ergonomics
// ─────────────────────────────────────────────────────────────────────────────

describe('rollback() and rollbackWith() (07 §3.7)', () => {
  it('rollback() throws TransactionRollback, which the runner rethrows after ROLLBACK', async () => {
    const { driver, db } = setup()
    await expect(db.transaction(async (tx) => tx.rollback())).rejects.toBeInstanceOf(TransactionRollback)
    expect(driver.texts()).toStrictEqual(['begin', 'rollback'])
  })

  it('rollbackWith(v) resolves with v, exactly typed, after a real ROLLBACK', async () => {
    const { driver, db } = setup()
    const out = await db.transaction(async (tx) => {
      if (Math.random() >= 0) return tx.rollbackWith({ status: 'conflict' } as const)
      return { status: 'reserved' } as const
    })
    expect(out).toStrictEqual({ status: 'conflict' })
    expect(driver.texts()).toStrictEqual(['begin', 'rollback'])
  })

  it('a statement after rollbackWith() throws TransactionAbandonedError', async () => {
    const { db } = setup()
    let caught: unknown
    await db.transaction(async (tx) => {
      const doomed = (): unknown => tx.rollbackWith(1)
      try {
        doomed()
      } catch {
        /* the sentinel; swallowed on purpose so the next statement is reached */
      }
      try {
        await tx.sql`select 1`.execute()
      } catch (e) {
        caught = e
      }
      return 0
    })
    expect(caught).toBeInstanceOf(TransactionAbandonedError)
  })

  it('a handle used after its callback returned throws TransactionClosedError', async () => {
    const { db } = setup()
    let escaped: { sql: (s: TemplateStringsArray) => { execute(): Promise<unknown> } } | undefined
    await db.transaction(async (tx) => {
      escaped = tx as never
    })
    await expect(escaped!.sql`select 1`.execute()).rejects.toBeInstanceOf(TransactionClosedError)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §3.4 — the retry policy and its schedule
// ─────────────────────────────────────────────────────────────────────────────

describe('retry defaults (07 §3.4)', () => {
  it('40001 is on by default at repeatable read and serializable, and OFF at read committed', () => {
    expect(resolveRetry(undefined, 'serializable').on).toStrictEqual(['40001'])
    expect(resolveRetry(undefined, 'repeatable read').on).toStrictEqual(['40001'])
    expect(resolveRetry(undefined, 'read committed').on).toStrictEqual([])
    expect(resolveRetry(undefined, undefined).on).toStrictEqual([])
  })

  it('40P01 is never on by default — a deadlock is a lock-ordering bug, not a transient', () => {
    for (const level of ['read committed', 'repeatable read', 'serializable'] as const) {
      expect(resolveRetry(undefined, level).on).not.toContain('40P01')
    }
    expect(resolveRetry({ on: ['40001', '40P01'] }, 'serializable').on).toContain('40P01')
  })

  it('retry: false disables it even at serializable; retry: true enables it at read committed', () => {
    expect(resolveRetry(false, 'serializable').maxAttempts).toBe(1)
    expect(resolveRetry(true, 'read committed').on).toStrictEqual(['40001'])
  })

  it('full jitter is sleep(random(0, min(maxDelay, base * 2**(attempt-1))))', () => {
    const p = resolveRetry({ baseDelayMs: 25, maxDelayMs: 1_000 }, 'serializable')
    const one = () => 1
    expect(retryDelayMs(p, 1, one)).toBe(25)
    expect(retryDelayMs(p, 2, one)).toBe(50)
    expect(retryDelayMs(p, 3, one)).toBe(100)
    expect(retryDelayMs(p, 4, one)).toBe(200)
    // The ceiling clamps, so the worst case across four retries is 25+50+100+200 = 375 ms.
    expect(retryDelayMs(p, 20, one)).toBe(1_000)
    // Full jitter really is uniform over [0, ceiling), not a fixed backoff.
    expect(retryDelayMs(p, 3, () => 0)).toBe(0)
    expect(retryDelayMs(p, 3, () => 0.5)).toBe(50)
  })

  it("jitter: 'none' and 'equal' are the two other shapes", () => {
    const none = resolveRetry({ jitter: 'none', baseDelayMs: 10 }, 'serializable')
    expect(retryDelayMs(none, 3, () => 0)).toBe(40)
    const equal = resolveRetry({ jitter: 'equal', baseDelayMs: 10 }, 'serializable')
    expect(retryDelayMs(equal, 3, () => 0)).toBe(20)
    expect(retryDelayMs(equal, 3, () => 1)).toBe(40)
  })
})

describe('the retry LOOP, on a fake clock (07 §3.4)', () => {
  it('re-runs the callback on 40001, increments tx.attempt, and emits a fresh BEGIN each time', async () => {
    vi.useFakeTimers()
    try {
      const { driver, db } = setup()
      const attempts: number[] = []
      let n = 0
      driver.failOn = (q) => (q.text === 'select 1' && n++ < 2 ? serverError('40001') : undefined)
      const p = db.transaction(
        async (tx) => {
          attempts.push(tx.attempt)
          await tx.sql`select 1`.execute()
          return tx.attempt
        },
        { isolation: 'serializable' },
      )
      await vi.runAllTimersAsync()
      expect(await p).toBe(3)
      expect(attempts).toStrictEqual([1, 2, 3])
      expect(driver.texts().filter((t) => t.startsWith('begin'))).toHaveLength(3)
      expect(driver.texts().filter((t) => t === 'rollback')).toHaveLength(2)
      expect(driver.texts().filter((t) => t === 'commit')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives up at maxAttempts and surfaces the last error', async () => {
    vi.useFakeTimers()
    try {
      const { driver, db } = setup()
      driver.failOn = (q) => (q.text === 'select 1' ? serverError('40001') : undefined)
      const p = db
        .transaction(async (tx) => tx.sql`select 1`.execute(), {
          isolation: 'serializable',
          retry: { maxAttempts: 3 },
        })
        .catch((e: unknown) => e)
      await vi.runAllTimersAsync()
      expect(await p).toBeInstanceOf(SerializationFailureError)
      expect(driver.texts().filter((t) => t.startsWith('begin'))).toHaveLength(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does NOT retry 40P01 by default, and DOES when asked', async () => {
    vi.useFakeTimers()
    try {
      const a = setup()
      a.driver.failOn = (q) => (q.text === 'select 1' ? serverError('40P01') : undefined)
      const pa = a.db
        .transaction(async (tx) => tx.sql`select 1`.execute(), { isolation: 'serializable' })
        .catch((e: unknown) => e)
      await vi.runAllTimersAsync()
      expect(await pa).toBeInstanceOf(DeadlockDetectedError)
      expect(a.driver.texts().filter((t) => t.startsWith('begin'))).toHaveLength(1)

      const b = setup()
      let n = 0
      b.driver.failOn = (q) => (q.text === 'select 1' && n++ < 1 ? serverError('40P01') : undefined)
      const pb = b.db.transaction(async (tx) => tx.sql`select 1`.execute(), {
        isolation: 'serializable',
        retry: { on: ['40001', '40P01'] },
      })
      await vi.runAllTimersAsync()
      await pb
      expect(b.driver.texts().filter((t) => t.startsWith('begin'))).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('the first retry logs at warn, and onRetry sees the attempt and the delay', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { driver, db } = setup()
      let n = 0
      driver.failOn = (q) => (q.text === 'select 1' && n++ < 1 ? serverError('40001') : undefined)
      const seen: number[] = []
      const p = db.transaction(async (tx) => tx.sql`select 1`.execute(), {
        isolation: 'serializable',
        label: 'reserve',
        retry: { onRetry: (i) => seen.push(i.attempt) },
      })
      await vi.runAllTimersAsync()
      await p
      expect(seen).toStrictEqual([1])
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0]?.[0]).toMatch(/retrying transaction "reserve".*40001.*idempotent/s)
    } finally {
      warn.mockRestore()
      vi.useRealTimers()
    }
  })

  it('never retries a non-PgPrimeError from the callback (hard exclusion 4)', async () => {
    const { driver, db } = setup()
    const boom = new TypeError('user bug')
    await expect(
      db.transaction(async () => { throw boom }, { isolation: 'serializable' }),
    ).rejects.toBe(boom)
    expect(driver.texts().filter((t) => t.startsWith('begin'))).toHaveLength(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §3.4 hard exclusion 1 — the transaction may have committed
// ─────────────────────────────────────────────────────────────────────────────

describe('IndeterminateCommitError (07 §3.4 exclusion 1, §4.2)', () => {
  it('a connection lost AFTER COMMIT was written is indeterminate, and is never retried', async () => {
    const { driver, db } = setup()
    driver.failOn = (q) => (q.text === 'commit' ? connectionLost() : undefined)
    const err = await db
      .transaction(async () => undefined, { isolation: 'serializable' })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(IndeterminateCommitError)
    expect(err).not.toBeInstanceOf(ConnectionError)
    expect((err as Error).message).toMatch(/MAY HAVE COMMITTED/)
    // One attempt. Retrying is how you double-charge a card.
    expect(driver.texts().filter((t) => t.startsWith('begin'))).toHaveLength(1)
  })

  it('a SERVER error at COMMIT is determinate — it did not commit — so 40001 there still retries', async () => {
    vi.useFakeTimers()
    try {
      const { driver, db } = setup()
      let n = 0
      driver.failOn = (q) => (q.text === 'commit' && n++ < 1 ? serverError('40001') : undefined)
      const p = db.transaction(async () => 'done', { isolation: 'serializable' })
      await vi.runAllTimersAsync()
      expect(await p).toBe('done')
      expect(driver.texts().filter((t) => t.startsWith('begin'))).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a connection lost BEFORE commit is an ordinary connection error, not indeterminate', async () => {
    const { driver, db } = setup()
    driver.failOn = (q) => (q.text === 'select 1' ? connectionLost() : undefined)
    const err = await db.transaction(async (tx) => tx.sql`select 1`.execute()).catch((e: unknown) => e)
    expect(err).not.toBeInstanceOf(IndeterminateCommitError)
    expect(err).toBeInstanceOf(ConnectionError)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §3.1 — the connection must not go back dirty
// ─────────────────────────────────────────────────────────────────────────────

describe("a connection whose transactionStatus is not 'I' is destroyed, not pooled (07 §3.1)", () => {
  it.each(['T', 'E'] as const)('status %s at release ⇒ dispose', async (status) => {
    const { driver, db } = setup()
    const disposed: boolean[] = []
    const release = driver.release.bind(driver)
    driver.release = async (conn, opts) => {
      disposed.push(opts?.dispose === true)
      return release(conn, opts)
    }
    driver.forceTxStatus = status
    await db.transaction(async () => undefined).catch(() => undefined)
    expect(disposed).toStrictEqual([true])
    driver.forceTxStatus = undefined
  })

  it("status 'I' goes back to the pool", async () => {
    const { driver, db } = setup()
    const disposed: boolean[] = []
    const release = driver.release.bind(driver)
    driver.release = async (conn, opts) => {
      disposed.push(opts?.dispose === true)
      return release(conn, opts)
    }
    await db.transaction(async () => undefined)
    expect(disposed).toStrictEqual([false])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §4 — the error hierarchy, as a table
// ─────────────────────────────────────────────────────────────────────────────

describe('every SQLSTATE in 07 §4.2 maps to its class (07 §4.5)', () => {
  const EXPECTED: readonly (readonly [string, new (...a: never[]) => PgPrimeError])[] = [
    ['23001', RestrictViolationError],
    ['23502', NotNullViolationError],
    ['23503', ForeignKeyViolationError],
    ['23505', UniqueViolationError],
    ['23514', CheckViolationError],
    ['23P01', ExclusionViolationError],
    ['40001', SerializationFailureError],
    ['40P01', DeadlockDetectedError],
    ['25P02', InFailedTransactionError],
    ['25006', ReadOnlySqlTransactionError],
    ['22003', NumericValueOutOfRangeError],
    ['22P02', InvalidTextRepresentationError],
    ['22001', StringDataRightTruncationError],
    ['22012', DivisionByZeroError],
    ['22007', InvalidDatetimeFormatError],
    ['42501', InsufficientPrivilegeError],
    ['28P01', InvalidPasswordError],
    ['28000', InvalidPasswordError],
    ['42P01', UndefinedTableError],
    ['42703', UndefinedColumnError],
    ['42883', UndefinedFunctionError],
    ['42P07', DuplicateTableError],
    ['42601', SqlSyntaxError],
    ['26000', InvalidStatementNameError],
    ['42P05', DuplicateStatementError],
    ['0A000', CachedPlanChangedError],
    ['55P03', LockNotAvailableError],
    ['57014', QueryCanceledError],
    ['53300', TooManyConnectionsError],
    ['53200', OutOfMemoryError],
    ['53100', DiskFullError],
    ['57P01', OperatorInterventionError],
  ]

  it.each(EXPECTED)('%s → the right class', (state, Ctor) => {
    expect(classForSqlState(state)).toBe(Ctor)
  })

  it('every entry of the exported table round-trips through the lookup', () => {
    for (const state of Object.keys(SQLSTATE_MAP)) {
      expect(classForSqlState(state)).toBe(SQLSTATE_MAP[state])
    }
    expect(Object.keys(SQLSTATE_MAP).length).toBeGreaterThanOrEqual(32)
  })

  it('an unmodelled SQLSTATE lands on its class ancestor and keeps the raw code', () => {
    // 23xxx we do not model → IntegrityConstraintError, not UnknownQueryError.
    const e = mapError(pgError('23999'), { context: { handle: 'db' }, errors: resolveErrorOptions(undefined, false) })
    expect(e).toBeInstanceOf(IntegrityConstraintError)
    expect((e as QueryError).code).toBe('23999')
    expect((e as QueryError).sqlStateClass).toBe('23')
  })

  it('an SQLSTATE in no modelled class at all is UnknownQueryError, still carrying the code', () => {
    const e = mapError(pgError('XX999'), { context: { handle: 'db' }, errors: resolveErrorOptions(undefined, false) })
    expect(e).toBeInstanceOf(UnknownQueryError)
    expect((e as QueryError).code).toBe('XX999')
  })

  it('PgPrimeError is the one ancestor — the builder errors and the runtime errors share it', () => {
    const e = mapError(pgError('23505'), { context: { handle: 'db' }, errors: resolveErrorOptions(undefined, false) })
    expect(e).toBeInstanceOf(PgPrimeError)
    expect(e).toBeInstanceOf(QueryError)
    expect((e as Error).name).toBe('UniqueViolationError')
  })

  it('a non-driver throw passes through untouched — a TypeError is not a database condition', () => {
    const boom = new TypeError('nope')
    expect(mapError(boom, { context: { handle: 'db' }, errors: resolveErrorOptions(undefined, false) })).toBe(boom)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §4.3 — redaction
// ─────────────────────────────────────────────────────────────────────────────

describe('redaction (07 §4.3)', () => {
  const dev = resolveErrorOptions(undefined, false)

  it("parses PG's DETAIL grammar rather than passing it through", () => {
    expect(parseDetail('Key (email)=(alice@example.com) already exists.')).toStrictEqual({
      columns: ['email'],
      values: ['alice@example.com'],
    })
    expect(parseDetail('Key (user_id)=(42) is not present in table "users".')).toStrictEqual({
      columns: ['user_id'],
      values: ['42'],
      referencedTable: 'users',
    })
    expect(parseDetail('Key (a, b)=(1, 2) already exists.')?.columns).toStrictEqual(['a', 'b'])
  })

  it('keeps the COLUMNS and drops the VALUES by default — the duplicate-signup leak', () => {
    const { detail, detailRedacted } = redactDetail(
      'Key (email)=(alice@example.com) already exists.',
      '23505',
      dev,
    )
    expect(detail).not.toContain('alice@example.com')
    expect(detail).toContain('email')
    expect(detailRedacted).toBe(true)
  })

  it('includeDetail: true is the one-line opt-in', () => {
    const opts = resolveErrorOptions({ includeDetail: true }, false)
    const { detail, detailRedacted } = redactDetail('Key (email)=(a@b.c) already exists.', '23505', opts)
    expect(detail).toBe('Key (email)=(a@b.c) already exists.')
    expect(detailRedacted).toBe(false)
  })

  it("keeps a DEADLOCK's detail verbatim — it names two processes and no user value", () => {
    const raw = 'Process 123 waits for ShareLock on transaction 456; blocked by process 789.'
    expect(redactDetail(raw, '40P01', dev)).toStrictEqual({ detail: raw, detailRedacted: false })
  })

  it('includes the SQL by default and never the params, but always paramCount and paramTypes', async () => {
    const { driver, db } = setup()
    driver.failOn = (q) => (q.text.startsWith('select') ? pgError('23505') : undefined)
    const err = (await db
      .from(schema.h.users)
      .select(({ users: u }) => ({ id: u.id }))
      .execute()
      .catch((e: unknown) => e)) as QueryError
    expect(err.sql).toContain('select')
    expect(err.params).toBeUndefined()
    expect(err.paramCount).toBe(0)
    expect(err.paramTypes).toStrictEqual([])
  })

  it('truncates the SQL at maxSqlLength with a marker', () => {
    const opts = resolveErrorOptions({ maxSqlLength: 10 }, false)
    const e = mapError(pgError('42601'), {
      context: { handle: 'db' },
      errors: opts,
      sql: 'select 1234567890',
    }) as QueryError
    expect(e.sql).toBe('select 123… [7 more characters elided]')
  })

  it('captureCallSite defaults to on outside production and off inside', () => {
    expect(resolveErrorOptions(undefined, false).captureCallSite).toBe(true)
    expect(resolveErrorOptions(undefined, true).captureCallSite).toBe(false)
    expect(resolveErrorOptions({ captureCallSite: true }, true).captureCallSite).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §4.4 — constraint names become schema objects
// ─────────────────────────────────────────────────────────────────────────────

describe('constraint → schema object (07 §4.4)', () => {
  const orgs = pgTable('orgs', (t) => ({ id: t.bigint().primaryKey() }))
  const accounts = pgTable('accounts', (t) => ({
    id: t.bigint().primaryKey(),
    email: t.text().unique(),
    orgId: t.bigint().references(() => orgs.cols.id),
  }))
  const s = defineSchema({ orgs, accounts })

  it('resolves a default-named unique constraint to the table and the column', () => {
    const e = mapError(pgError('23505', { constraint: 'accounts_email_key', table: 'accounts' }), {
      context: { handle: 'db' },
      errors: resolveErrorOptions(undefined, false),
      schema: s,
    }) as UniqueViolationError
    expect(e.table?.$.name).toBe('accounts')
    expect(e.columns?.map((c) => c.$.dbName)).toStrictEqual(['email'])
    expect(e.message).toBe('unique constraint violated: accounts(email) [accounts_email_key]')
  })

  it('isUniqueViolation(e, users.email) is refactor-proof matching, not a string compare', () => {
    const e = mapError(pgError('23505', { constraint: 'accounts_email_key', table: 'accounts' }), {
      context: { handle: 'db' },
      errors: resolveErrorOptions(undefined, false),
      schema: s,
    })
    expect(isUniqueViolation(e, accounts.cols.email)).toBe(true)
    expect(isUniqueViolation(e, accounts.cols.id)).toBe(false)
    expect(isForeignKeyViolation(e)).toBe(false)
  })

  it('a primary key and a foreign key resolve from their PostgreSQL default names', () => {
    const pk = mapError(pgError('23505', { constraint: 'accounts_pkey', table: 'accounts' }), {
      context: { handle: 'db' },
      errors: resolveErrorOptions(undefined, false),
      schema: s,
    }) as UniqueViolationError
    expect(pk.constraint?.kind).toBe('primaryKey')
    const fk = mapError(pgError('23503', { constraint: 'accounts_org_id_fkey', table: 'accounts' }), {
      context: { handle: 'db' },
      errors: resolveErrorOptions(undefined, false),
      schema: s,
    }) as ForeignKeyViolationError
    expect(fk.constraint?.kind).toBe('foreignKey')
    expect(fk.columns?.map((c) => c.$.dbName)).toStrictEqual(['org_id'])
  })

  it('degrades gracefully for a constraint the schema does not declare — never a guess', () => {
    const e = mapError(pgError('23505', { constraint: 'made_by_hand', message: 'duplicate key' }), {
      context: { handle: 'db' },
      errors: resolveErrorOptions(undefined, false),
      schema: s,
    }) as UniqueViolationError
    expect(e.constraint).toBeUndefined()
    expect(e.table).toBeUndefined()
    expect(e.message).toMatch(/not declared in your schema/)
    expect(e.constraintName).toBe('made_by_hand')
  })

  it('a NOT NULL violation reports no constraint name, so it resolves by (table, column)', () => {
    const e = mapError(pgError('23502', { table: 'accounts', column: 'email' }), {
      context: { handle: 'db' },
      errors: resolveErrorOptions(undefined, false),
      schema: s,
    }) as NotNullViolationError
    expect(e.constraint?.kind).toBe('notNull')
    expect(e.columns?.map((c) => c.$.dbName)).toStrictEqual(['email'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §3.3 — 25P02 carries the poisoning error
// ─────────────────────────────────────────────────────────────────────────────

describe('InFailedTransactionError carries what poisoned the transaction (07 §3.3)', () => {
  it('names the earlier error and points at savepoint()', async () => {
    const { driver, db } = setup()
    driver.failOn = (q) =>
      q.text === 'select 1' ? pgError('23505', { constraint: 'x' }) : q.text === 'select 2' ? pgError('25P02') : undefined
    const err = await db
      .transaction(async (tx) => {
        await tx.sql`select 1`.execute().catch(() => undefined)
        await tx.sql`select 2`.execute()
      })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(InFailedTransactionError)
    expect((err as InFailedTransactionError).poisonedBy).toBeInstanceOf(UniqueViolationError)
    expect((err as Error).message).toMatch(/tx\.savepoint/)
  })

  it('a savepoint rollback un-poisons it, so a later 25P02 does not blame a stale error', async () => {
    const { driver, db } = setup()
    driver.failOn = (q) => (q.text === 'select 1' ? pgError('23505') : undefined)
    await db.transaction(async (tx) => {
      await tx.savepoint(async (sp) => sp.sql`select 1`.execute()).catch(() => undefined)
      driver.failOn = (q) => (q.text === 'select 2' ? pgError('25P02') : undefined)
      const err = await tx.sql`select 2`.execute().catch((e: unknown) => e)
      expect((err as InFailedTransactionError).poisonedBy).toBeUndefined()
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §1.5 — the dev guard
// ─────────────────────────────────────────────────────────────────────────────

describe('the dev-mode misuse guard (07 §1.5 layer 3)', () => {
  it('the outer db inside a transaction throws HandleMisuseError naming both call sites', async () => {
    resetGuardForTests()
    const { db } = setup()
    const err = await db
      .transaction(async () => {
        await db.sql`select 1`.execute()
      })
      .catch((e: unknown) => e)
    expect((err as Error).name).toBe('HandleMisuseError')
    expect((err as Error).message).toMatch(/DIFFERENT connection/)
    expect((err as Error).message).toMatch(/outsideTransaction/)
  })

  it('outsideTransaction() is the explicit opt-out for a deliberate out-of-band statement', async () => {
    resetGuardForTests()
    const { driver, db } = setup()
    await db.transaction(async () => {
      driver.rows.push([['1']])
      await db.outsideTransaction().sql`select 1`.execute()
    })
    expect(driver.texts()).toContain('select 1')
  })

  it('devGuard: false turns it off entirely', async () => {
    resetGuardForTests()
    const { db } = setup({ devGuard: false })
    await expect(
      db.transaction(async () => {
        await db.sql`select 1`.execute()
      }),
    ).resolves.toBeUndefined()
  })

  it('a nested savepoint is not misuse — the frame belongs to the same connection', async () => {
    resetGuardForTests()
    const { db } = setup()
    await expect(
      db.transaction(async (tx) => {
        await tx.savepoint(async (sp) => sp.sql`select 1`.execute())
      }),
    ).resolves.toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §3.2 — the concurrency footgun, made loud
// ─────────────────────────────────────────────────────────────────────────────

describe('Promise.all inside a transaction is serial, and says so once (07 §3.2)', () => {
  it('warns once per transaction, and does not fail the query', async () => {
    resetGuardForTests()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { driver, db } = setup()
      driver.rows.push([['1']], [['2']], [['3']])
      await db.transaction(async (tx) => {
        await Promise.all([
          tx.sql`select 1`.execute(),
          tx.sql`select 2`.execute(),
          tx.sql`select 3`.execute(),
        ])
      })
      const hits = warn.mock.calls.filter((c) => String(c[0]).includes('execute SERIALLY'))
      expect(hits).toHaveLength(1)
    } finally {
      warn.mockRestore()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §5 — pooler profiles as data
// ─────────────────────────────────────────────────────────────────────────────

describe('POOLER_PROFILES is data, and a profile only ever restricts (07 §5.1)', () => {
  it('exports one profile per mode and never emits a reset query in any of them', () => {
    expect(Object.keys(POOLER_PROFILES).sort()).toStrictEqual([...POOLER_MODES].sort())
    for (const mode of POOLER_MODES) expect(POOLER_PROFILES[mode].resetQuery).toBe('never')
  })

  it("the matrix is ASYMMETRIC: LISTEN is unsupported under a tx pooler, NOTIFY is not gated", () => {
    expect(POOLER_PROFILES['pgbouncer-transaction'].listen).toBe('unsupported')
    expect(POOLER_PROFILES.transaction.listen).toBe('unsupported')
    expect(POOLER_PROFILES.none.listen).toBe('ok')
    expect(POOLER_PROFILES.session.listen).toBe('ok')
  })

  it('the two transaction profiles differ in exactly one capability: named statements', () => {
    const a = POOLER_PROFILES['pgbouncer-transaction']
    const b = POOLER_PROFILES.transaction
    const differ = (Object.keys(a) as (keyof typeof a)[]).filter((k) => a[k] !== b[k])
    expect(differ).toStrictEqual(['namedPreparedStatements'])
  })

  it("statement: 'named' throws ConfigError at CONSTRUCTION under poolerMode 'transaction'", () => {
    expect(() => setup({ poolerMode: 'transaction', statement: 'named' })).toThrow(ConfigError)
    expect(() => setup({ poolerMode: 'transaction', statement: 'named' })).toThrow(/Supavisor/)
    expect(() => setup({ poolerMode: 'pgbouncer-transaction', statement: 'named' })).not.toThrow()
  })

  it('db.session() is refused under a transaction profile, naming what to do instead', async () => {
    const { db } = setup({ poolerMode: 'pgbouncer-transaction' })
    const err = await db.session(async () => 1).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(UnsupportedInPoolerModeError)
    expect((err as Error).message).toMatch(/db\.transaction\(\)/)
  })

  it('session GUCs are skipped under a transaction profile, with the ALTER ROLE fix named', () => {
    const direct = resolveSessionSettings(undefined, POOLER_PROFILES.none)
    expect(direct.settings.map(([n]) => n)).toStrictEqual([
      'application_name',
      'statement_timeout',
      'idle_in_transaction_session_timeout',
      'TimeZone',
    ])
    expect(direct.skipped).toStrictEqual([])
    const pooled = resolveSessionSettings(undefined, POOLER_PROFILES.transaction)
    expect(pooled.settings).toStrictEqual([])
    expect(pooled.skipped).toContain('statement_timeout')
  })

  it("07 §3.6's defaults: 30s statement_timeout, 60s idle-in-transaction, UTC, no lock_timeout", () => {
    const { settings } = resolveSessionSettings(undefined, POOLER_PROFILES.none)
    expect(Object.fromEntries(settings)).toStrictEqual({
      application_name: 'pg-prime',
      statement_timeout: '30s',
      idle_in_transaction_session_timeout: '60s',
      TimeZone: 'UTC',
    })
  })

  it('null disables a default explicitly, which is different from omitting it', () => {
    const { settings } = resolveSessionSettings(
      { statementTimeout: null, lockTimeout: '2s', timeZone: null },
      POOLER_PROFILES.none,
    )
    const map = Object.fromEntries(settings)
    expect(map['statement_timeout']).toBeUndefined()
    expect(map['lock_timeout']).toBe('2s')
    expect(map['TimeZone']).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §1.1 — configuration
// ─────────────────────────────────────────────────────────────────────────────

describe('config validation is eager and names the key (07 §1.1)', () => {
  it('needs exactly one of connection | pool | driver', () => {
    expect(() => pgPrime({ schema } as never)).toThrow(ConfigError)
    expect(() => pgPrime({ schema, driver: mockDriver(), pool: {} } as never)).toThrow(/exactly ONE/)
  })

  it('pgPrime is synchronous and lazy — it opens no connection', () => {
    const driver = mockDriver()
    pgPrime({ driver, schema })
    expect(driver.acquired).toBe(0)
  })

  it('db.end() closes the handle and every later statement is a DbClosedError', async () => {
    const { db } = setup()
    await db.end()
    const err = await db.sql`select 1`.execute().catch((e: unknown) => e)
    expect((err as Error).name).toBe('DbClosedError')
  })

  it('await using — Symbol.asyncDispose is db.end()', async () => {
    const { driver, db } = setup()
    const destroyed = vi.fn()
    driver.destroy = async () => void destroyed()
    driver.rows.push([['1']])
    await db.sql`select 1`.execute()
    await (db as unknown as { [Symbol.asyncDispose](): Promise<void> })[Symbol.asyncDispose]()
    expect(destroyed).toHaveBeenCalled()
    const err = await db.sql`select 1`.execute().catch((e: unknown) => e)
    expect((err as Error).name).toBe('DbClosedError')
  })

  it('handles carry their kind, and every one of them can reach the schema', async () => {
    const { db } = setup()
    expect(db.kind).toBe('db')
    expect(db.schema).toBe(schema)
    await db.transaction(async (tx) => {
      expect(tx.kind).toBe('tx')
      expect(tx.schema).toBe(schema)
      expect(tx.isolation).toBe('read committed')
      expect(tx.accessMode).toBe('read write')
      expect(tx.status).toBe('active')
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §7.1 — hooks
// ─────────────────────────────────────────────────────────────────────────────

describe('QueryHooks (07 §7.1)', () => {
  it('start/end carry the ids, the operation and the tables, from the compiled query', async () => {
    const events: string[] = []
    const { driver, db } = setup({
      hooks: {
        onQueryStart: (e: { queryId: string; operation?: string; tables?: readonly string[] }) => {
          events.push(`start ${e.operation ?? '?'} ${(e.tables ?? []).join(',')}`)
        },
        onQueryEnd: (e: { rowCount: number; durationMs: number; decodeMs: number }) => {
          events.push(`end rows=${e.rowCount} timed=${e.durationMs >= 0 && e.decodeMs >= 0}`)
        },
      },
    })
    driver.rows.push([['7', 'a@b']])
    await db.from(schema.h.users).select(({ users: u }) => ({ id: u.id, email: u.email })).execute()
    expect(events).toStrictEqual(['start select users', 'end rows=1 timed=true'])
  })

  it('onQueryError sees the mapped class, and onTransactionEnd sees the outcome', async () => {
    const seen: string[] = []
    const { driver, db } = setup({
      hooks: {
        onQueryError: (e: { error: Error }) => seen.push(`err ${e.error.name}`),
        onTransactionStart: () => seen.push('tx start'),
        onTransactionEnd: (e: { outcome: string }) => seen.push(`tx ${e.outcome}`),
      },
    })
    driver.failOn = (q) => (q.text === 'select 1' ? pgError('23505') : undefined)
    await db.transaction(async (tx) => tx.sql`select 1`.execute()).catch(() => undefined)
    expect(seen).toStrictEqual(['tx start', 'err UniqueViolationError', 'tx error'])
  })

  it('a throwing hook is disabled once, reported through onInternal, and never breaks the query', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const internal: string[] = []
      const bus = new HookBus()
      let calls = 0
      bus.add({
        onQueryStart: () => {
          calls += 1
          throw new Error('bad hook')
        },
      })
      bus.add({ onInternal: (e) => internal.push(`${e.kind}:${String(e.hook)}`) })
      const event = {
        queryId: 'q1',
        sql: 'select 1',
        paramCount: 0,
        execMode: 'unnamed' as const,
        handle: 'db' as const,
        depth: 0,
        attempt: 1,
        startedAt: 0,
      }
      bus.queryStart(event)
      bus.queryStart(event)
      bus.queryStart(event)
      expect(calls).toBe(1)
      expect(internal).toStrictEqual(['hook-failed:onQueryStart'])
      expect(error).toHaveBeenCalledTimes(1)
    } finally {
      error.mockRestore()
    }
  })

  it('observe() composes and unsubscribes', async () => {
    const { driver, db } = setup()
    const a: number[] = []
    const b: number[] = []
    const offA = db.observe({ onQueryStart: () => a.push(1) })
    db.observe({ onQueryStart: () => b.push(1) })
    driver.rows.push([['1']], [['1']])
    await db.sql`select 1`.execute()
    offA()
    await db.sql`select 1`.execute()
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(2)
  })

  it('a db with no hooks does no event work at all — the flag is the hot path', () => {
    const bus = new HookBus()
    expect(bus.enabled).toBe(false)
    const off = bus.add({ onQueryStart: () => {} })
    expect(bus.enabled).toBe(true)
    off()
    expect(bus.enabled).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §7.2 — the OTel mapping, as pure functions
// ─────────────────────────────────────────────────────────────────────────────

describe('spanAttributes / spanName are pure and import nothing (07 §7.2)', () => {
  const start = {
    queryId: 'q1',
    sql: 'insert into "users" ("email") values ($1) returning "id"',
    paramCount: 1,
    execMode: 'unnamed' as const,
    handle: 'db' as const,
    depth: 0,
    attempt: 1,
    startedAt: 0,
    operation: 'insert' as const,
    tables: ['users'],
  }

  it('produces the semconv keys 07 §7.2 lists, for a failing insert', () => {
    const error = mapError(pgError('23505'), {
      context: { handle: 'db' },
      errors: resolveErrorOptions(undefined, false),
    }) as PgPrimeError
    const attrs = spanAttributes(
      { ...start, durationMs: 3, error, waitedForConnectionMs: 0 },
      { namespace: 'app_production', serverAddress: 'db.internal', serverPort: 5432 },
    )
    expect(attrs[SEMCONV.dbSystemName]).toBe('postgresql')
    expect(attrs[SEMCONV.dbNamespace]).toBe('app_production')
    expect(attrs[SEMCONV.dbOperationName]).toBe('INSERT')
    expect(attrs[SEMCONV.dbCollectionName]).toBe('users')
    expect(attrs[SEMCONV.dbQuerySummary]).toBe('INSERT users')
    expect(attrs[SEMCONV.dbResponseStatusCode]).toBe('23505')
    expect(attrs[SEMCONV.errorType]).toBe('UniqueViolationError')
    expect(attrs[SEMCONV.serverAddress]).toBe('db.internal')
    expect(attrs[SEMCONV.serverPort]).toBe(5432)
  })

  it('everything non-semconv is namespaced under pg_prime.*, so it cannot collide', () => {
    const attrs = spanAttributes({ ...start, durationMs: 1, rowCount: 2, command: 'INSERT', serverMs: 1, decodeMs: 0, waitedForConnectionMs: 0 })
    for (const key of Object.keys(attrs)) {
      const known = Object.values(SEMCONV) as string[]
      expect(known.includes(key) || key.startsWith('pg_prime.')).toBe(true)
    }
    expect(attrs['pg_prime.exec_mode']).toBe('unnamed')
    expect(attrs[SEMCONV.dbResponseReturnedRows]).toBe(2)
  })

  it('spanName is "<OPERATION> <collection>"', () => {
    expect(spanName(start)).toBe('INSERT users')
    expect(spanName({ ...start, tables: undefined })).toBe('INSERT')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §6.3 — streamBatches is one FETCH per batch
// ─────────────────────────────────────────────────────────────────────────────

describe('streamBatches (07 §6.3, design/12 decision 10)', () => {
  it('yields one array per FETCH, the last one shorter, and never an empty one', async () => {
    const { driver, db } = setup()
    driver.chunks.push([
      { rows: [['1', 'a'], ['2', 'b']] },
      { rows: [['3', 'c']] },
      { rows: [] },
    ])
    const sizes: number[] = []
    for await (const batch of db.streamBatches(
      db.from(schema.h.users).select(({ users: u }) => ({ id: u.id, email: u.email })),
      { batchSize: 2 },
    )) {
      sizes.push(batch.length)
    }
    expect(sizes).toStrictEqual([2, 1])
    expect(driver.texts().filter((t) => t.startsWith('fetch forward 2'))).toHaveLength(3)
    expect(driver.acquired).toBe(driver.released)
  })

  it('is transaction-scoped at the root and gives the connection back', async () => {
    const { driver, db } = setup()
    driver.chunks.push([{ rows: [['1', 'a']] }])
    for await (const _ of db.streamBatches(
      db.from(schema.h.users).select(({ users: u }) => ({ id: u.id, email: u.email })),
    )) {
      void _
    }
    const kinds = driver.texts().map((t) => t.split(' ')[0])
    expect(kinds).toStrictEqual(['begin', 'declare', 'fetch', 'close', 'commit'])
    expect(driver.acquired).toBe(1)
    expect(driver.released).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §6.1 / §6.2 — signals and timeouts
// ─────────────────────────────────────────────────────────────────────────────

describe('AbortSignal and per-statement timeouts (07 §6.1, §6.2)', () => {
  it('an already-aborted signal never reaches the wire', async () => {
    const { driver, db } = setup()
    const ac = new AbortController()
    ac.abort()
    driver.failOn = (q) => (q.signal?.aborted === true ? abortError() : undefined)
    const err = await db.run(db.from(schema.h.users).select(({ users: u }) => ({ id: u.id })), {
      signal: ac.signal,
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AbortError)
  })

  it("inside a transaction a timeout is SET LOCAL statement_timeout, and it is not re-emitted", async () => {
    const { driver, db } = setup()
    driver.rows.push([['1']], [['1']], [['1']])
    await db.transaction(async (tx) => {
      const timed = tx.withOptions({ timeoutMs: 1_000 })
      await timed.sql`select 1`.execute()
      await timed.sql`select 1`.execute()
      await tx.sql`select 1`.execute()
    })
    const texts = driver.texts()
    expect(texts.filter((t) => t.startsWith('select set_config'))).toHaveLength(2)
    expect(driver.log.filter((r) => r.text.startsWith('select set_config')).map((r) => r.params)).toStrictEqual([
      ['statement_timeout', '1000'],
      ['statement_timeout', '0'],
    ])
  })

  it("timeoutStrategy: 'transaction' wraps an autocommit statement, the +2 RTT opt-in", async () => {
    const { driver, db } = setup()
    driver.rows.push([['1']])
    await db.run(db.from(schema.h.users).select(({ users: u }) => ({ id: u.id })), {
      timeoutMs: 500,
      timeoutStrategy: 'transaction',
    })
    const kinds = driver.texts().map((t) => t.split(' ').slice(0, 2).join(' '))
    expect(kinds[0]).toBe('begin')
    expect(kinds[1]).toBe('select set_config($1,$2,true)')
    expect(driver.texts().at(-1)).toBe('commit')
  })
})

function abortError(): Error {
  const e = new Error('aborted') as Error & { pgPrime: Record<string, unknown> }
  e.pgPrime = { kind: 'cancelled', message: 'aborted', connectionUnusable: false, adapter: 'mock' }
  return e
}

// ─────────────────────────────────────────────────────────────────────────────
// §4.2 — the pool-timeout leaf carries stats
// ─────────────────────────────────────────────────────────────────────────────

describe('PoolTimeoutError carries pool stats (07 §1.2, §4.2)', () => {
  it("pg's 'timeout exceeded when trying to connect' becomes an alertable event", () => {
    const raw = new Error('timeout exceeded when trying to connect') as Error & { pgPrime: Record<string, unknown> }
    raw.pgPrime = {
      kind: 'connection',
      message: 'timeout exceeded when trying to connect',
      connectionUnusable: true,
      adapter: 'pg',
    }
    const e = mapError(raw, {
      context: { handle: 'db' },
      errors: resolveErrorOptions(undefined, false),
      poolStats: { total: 10, idle: 0, waiting: 4, max: 10 },
    }) as PoolTimeoutError
    expect(e).toBeInstanceOf(PoolTimeoutError)
    expect(e).toBeInstanceOf(ConnectionError)
    expect(e.stats).toStrictEqual({ total: 10, idle: 0, waiting: 4, max: 10 })
  })
})

/**
 * The statement text of a transaction, and the retry schedule — as pure functions (design/07 §3).
 *
 * Both are separated from `./handles.ts` on purpose: the SQL a `BEGIN` compiles to and the delay
 * a retry waits are exactly the two things a tier-0 test wants to assert without a database and
 * without a clock, and a function that returns a string is the cheapest possible oracle.
 */

import { ConfigError, UsageError } from '../errors/index.js'
import type { AccessMode, IsolationLevel, RetryPolicy, SavepointOptions, TxOptions } from './types.js'

// ─────────────────────────────────────────────────────────────────────────────
// §3.1 — BEGIN, as ONE statement
// ─────────────────────────────────────────────────────────────────────────────

const ISOLATION_SQL: Readonly<Record<IsolationLevel, string>> = Object.freeze({
  'read committed': 'read committed',
  'repeatable read': 'repeatable read',
  serializable: 'serializable',
})

/**
 * `BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY DEFERRABLE` — one statement, one round trip, no
 * separate `SET TRANSACTION`.
 *
 * `deferrable` is gated by the {@link TxOptions} union at the type level, so this function only
 * has to be right about the *text*; the runtime check below exists for the JavaScript caller.
 */
export function beginSql(opts: {
  readonly isolation?: IsolationLevel | undefined
  readonly accessMode?: AccessMode | undefined
  readonly deferrable?: boolean | undefined
}): string {
  let sql = 'begin'
  if (opts.isolation !== undefined) {
    const level = ISOLATION_SQL[opts.isolation]
    if (level === undefined) {
      throw new ConfigError(
        `pg-prime: isolation must be 'read committed', 'repeatable read' or 'serializable'; got ` +
          `${JSON.stringify(opts.isolation)}. 'read uncommitted' is deliberately absent — ` +
          `PostgreSQL accepts the keyword and silently gives you 'read committed' (07 §3.1).`,
      )
    }
    sql += ` isolation level ${level}`
  }
  if (opts.accessMode !== undefined) sql += ` ${opts.accessMode}`
  if (opts.deferrable === true) {
    if (opts.isolation !== 'serializable' || opts.accessMode !== 'read only') {
      throw new ConfigError(
        `pg-prime: deferrable is only meaningful with isolation: 'serializable' and accessMode: ` +
          `'read only'. PostgreSQL accepts and silently IGNORES it otherwise, which is worse than ` +
          `an error, so the TxOptions union forbids it at the type level too (07 §3.1).`,
      )
    }
    sql += ' deferrable'
  }
  return sql
}

// ─────────────────────────────────────────────────────────────────────────────
// §3.3 — savepoints
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `"pgprime_sp_1"` — depth-derived, deterministic, and **always identifier-quoted**.
 *
 * Depth-derived rather than random because nesting is lexical, the names appear in logs and in
 * `EXPLAIN` output, and determinism makes tests readable.
 */
export function savepointName(depth: number): string {
  return `"pgprime_sp_${depth}"`
}

export function savepointSql(depth: number): string {
  return `savepoint ${savepointName(depth)}`
}
export function releaseSavepointSql(depth: number): string {
  return `release savepoint ${savepointName(depth)}`
}
export function rollbackToSavepointSql(depth: number): string {
  return `rollback to savepoint ${savepointName(depth)}`
}

// ─────────────────────────────────────────────────────────────────────────────
// §3.5 — SET LOCAL, without an injection surface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `SET LOCAL` cannot take bind parameters. `set_config(name, value, true)` is the transaction-local
 * equivalent **and it is an ordinary function call, so it can**. That single fact is the whole
 * implementation, and it is what closes Prisma #5128 and makes RLS a one-line pattern.
 *
 * Several settings batch into ONE round trip:
 *
 * ```sql
 * select set_config($1,$2,true), set_config($3,$4,true), set_config($5,$6,true)
 * ```
 *
 * Deliberately not folded into the `BEGIN` via string concatenation: that would reintroduce the
 * injection surface for the sake of one round trip, and the values here are tenant ids — i.e.
 * precisely the security boundary.
 */
export function setConfigSql(count: number, local: boolean): string {
  const calls: string[] = []
  for (let i = 0; i < count; i++) calls.push(`set_config($${i * 2 + 1},$${i * 2 + 2},${local})`)
  return `select ${calls.join(', ')}`
}

/**
 * A defence-in-depth typo catcher, not the security boundary — `set_config` itself rejects garbage
 * safely, because the name is a bind parameter.
 */
const GUC_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)?$/

export function assertGucName(name: string): void {
  if (!GUC_NAME.test(name)) {
    throw new UsageError(
      `pg-prime: ${JSON.stringify(name)} is not a valid GUC name. Expected ` +
        `${String(GUC_NAME)} — e.g. 'statement_timeout' or 'app.tenant_id'. (The value is a bind ` +
        `parameter and needs no validation; this check is for the name, and it is a typo catcher.)`,
    )
  }
}

/** `{ 'app.tenant_id': t, statement_timeout: '5s' }` → the flat `$1..$2n` parameter list. */
export function setConfigParams(
  settings: Readonly<Record<string, string | number | boolean>>,
): readonly string[] {
  const out: string[] = []
  for (const name of Object.keys(settings)) {
    assertGucName(name)
    out.push(name, String(settings[name]))
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// §3.7 — advisory locks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A `bigint` key straight through; a `string` key hashed to one, deterministically.
 *
 * The hash is FNV-1a 64 over UTF-8, wrapped into the signed 64-bit range PostgreSQL's `bigint`
 * uses. Deterministic across processes and across restarts is the whole requirement — two
 * instances that hash `'migrate:orders'` differently would not exclude each other, which is the
 * one thing an advisory lock is for.
 */
export function advisoryKey(key: bigint | string | number): bigint {
  if (typeof key === 'bigint') return BigInt.asIntN(64, key)
  if (typeof key === 'number') return BigInt.asIntN(64, BigInt(Math.trunc(key)))
  let h = 0xcbf29ce484222325n
  const bytes = new TextEncoder().encode(key)
  for (const b of bytes) {
    h ^= BigInt(b)
    h = BigInt.asUintN(64, h * 0x100000001b3n)
  }
  return BigInt.asIntN(64, h)
}

/** The `pg_advisory_*` function for a (scope, try, shared) triple. `_xact_` is the pooler-safe one. */
export function advisoryFn(scope: 'xact' | 'session', tryLock: boolean, shared: boolean): string {
  const parts = ['pg_catalog.pg']
  if (tryLock) parts.push('try')
  parts.push('advisory')
  if (scope === 'xact') parts.push('xact')
  parts.push('lock')
  if (shared) parts.push('shared')
  return parts.join('_')
}

export function advisoryUnlockFn(shared: boolean): string {
  return shared ? 'pg_catalog.pg_advisory_unlock_shared' : 'pg_catalog.pg_advisory_unlock'
}

// ─────────────────────────────────────────────────────────────────────────────
// §3.4 — the retry schedule
// ─────────────────────────────────────────────────────────────────────────────

export interface ResolvedRetry {
  readonly on: readonly string[]
  readonly maxAttempts: number
  readonly baseDelayMs: number
  readonly maxDelayMs: number
  readonly jitter: 'full' | 'equal' | 'none'
  readonly shouldRetry: ((err: unknown, attempt: number) => boolean) | undefined
  readonly onRetry:
    | ((info: { err: unknown; attempt: number; delayMs: number; label?: string }) => void)
    | undefined
}

/**
 * **Retry is ON by default for `40001`, and only at repeatable read or serializable.** OFF by
 * default for `40P01` at every level.
 *
 * - Offering `isolation: 'serializable'` without retry is *"handing users a loaded gun"* —
 *   PostgreSQL's own documentation says applications using SERIALIZABLE **must** retry. Every ORM
 *   surveyed offers the level and none ships the retry.
 * - `40001` is impossible at read committed, so defaulting it on there would be pure ceremony: the
 *   default never fires for code that did not opt into an isolation level.
 * - `40P01` is almost always a lock-ordering bug in the application. Silent retry converts a loud,
 *   fixable, reproducible bug into an intermittent latency spike. Opt in with
 *   `retry: { on: ['40001', '40P01'] }` when you genuinely have an unavoidable one.
 */
export function resolveRetry(
  retry: RetryPolicy | boolean | undefined,
  isolation: IsolationLevel | undefined,
): ResolvedRetry {
  const retryable = isolation === 'repeatable read' || isolation === 'serializable'
  if (retry === false) return DISABLED
  const p: RetryPolicy = retry === true || retry === undefined ? {} : retry
  const on = p.on ?? (retryable || retry === true ? DEFAULT_ON : EMPTY)
  return {
    on,
    maxAttempts: p.maxAttempts ?? 5,
    baseDelayMs: p.baseDelayMs ?? 25,
    maxDelayMs: p.maxDelayMs ?? 1_000,
    jitter: p.jitter ?? 'full',
    shouldRetry: p.shouldRetry,
    onRetry: p.onRetry,
  }
}

const DEFAULT_ON: readonly string[] = Object.freeze(['40001'])
const EMPTY: readonly string[] = Object.freeze([])
const DISABLED: ResolvedRetry = Object.freeze({
  on: EMPTY,
  maxAttempts: 1,
  baseDelayMs: 0,
  maxDelayMs: 0,
  jitter: 'none' as const,
  shouldRetry: undefined,
  onRetry: undefined,
})

/**
 * Full jitter: `random(0, min(maxDelay, base * 2 ** (attempt - 1)))`.
 *
 * Full rather than plain exponential because serialization failures are *inherently correlated* —
 * the conflicting transactions failed at the same instant and would otherwise retry in lockstep,
 * reproducing the conflict. Worst case at the defaults is under ~1.4 s across four retries.
 *
 * `random` is a parameter so a tier-0 test can pin the schedule exactly rather than assert a range.
 */
export function retryDelayMs(p: ResolvedRetry, attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(p.maxDelayMs, p.baseDelayMs * 2 ** Math.max(0, attempt - 1))
  switch (p.jitter) {
    case 'none':
      return ceiling
    case 'equal':
      return ceiling / 2 + random() * (ceiling / 2)
    default:
      return random() * ceiling
  }
}

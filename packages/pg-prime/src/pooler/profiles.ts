/**
 * Pooler profiles, as data (design/07 §5.1, and decision 6 of design/12 §1).
 *
 * > **`poolerMode` is a declared environment profile, not a detected one: it selects a table of
 * > capability toggles that can only ever *restrict* what the runtime will emit, so a wrong value
 * > costs performance or produces a loud error — never silent incorrectness.**
 *
 * The table being *data* is load-bearing in three places: `diagnosePooler()` compares its verdict
 * against it, the docs page is generated from it so prose and behaviour cannot drift, and a test
 * can walk every mode instead of every branch. A profile only ever restricts; nothing anywhere
 * reads a profile to *enable* something.
 */

export type PoolerMode =
  /** Direct to PostgreSQL. The default. */
  | 'none'
  /** Session-mode pooler: PgBouncer session, Supabase `:5432`, pgpool-II. */
  | 'session'
  /**
   * A transaction pooler **with** protocol-level prepared statements: PgBouncer ≥ 1.24 (which
   * defaults `max_prepared_statements=200`), Neon `-pooler`, Hyperdrive, RDS Proxy, PgDog, pgcat.
   */
  | 'pgbouncer-transaction'
  /**
   * A transaction pooler **without** them: Supavisor `:6543`, PgBouncer with
   * `max_prepared_statements=0`. The conservative floor.
   */
  | 'transaction'

export interface PoolerProfile {
  readonly namedPreparedStatements: 'ok' | 'shared-lru' | 'unsupported'
  /** `'unsafe'` = a `SET` at connect leaks onto a server connection another client will get. */
  readonly sessionGucsAtConnect: 'ok' | 'unsafe'
  readonly listen: 'ok' | 'unsupported'
  readonly sessionAdvisoryLocks: 'ok' | 'unsupported'
  readonly withHoldCursors: 'ok' | 'unsupported'
  /** `db.session()`. This is the one handle a transaction pooler cannot support at all. */
  readonly sessionHandle: 'ok' | 'unsupported'
  readonly cancelRequest: 'ok' | 'best-effort'
  /** `'never'` in every profile, always. `DISCARD ALL` clears PgBouncer's tracking and pins RDS Proxy. */
  readonly resetQuery: 'never'
}

export const POOLER_PROFILES: Readonly<Record<PoolerMode, PoolerProfile>> = Object.freeze({
  none: Object.freeze({
    namedPreparedStatements: 'ok',
    sessionGucsAtConnect: 'ok',
    listen: 'ok',
    sessionAdvisoryLocks: 'ok',
    withHoldCursors: 'ok',
    sessionHandle: 'ok',
    cancelRequest: 'ok',
    resetQuery: 'never',
  }),
  session: Object.freeze({
    namedPreparedStatements: 'ok',
    sessionGucsAtConnect: 'ok',
    listen: 'ok',
    sessionAdvisoryLocks: 'ok',
    withHoldCursors: 'ok',
    sessionHandle: 'ok',
    cancelRequest: 'best-effort',
    resetQuery: 'never',
  }),
  'pgbouncer-transaction': Object.freeze({
    // Allowed, and warned: PgBouncer's per-server LRU is SHARED across clients, and DDL that
    // changes a result type needs `RECONNECT` on the admin console.
    namedPreparedStatements: 'shared-lru',
    sessionGucsAtConnect: 'unsafe',
    listen: 'unsupported',
    sessionAdvisoryLocks: 'unsupported',
    withHoldCursors: 'unsupported',
    sessionHandle: 'unsupported',
    cancelRequest: 'best-effort',
    resetQuery: 'never',
  }),
  transaction: Object.freeze({
    namedPreparedStatements: 'unsupported',
    sessionGucsAtConnect: 'unsafe',
    listen: 'unsupported',
    sessionAdvisoryLocks: 'unsupported',
    withHoldCursors: 'unsupported',
    sessionHandle: 'unsupported',
    cancelRequest: 'best-effort',
    resetQuery: 'never',
  }),
})

export const POOLER_MODES: readonly PoolerMode[] = Object.freeze([
  'none',
  'session',
  'pgbouncer-transaction',
  'transaction',
])

export function profileOf(mode: PoolerMode | undefined): PoolerProfile {
  return POOLER_PROFILES[mode ?? 'none']
}

/** True for the two modes where a server connection is reassigned between transactions. */
export function isTransactionPooled(mode: PoolerMode | undefined): boolean {
  return mode === 'transaction' || mode === 'pgbouncer-transaction'
}

/**
 * The operational fix we print when a profile makes us skip session GUCs (`07` §3.6).
 *
 * Server-side, pooler-proof, survives everything — and it is the *only* correct answer, which is
 * why we say it rather than papering over the gap.
 */
export function alterRoleHint(settings: readonly string[]): string {
  const example = settings[0] ?? 'statement_timeout'
  return (
    `Set them server-side instead: ALTER ROLE <your_user> SET ${example} = '…'. That survives the ` +
    `pooler, the reconnect and the failover; a SET at connect does not, and under transaction ` +
    `pooling it would leak onto another client's server connection (07 §3.6).`
  )
}

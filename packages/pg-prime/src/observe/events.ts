/**
 * `QueryHooks` and the events they carry (design/07 §7.1).
 *
 * Four rules from §7.1, and each of them is a decision rather than an omission:
 *
 *  - **Hooks are synchronous.** An `async` hook on the hot path is an unbounded-latency footgun
 *    and an ordering hazard. Users who need async work push onto their own queue.
 *  - **A throwing hook can never break a query.** `./bus.ts` wraps every invocation; a failure is
 *    reported once through `onInternal` and then that specific hook is disabled for the process.
 *  - **`paramCount`, not `params`**, unless `errors.includeParams` is on — the §4.3 policy applied
 *    to telemetry, which is where it matters most.
 *  - **No `EventEmitter`.** Stringly-typed events, worse inference, and `once`/`off` bookkeeping.
 *    A typed hook object plus `db.observe()` composes better and costs nothing.
 */

import type { PgNoticeData } from '../driver/types.js'
import type { HandleKind, PgPrimeError } from '../errors/index.js'
import type { StatementMode } from '../query/executor.js'

export type QueryOperation = 'select' | 'insert' | 'update' | 'delete' | 'ddl' | 'other'

export interface QueryStartEvent {
  /** Correlates start/end/error and spans. Monotonic per process, prefixed so it reads as ours. */
  readonly queryId: string
  readonly sql: string
  readonly paramCount: number
  /**
   * `07` §7.1 spells this `execMode`. As built the executor reaches two of `07` §2.1's four modes
   * and calls the axis `statement` (`'unnamed' | 'named'`), which is what this carries; the span
   * attribute is still `pg_prime.exec_mode`.
   */
  readonly execMode: StatementMode
  readonly handle: HandleKind
  readonly txId?: string | undefined
  readonly depth: number
  readonly attempt: number
  readonly label?: string | undefined
  /** `performance.now()` at dispatch. */
  readonly startedAt: number
  /** From the compiled query's `meta`, never a regex over the SQL. */
  readonly operation?: QueryOperation | undefined
  readonly tables?: readonly string[] | undefined
  /** Only when `errors.includeParams` is on. */
  readonly params?: readonly unknown[] | undefined
}

export interface QueryEndEvent extends QueryStartEvent {
  readonly durationMs: number
  readonly rowCount: number
  readonly command: string
  /**
   * Split three ways so you can see driver time versus our decode time versus pool wait.
   *
   * `waitedForConnectionMs` is separated deliberately: "slow query" and "pool exhausted" look
   * identical in every ORM's logs today and have completely different fixes.
   */
  readonly serverMs: number
  readonly decodeMs: number
  readonly waitedForConnectionMs: number
}

export interface QueryErrorEvent extends QueryStartEvent {
  readonly durationMs: number
  readonly error: PgPrimeError
  readonly waitedForConnectionMs: number
}

export interface TxStartEvent {
  readonly txId: string
  readonly depth: number
  readonly attempt: number
  readonly isolation: string | undefined
  readonly accessMode: string | undefined
  readonly label?: string | undefined
  readonly startedAt: number
}

export interface TxEndEvent extends TxStartEvent {
  readonly outcome: 'commit' | 'rollback' | 'error'
  readonly durationMs: number
  readonly error?: PgPrimeError | undefined
}

export interface RetryEvent {
  readonly err: PgPrimeError
  readonly attempt: number
  readonly delayMs: number
  readonly label?: string | undefined
  readonly txId: string
}

export interface PoolEvent {
  readonly kind: 'acquire' | 'release' | 'create' | 'destroy' | 'timeout'
  readonly waitedMs?: number | undefined
}

export interface NoticeEvent {
  readonly notice: PgNoticeData
  readonly queryId: string
}

/**
 * Everything the runtime decided on its own: an exec-mode downgrade, a description-cache flush, a
 * self-heal, a hook that threw and was disabled, a session GUC a pooler profile skipped, an idle
 * pooled connection the server killed under us.
 */
export interface InternalEvent {
  readonly kind:
    | 'downgrade'
    | 'cache-flush'
    | 'self-heal'
    | 'hook-failed'
    | 'pooler-mismatch'
    | 'session-guc-skipped'
    | 'listen-reconnect'
    | 'concurrent-statements'
    | 'idle-connection-error'
  readonly message: string
  readonly cause?: unknown
  readonly hook?: keyof QueryHooks | undefined
}

export interface QueryHooks {
  onQueryStart?(e: QueryStartEvent): void
  onQueryEnd?(e: QueryEndEvent): void
  onQueryError?(e: QueryErrorEvent): void
  onTransactionStart?(e: TxStartEvent): void
  onTransactionEnd?(e: TxEndEvent): void
  onRetry?(e: RetryEvent): void
  onPool?(e: PoolEvent): void
  /** PG `NoticeResponse` — `RAISE NOTICE` from your own functions. */
  onNotice?(e: NoticeEvent): void
  onInternal?(e: InternalEvent): void
}

/** Monotonic, cheap, and readable in a log next to a SQLSTATE. Not a UUID: nothing joins on it. */
let seq = 0
export function nextQueryId(): string {
  seq = (seq + 1) % 0xffffffff
  return `q${seq.toString(36)}`
}

let txSeq = 0
export function nextTxId(): string {
  txSeq = (txSeq + 1) % 0xffffffff
  return `t${txSeq.toString(36)}`
}
